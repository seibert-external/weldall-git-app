import { z } from "zod";
import { LOGIN_SCOPE, repositoryPartSchema, weldallSubjectSchema } from "../app-host.js";
import { authorizePerson } from "../access.js";
import { auditApp, auditList } from "../audit.js";
import { GitAppError } from "../errors.js";
import { safeHttpsUrl } from "../git-text.js";
import {
  ADMIN_PAGE_SIZE,
  APP_ID_PATTERN,
  InvalidCursorError,
  MACHINE_PAGE_SIZE,
  type RegistryApp,
} from "../registry/registry.js";
import { APP_REGISTRY_POLICY, APP_STATES } from "../registry/state.js";
import { weldallCode, weldallFailure } from "../weldall.js";
import type { GitAppServices, Person } from "./context.js";

/**
 * The app registry's API (INV-183) for its three audiences: the owner (own apps and their
 * confirmation, `publish` scope), administrators (every app, and registering an existing
 * repository, `admin` scope) and the customer's own tools (every app, read-only, machine clients
 * with the `registry-read` scope).
 */

/** What every audience sees of one app. Dates are ISO 8601 in UTC; links are https or null. */
export interface AppRegistryEntry {
  id: string;
  name: string;
  purpose: string;
  /** The repository on this Git app's host, with its browser link. */
  repository: { owner: string; name: string; webUrl: string | null };
  /** Template the app started from; null for a registered existing repository. */
  template: string | null;
  links: { preview: string | null; live: string | null };
  createdAt: string;
  /** Null until the owner confirmed the app for the first time. */
  confirmedAt: string | null;
  expiresAt: string;
  state: RegistryApp["state"];
}

/**
 * Administrators and tools also see the owner (Weldall user id, and the email address of the
 * owner's last token; null for an app an administrator registered until its owner used this Git
 * app), who registered the entry and who confirmed it last.
 */
export interface AppRegistryEntryWithOwner extends AppRegistryEntry {
  owner: { id: string; email: string | null };
  registeredBy: string;
  confirmedBy: string | null;
}

export function registryEntry(app: RegistryApp): AppRegistryEntry {
  return {
    id: app.id,
    name: app.name,
    purpose: app.purpose,
    repository: {
      owner: app.repository.owner,
      name: app.repository.name,
      webUrl: safeHttpsUrl(app.repository.webUrl),
    },
    template: app.template?.name ?? null,
    links: { preview: safeHttpsUrl(app.links.preview), live: safeHttpsUrl(app.links.live) },
    createdAt: app.createdAt,
    confirmedAt: app.confirmedAt,
    expiresAt: app.expiresAt,
    state: app.state,
  };
}

export function registryEntryWithOwner(app: RegistryApp): AppRegistryEntryWithOwner {
  return {
    ...registryEntry(app),
    owner: app.owner,
    registeredBy: app.registeredBy,
    confirmedBy: app.confirmedBy,
  };
}

/** `GET /api/apps`: the person's own apps, expired and expiring ones first. */
export async function listOwnApps({
  services,
  person,
  resource,
}: {
  services: GitAppServices;
  person: Person;
  resource: string;
}) {
  await authorizePerson(services.weldall, person.id, [services.scopes.publish]);
  const apps = await services.registry.listOwn(person);
  return { resource, apps: apps.map(registryEntry), ...APP_REGISTRY_POLICY };
}

/**
 * `POST /api/apps/{id}/confirm`: the owner confirms that the app is still needed; the expiry
 * moves to 90 days from now. An unknown id and another person's app get the same 404. The change
 * and its audit entry (`app_confirmation.succeeded`) commit together: when Weldall does not store
 * the entry, nothing changes (503). Refusals are audited as `app_confirmation.denied`.
 */
export async function confirmOwnApp({
  services,
  person,
  appId,
}: {
  services: GitAppServices;
  person: Person;
  appId: string;
}): Promise<{ app: AppRegistryEntry }> {
  try {
    await authorizePerson(services.weldall, person.id, [services.scopes.publish]);
    const confirmed = await services.registry.confirm({
      id: appId,
      owner: person,
      audit: ({ before, after }) =>
        services.audit.success({
          eventType: "app_confirmation.succeeded",
          subject: person.id,
          ...auditApp(after),
          details: {
            previousExpiresAt: before.expiresAt,
            expiresAt: after.expiresAt,
            previousState: before.state,
          },
        }),
    });
    if (!confirmed) throw new GitAppError("not_found", "No app of yours has this id.", 404);
    return { app: registryEntry(confirmed) };
  } catch (error) {
    if (error instanceof GitAppError && (error.code === "not_found" || error.status === 403))
      // Another person's app is never linked; the requested id is named only when well-formed.
      await services.audit.rejection({
        eventType: "app_confirmation.denied",
        ...(error.code === "access_denied" ? { reasonCode: "scope_not_granted" as const } : {}),
        reason: `${error.message}${APP_ID_PATTERN.test(appId) ? ` (requested: ${appId})` : ""}`,
        subject: person.id,
        appId: null,
        repository: null,
        details: {},
      });
    throw error;
  }
}

const single = (parameters: URLSearchParams) =>
  new Set(parameters.keys()).size === [...parameters.keys()].length;

const adminQuery = z
  .object({
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    pageSize: z.coerce
      .number()
      .int()
      .min(1)
      .max(ADMIN_PAGE_SIZE.maximum)
      .default(ADMIN_PAGE_SIZE.default),
    q: z.string().trim().min(1).max(200).optional(),
    state: z.enum(APP_STATES).optional(),
  })
  .strict();

/**
 * `GET /api/admin/apps`: every app, expired and expiring ones first. Query: `page`, `pageSize`
 * (1-200, default 50), `q` (searches name, purpose, repository, owner id and email) and `state`.
 */
export async function listAllApps({
  services,
  person,
  parameters,
  resource,
}: {
  services: GitAppServices;
  person: Person;
  parameters: URLSearchParams;
  resource: string;
}) {
  const query = adminQuery.safeParse(Object.fromEntries(parameters));
  if (!query.success || !single(parameters))
    throw new GitAppError(
      "invalid_request",
      "Use page, pageSize (1-200), q and state (active, expiring_soon or expired), each at most once.",
    );
  await authorizePerson(services.weldall, person.id, [services.scopes.admin]);
  const { page, pageSize, q, state } = query.data;
  const { apps, total } = await services.registry.listAll({
    page,
    pageSize,
    ...(q ? { q } : {}),
    ...(state ? { state } : {}),
  });
  return {
    resource,
    apps: apps.map(registryEntryWithOwner),
    total,
    page,
    pageSize,
    ...APP_REGISTRY_POLICY,
  };
}

const machineQuery = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MACHINE_PAGE_SIZE.maximum)
      .default(MACHINE_PAGE_SIZE.default),
    cursor: z.string().min(1).max(500).optional(),
    state: z.enum(APP_STATES).optional(),
  })
  .strict();

/**
 * `GET /api/registry/apps`: the whole registry for the customer's own tools, in creation order
 * with a cursor. Query: `limit` (1-200, default 100), `cursor` (the previous page's
 * `nextCursor`) and `state`.
 */
export async function listRegistryPage({
  services,
  parameters,
  resource,
}: {
  services: GitAppServices;
  parameters: URLSearchParams;
  resource: string;
}) {
  const query = machineQuery.safeParse(Object.fromEntries(parameters));
  if (!query.success || !single(parameters))
    throw new GitAppError(
      "invalid_request",
      "Use limit (1-200), cursor and state (active, expiring_soon or expired), each at most once.",
    );
  const { limit, cursor, state } = query.data;
  try {
    const page = await services.registry.listPage({
      limit,
      ...(cursor ? { cursor } : {}),
      ...(state ? { state } : {}),
    });
    return {
      resource,
      apps: page.apps.map(registryEntryWithOwner),
      nextCursor: page.nextCursor,
      generatedAt: page.generatedAt,
      ...APP_REGISTRY_POLICY,
    };
  } catch (error) {
    if (error instanceof InvalidCursorError)
      throw new GitAppError("invalid_request", "cursor is not one this Git app issued");
    throw error;
  }
}

const text = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .regex(/^[^\u0000-\u001f\u007f]*$/);
export const registerExistingBody = z
  .object({
    /** The owner's Weldall user id. */
    owner: weldallSubjectSchema,
    /** Repository name in this Git app's organisation. */
    repository: repositoryPartSchema,
    name: text(100),
    purpose: text(300),
  })
  .strict();

/** Codes that reject the administrator's request rather than report a failure. */
const deniedCodes = new Set([
  "access_denied",
  "invalid_request",
  "app_exists",
  "owner_not_allowed",
  "repository_is_template",
  "repository_unavailable",
  "repository_not_private",
  "reviewer_team_access_missing",
  "reviewer_team_unverifiable",
]);

/**
 * `POST /api/admin/apps`: an administrator registers an existing repository of the organisation
 * (one created on the host, for example from a template, without this Git app) as an app of a
 * person, so it is in the registry and can be published to. The owner must exist in Weldall and
 * hold the login permission and the publish scope. The repository must be private, not a
 * template, and pass the same prerequisites as a new one; it is ready at once. The entry and its
 * audit entry (`git_repository.registered`, the administrator as subject) commit together.
 * Repeating the call for the same owner and repository returns the entry unchanged.
 */
export async function registerExistingApp({
  services,
  person,
  input,
  signal,
}: {
  services: GitAppServices;
  person: Person;
  input: z.output<typeof registerExistingBody>;
  signal: AbortSignal;
}) {
  const requested = { owner: services.host.organization, name: input.repository };
  let app: RegistryApp | null = null;
  try {
    await authorizePerson(services.weldall, person.id, [services.scopes.admin]);
    await authorizeOwner(services, input.owner);
    const existing = await services.registry.byRepository(requested);
    if (existing && existing.owner.id !== input.owner)
      throw new GitAppError(
        "app_exists",
        `${requested.owner}/${requested.name} is already registered for another person.`,
        409,
      );
    if (existing) return { created: false, app: registryEntryWithOwner(existing), warnings: [] };
    const repository = await services.host.host.inspectExistingRepository(
      { name: input.repository },
      signal,
    );
    const registered = await services.registry.register(
      {
        owner: { id: input.owner, email: null },
        registeredBy: person.id,
        name: input.name,
        purpose: input.purpose,
        repository: {
          owner: repository.repository.owner,
          name: repository.repository.name,
          id: repository.repository.id,
          webUrl: repository.webUrl,
        },
        defaultBranch: repository.defaultBranch,
        template: null,
      },
      {
        audit: (entry) =>
          services.audit.success({
            eventType: "git_repository.registered",
            subject: person.id,
            ...auditApp(entry),
            details: {
              owner: input.owner,
              repositoryId: repository.repository.id,
              defaultBranch: repository.defaultBranch,
              warnings: auditList(
                repository.warnings.map(({ code }) => code),
                "warnings",
              ),
            },
          }),
      },
    );
    app = registered.app;
    return {
      created: registered.created,
      app: registryEntryWithOwner(registered.app),
      warnings: registered.created ? repository.warnings : [],
    };
  } catch (error) {
    const known = error instanceof GitAppError;
    if (!(known && error.code === "audit_unavailable"))
      await services.audit.rejection({
        eventType:
          known && deniedCodes.has(error.code) ? "git_repository.denied" : "git_repository.failed",
        ...(known && error.code === "access_denied"
          ? { reasonCode: "scope_not_granted" as const }
          : {}),
        reason: known ? error.message : "Registering the repository failed unexpectedly.",
        subject: person.id,
        ...(app ? auditApp(app) : { appId: null, repository: requested }),
        details: { template: null },
      });
    throw error;
  }
}

/** The owner of a registered app must be a Weldall user who may sign in and publish. */
async function authorizeOwner(services: GitAppServices, owner: string) {
  const requested = [LOGIN_SCOPE, services.scopes.publish];
  let answer;
  try {
    answer = await services.weldall.checkSubjectScopes(owner, requested);
  } catch (error) {
    const code = weldallCode(error);
    if (code === "not_found" || code === "unknown_subject")
      throw new GitAppError("owner_not_allowed", "Weldall does not know the owner.", 409);
    throw weldallFailure(error, "check the owner's permissions");
  }
  const missing = requested.filter(
    (scope) => answer.missing.includes(scope) || !answer.granted.includes(scope),
  );
  if (missing.length)
    throw new GitAppError(
      "owner_not_allowed",
      `The owner lacks ${missing.join(", ")}; assign it in Weldall first.`,
      409,
    );
}
