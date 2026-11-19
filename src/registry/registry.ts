import { randomBytes } from "node:crypto";
import type postgres from "postgres";
import { GitAppError } from "../errors.js";
import type { Database } from "./database.js";
import { appState, reverificationExpiry, stateBounds, type AppState } from "./state.js";

/**
 * The app registry (INV-183): every app this Git app keeps a repository for, its owner, purpose,
 * links and re-verification. It lives in the Git app's own database; Weldall only receives the
 * audit events. The state is derived from the expiry on every read; nothing here stops or blocks
 * an expired app.
 */

/** An app id: letters, digits, `_` and `-`, at most 64 characters. */
export const APP_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** One registry entry as the services use it. Dates are ISO 8601 in UTC. */
export interface RegistryApp {
  id: string;
  name: string;
  purpose: string;
  /** Weldall user id and, once known from the owner's own token, the email address. */
  owner: { id: string; email: string | null };
  repository: { owner: string; name: string; id: string | null; webUrl: string | null };
  /** Branch nobody pushes to directly; changes reach it only through reviewed pull requests. */
  defaultBranch: string;
  /** Null for a registered existing repository. */
  template: { name: string; commit: string | null } | null;
  /** False while a template app has no template commit yet; git traffic is refused until then. */
  ready: boolean;
  links: { preview: string | null; live: string | null };
  /** Weldall user id of whoever registered the entry: the owner, or an administrator. */
  registeredBy: string;
  createdAt: string;
  /** Null until the owner confirmed the app for the first time. */
  confirmedAt: string | null;
  confirmedBy: string | null;
  expiresAt: string;
  state: AppState;
}

export interface NewApp {
  owner: { id: string; email: string | null };
  registeredBy: string;
  name: string;
  purpose: string;
  repository: { owner: string; name: string; id: string | null; webUrl: string | null };
  defaultBranch: string;
  /** `commit` stays null until creation finished; see {@link RegistryApp.ready}. */
  template: { name: string; commit: string | null } | null;
}

interface Row {
  id: string;
  name: string;
  purpose: string;
  owner_subject: string;
  owner_email: string | null;
  repository_owner: string;
  repository_name: string;
  repository_id: string | null;
  repository_web_url: string | null;
  default_branch: string;
  template: string | null;
  template_commit: string | null;
  preview_url: string | null;
  live_url: string | null;
  registered_by: string;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
  confirmed_at: Date | null;
  confirmed_by: string | null;
}

/** A failed database call; the person gets 503 and nothing that depended on it happened. */
export function registryUnavailable(cause?: unknown): GitAppError {
  const error = new GitAppError(
    "registry_unavailable",
    "The Git app's app registry could not be reached. Nothing was changed by this step; retry later.",
    503,
  );
  if (cause !== undefined) (error as { cause?: unknown }).cause = cause;
  return error;
}

const appExists = (message: string) => new GitAppError("app_exists", message, 409);
const isUniqueViolation = (error: unknown) =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";

/** Thrown for a cursor the registry did not issue. */
export class InvalidCursorError extends Error {}

const encodeCursor = (row: { createdAt: string; id: string }) =>
  Buffer.from(JSON.stringify([row.createdAt, row.id])).toString("base64url");
function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === "string" &&
      typeof value[1] === "string" &&
      APP_ID_PATTERN.test(value[1])
    ) {
      const createdAt = new Date(value[0]);
      if (!Number.isNaN(createdAt.getTime()) && createdAt.toISOString() === value[0])
        return { createdAt, id: value[1] };
    }
  } catch {
    /* Reported below. */
  }
  throw new InvalidCursorError("Invalid cursor.");
}

/** A LIKE pattern matching `text` literally anywhere. */
const containing = (text: string) => `%${text.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;

export const MACHINE_PAGE_SIZE = { default: 100, maximum: 200 } as const;
export const ADMIN_PAGE_SIZE = { default: 50, maximum: 200 } as const;

export function createAppRegistry({
  sql,
  now = () => new Date(),
}: {
  sql: Database;
  /** The clock (tests). Timestamps are written from here, in milliseconds. */
  now?: () => Date;
}) {
  const present = (row: Row, at: Date): RegistryApp => ({
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    owner: { id: row.owner_subject, email: row.owner_email },
    repository: {
      owner: row.repository_owner,
      name: row.repository_name,
      id: row.repository_id,
      webUrl: row.repository_web_url,
    },
    defaultBranch: row.default_branch,
    template: row.template === null ? null : { name: row.template, commit: row.template_commit },
    ready: row.template === null || row.template_commit !== null,
    links: { preview: row.preview_url, live: row.live_url },
    registeredBy: row.registered_by,
    createdAt: row.created_at.toISOString(),
    confirmedAt: row.confirmed_at?.toISOString() ?? null,
    confirmedBy: row.confirmed_by,
    expiresAt: row.expires_at.toISOString(),
    state: appState(row.expires_at, at),
  });

  /** Runs a database step; any failure that is not already ours becomes `registry_unavailable`. */
  async function guarded<T>(step: () => Promise<T>): Promise<T> {
    try {
      return await step();
    } catch (error) {
      if (error instanceof GitAppError) throw error;
      throw registryUnavailable(error);
    }
  }

  async function rowById(client: postgres.Sql | postgres.TransactionSql, id: string, lock = false) {
    if (!APP_ID_PATTERN.test(id)) return null;
    const [row] = lock
      ? await client<Row[]>`SELECT * FROM apps WHERE id = ${id} FOR UPDATE`
      : await client<Row[]>`SELECT * FROM apps WHERE id = ${id}`;
    return row ?? null;
  }
  async function rowByRepository(
    client: postgres.Sql | postgres.TransactionSql,
    repository: { owner: string; name: string },
  ) {
    // Lower-cased equality, never ILIKE, so `_` and `%` stay literal.
    const [row] = await client<Row[]>`
      SELECT * FROM apps
      WHERE lower(repository_owner) = lower(${repository.owner})
        AND lower(repository_name) = lower(${repository.name})`;
    return row ?? null;
  }

  /** The existing entry for the same owner and repository (exact spelling), or `app_exists`. */
  function sameOrConflict(row: Row, input: NewApp, at: Date): RegistryApp {
    if (
      row.owner_subject === input.owner.id &&
      row.repository_owner === input.repository.owner &&
      row.repository_name === input.repository.name
    )
      return present(row, at);
    throw appExists("Another app is registered for this repository.");
  }

  return {
    /** One app by id; null for an unknown or malformed id. */
    byId: (id: string) =>
      guarded(async () => {
        const row = await rowById(sql, id);
        return row ? present(row, now()) : null;
      }),

    /** The app of a repository; owner and name match case-insensitively, as Git hosts treat them. */
    byRepository: (repository: { owner: string; name: string }) =>
      guarded(async () => {
        const row = await rowByRepository(sql, repository);
        return row ? present(row, now()) : null;
      }),

    /**
     * Registers an app; the expiry is {@link APP_REVERIFICATION_DAYS} days from now. Repeating it for
     * the same owner and repository returns the existing entry unchanged (`created: false`); another
     * owner's entry, a case variant or a taken repository id is `409 app_exists`. With `audit`, the
     * entry and the audit report commit together: when `audit` throws, nothing is registered.
     */
    register: (
      input: NewApp,
      options: { audit?: (app: RegistryApp) => Promise<void> } = {},
    ): Promise<{ created: boolean; app: RegistryApp }> =>
      guarded(async () => {
        const at = now();
        const existing = await rowByRepository(sql, input.repository);
        if (existing) return { created: false, app: sameOrConflict(existing, input, at) };
        try {
          return await sql.begin(async (tx) => {
            const [row] = await tx<Row[]>`
              INSERT INTO apps (
                id, name, purpose, owner_subject, owner_email, repository_owner, repository_name,
                repository_id, repository_web_url, default_branch, template, template_commit,
                registered_by, created_at, updated_at, expires_at
              ) VALUES (
                ${`app_${randomBytes(10).toString("hex")}`}, ${input.name}, ${input.purpose},
                ${input.owner.id}, ${input.owner.email}, ${input.repository.owner},
                ${input.repository.name}, ${input.repository.id}, ${input.repository.webUrl},
                ${input.defaultBranch}, ${input.template?.name ?? null},
                ${input.template?.commit ?? null}, ${input.registeredBy}, ${at}, ${at},
                ${reverificationExpiry(at)}
              )
              RETURNING *`;
            const app = present(row!, at);
            await options.audit?.(app);
            return { created: true, app };
          });
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          // A concurrent identical call won the race, or the repository id is taken.
          const raced = await rowByRepository(sql, input.repository);
          if (raced) return { created: false, app: sameOrConflict(raced, input, at) };
          throw appExists("Another app is registered for this repository id.");
        }
      }),

    /** Sets the template commit once, which makes a template app ready. */
    markReady: (id: string, templateCommit: string) =>
      guarded(async () => {
        const at = now();
        const [row] = await sql<Row[]>`
          UPDATE apps SET template_commit = ${templateCommit}, updated_at = ${at}
          WHERE id = ${id} AND template IS NOT NULL
            AND (template_commit IS NULL OR template_commit = ${templateCommit})
          RETURNING *`;
        if (row) return present(row, at);
        const current = await rowById(sql, id);
        if (!current) throw new GitAppError("not_found", "No app has this id.", 404);
        throw new GitAppError(
          "template_commit_mismatch",
          "The app's template commit is already set and cannot change.",
          409,
        );
      }),

    /** Stores links the host reported; omitted links stay. */
    updateLinks: (id: string, links: { preview?: string; live?: string }) =>
      guarded(async () => {
        const at = now();
        const [row] = await sql<Row[]>`
          UPDATE apps SET
            preview_url = coalesce(${links.preview ?? null}, preview_url),
            live_url = coalesce(${links.live ?? null}, live_url),
            updated_at = ${at}
          WHERE id = ${id}
          RETURNING *`;
        if (!row) throw new GitAppError("not_found", "No app has this id.", 404);
        return present(row, at);
      }),

    /**
     * The apps one person owns, expired and expiring ones first (ascending expiry is exactly that
     * order). Records the email address of the person's current token on their entries.
     */
    listOwn: (owner: { id: string; email: string | null }) =>
      guarded(async () => {
        const at = now();
        if (owner.email !== null)
          await sql`
            UPDATE apps SET owner_email = ${owner.email}
            WHERE owner_subject = ${owner.id} AND owner_email IS DISTINCT FROM ${owner.email}`;
        const rows = await sql<Row[]>`
          SELECT * FROM apps WHERE owner_subject = ${owner.id} ORDER BY expires_at, id`;
        return rows.map((row) => present(row, at));
      }),

    /**
     * The owner confirms that the app is still needed: the expiry moves to now plus
     * {@link APP_REVERIFICATION_DAYS}, and when and by whom is recorded. Only the owner may
     * confirm; an unknown id and another person's app both give null. The change and the audit
     * report commit together: when `audit` throws, nothing changes.
     */
    confirm: (input: {
      id: string;
      owner: { id: string; email: string | null };
      audit: (change: { before: RegistryApp; after: RegistryApp }) => Promise<void>;
    }): Promise<RegistryApp | null> =>
      guarded(() =>
        sql.begin(async (tx) => {
          const row = await rowById(tx, input.id, true);
          if (!row || row.owner_subject !== input.owner.id) return null;
          const at = now();
          const [updated] = await tx<Row[]>`
            UPDATE apps SET
              expires_at = ${reverificationExpiry(at)},
              confirmed_at = ${at},
              confirmed_by = ${input.owner.id},
              owner_email = coalesce(${input.owner.email}, owner_email),
              updated_at = ${at}
            WHERE id = ${row.id}
            RETURNING *`;
          const change = { before: present(row, at), after: present(updated!, at) };
          await input.audit(change);
          return change.after;
        }),
      ),

    /**
     * Every app for administrators, expired and expiring ones first. `q` searches name, purpose,
     * repository, owner id and email address, case-insensitively.
     */
    listAll: (input: { page: number; pageSize: number; q?: string; state?: AppState }) =>
      guarded(async () => {
        const at = now();
        const bounds = input.state ? stateBounds(input.state, at) : { after: null, until: null };
        const q = input.q?.trim();
        const pattern = q ? containing(q) : null;
        const where = sql`
          WHERE (${bounds.after}::timestamptz IS NULL OR expires_at > ${bounds.after})
            AND (${bounds.until}::timestamptz IS NULL OR expires_at <= ${bounds.until})
            AND (${pattern}::text IS NULL OR name ILIKE ${pattern} OR purpose ILIKE ${pattern}
              OR repository_name ILIKE ${pattern} OR owner_subject ILIKE ${pattern}
              OR owner_email ILIKE ${pattern})`;
        const [rows, [count]] = await Promise.all([
          sql<Row[]>`
            SELECT * FROM apps ${where}
            ORDER BY expires_at, id
            LIMIT ${input.pageSize} OFFSET ${(input.page - 1) * input.pageSize}`,
          sql<{ total: number }[]>`SELECT count(*)::int AS total FROM apps ${where}`,
        ]);
        return { apps: rows.map((row) => present(row, at)), total: count?.total ?? 0 };
      }),

    /**
     * One page of the whole registry in creation order (oldest first, then id), so new apps are
     * appended and a client can page through without missing or repeating entries. `nextCursor` is
     * null on the last page. Throws {@link InvalidCursorError} for a cursor it did not issue.
     */
    listPage: async (input: { limit: number; cursor?: string; state?: AppState }) => {
      const after = input.cursor === undefined ? null : decodeCursor(input.cursor);
      return guarded(async () => {
        const at = now();
        const bounds = input.state ? stateBounds(input.state, at) : { after: null, until: null };
        const rows = await sql<Row[]>`
          SELECT * FROM apps
          WHERE (${bounds.after}::timestamptz IS NULL OR expires_at > ${bounds.after})
            AND (${bounds.until}::timestamptz IS NULL OR expires_at <= ${bounds.until})
            AND (${after?.createdAt ?? null}::timestamptz IS NULL
              OR (created_at, id) > (${after?.createdAt ?? null}::timestamptz, ${after?.id ?? ""}))
          ORDER BY created_at, id
          LIMIT ${input.limit + 1}`;
        const page = rows.slice(0, input.limit).map((row) => present(row, at));
        return {
          apps: page,
          nextCursor: rows.length > input.limit ? encodeCursor(page.at(-1)!) : null,
          generatedAt: at.toISOString(),
        };
      });
    },
  };
}
export type AppRegistry = ReturnType<typeof createAppRegistry>;
