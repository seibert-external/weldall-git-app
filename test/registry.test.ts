import { afterEach, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  DatabaseTooNewError,
  migrateDatabase,
  openDatabase,
  type Database,
} from "../src/registry/database.js";
import { MIGRATIONS } from "../src/registry/migrations.js";
import {
  createAppRegistry,
  InvalidCursorError,
  type AppRegistry,
  type NewApp,
} from "../src/registry/registry.js";
import {
  appState,
  APP_EXPIRING_SOON_DAYS,
  APP_REVERIFICATION_DAYS,
} from "../src/registry/state.js";
import { createTestDatabase, testDatabaseUrl } from "./fixtures/database.js";

const DAY = 86_400_000;
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let clock: Date;
let registry: AppRegistry;

beforeEach(async () => {
  database = await createTestDatabase();
  clock = new Date("2026-11-19T10:00:00.000Z");
  registry = createAppRegistry({ sql: database.sql, now: () => clock });
});
afterEach(() => database.close());

const newApp = (overrides: Partial<NewApp> = {}): NewApp => ({
  owner: { id: "alice", email: "alice@example.com" },
  registeredBy: "alice",
  name: "expenses",
  purpose: "Tracks team expenses",
  repository: {
    owner: "acme-apps",
    name: "app-expenses",
    id: "4242",
    webUrl: "https://github.com/acme-apps/app-expenses",
  },
  defaultBranch: "main",
  template: { name: "react", commit: null },
  ...overrides,
});

describe("migrations", () => {
  it("are idempotent and recorded", async () => {
    expect(await migrateDatabase(database.sql)).toEqual([]);
    const rows = await database.sql`SELECT version, name FROM schema_migrations ORDER BY version`;
    expect(rows.map(({ version, name }) => ({ version, name }))).toEqual(
      MIGRATIONS.map(({ version, name }) => ({ version, name })),
    );
  });

  it("refuse a database migrated by a newer Git app", async () => {
    await database.sql`INSERT INTO schema_migrations (version, name) VALUES (999, 'future')`;
    await expect(migrateDatabase(database.sql)).rejects.toBeInstanceOf(DatabaseTooNewError);
  });

  it("serialise concurrent starts", async () => {
    const schema = `${database.schema}_parallel`;
    const admin = postgres(testDatabaseUrl(), { max: 1, onnotice: () => {} });
    await admin`CREATE SCHEMA ${admin(schema)}`;
    const pools: Database[] = [0, 1, 2].map(() =>
      openDatabase(testDatabaseUrl(), { schema, max: 1 }),
    );
    try {
      const applied = await Promise.all(pools.map((sql) => migrateDatabase(sql)));
      expect(applied.flat()).toEqual(MIGRATIONS.map(({ version }) => version));
    } finally {
      await Promise.all(pools.map((sql) => sql.end()));
      await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
      await admin.end();
    }
  });
});

describe("register", () => {
  it("registers a not-ready template app that expires after 90 days", async () => {
    const { created, app } = await registry.register(newApp());
    expect(created).toBe(true);
    expect(app).toMatchObject({
      id: expect.stringMatching(/^app_[0-9a-f]{20}$/),
      owner: { id: "alice", email: "alice@example.com" },
      ready: false,
      template: { name: "react", commit: null },
      createdAt: clock.toISOString(),
      confirmedAt: null,
      expiresAt: new Date(clock.getTime() + APP_REVERIFICATION_DAYS * DAY).toISOString(),
      state: "active",
    });
    const ready = await registry.markReady(app.id, "c".repeat(40));
    expect(ready).toMatchObject({ ready: true, template: { commit: "c".repeat(40) } });
    await expect(registry.markReady(app.id, "d".repeat(40))).rejects.toMatchObject({
      code: "template_commit_mismatch",
    });
  });

  it("returns the same owner's entry again and refuses another owner and case variants", async () => {
    const first = await registry.register(newApp());
    expect(await registry.register(newApp())).toEqual({ created: false, app: first.app });
    await expect(
      registry.register(newApp({ owner: { id: "bob", email: null }, registeredBy: "bob" })),
    ).rejects.toMatchObject({ code: "app_exists", status: 409 });
    await expect(
      registry.register(
        newApp({ repository: { ...newApp().repository, name: "App-Expenses", id: null } }),
      ),
    ).rejects.toMatchObject({ code: "app_exists" });
    await expect(
      registry.register(newApp({ repository: { ...newApp().repository, name: "app-other" } })),
    ).rejects.toMatchObject({ code: "app_exists" });
  });

  it("registers concurrent identical calls once", async () => {
    const results = await Promise.all([1, 2, 3].map(() => registry.register(newApp())));
    expect(results.filter(({ created }) => created)).toHaveLength(1);
    expect(new Set(results.map(({ app }) => app.id)).size).toBe(1);
  });

  it("keeps nothing when the audit inside the registration fails", async () => {
    await expect(
      registry.register(newApp({ template: null }), {
        audit: async () => {
          throw new Error("audit down");
        },
      }),
    ).rejects.toMatchObject({ code: "registry_unavailable" });
    expect(await registry.byRepository({ owner: "acme-apps", name: "app-expenses" })).toBeNull();
    const { app } = await registry.register(newApp({ template: null }), { audit: async () => {} });
    expect(app.ready).toBe(true);
  });

  it("finds apps by id and repository case-insensitively, never by pattern", async () => {
    const { app } = await registry.register(newApp());
    expect(await registry.byId(app.id)).toEqual(app);
    expect(await registry.byId("no such id!")).toBeNull();
    expect(await registry.byRepository({ owner: "ACME-apps", name: "APP-expenses" })).toEqual(app);
    expect(await registry.byRepository({ owner: "acme-apps", name: "app_expenses" })).toBeNull();
    expect(await registry.byRepository({ owner: "acme-apps", name: "app%" })).toBeNull();
  });

  it("stores reported links and keeps omitted ones", async () => {
    const { app } = await registry.register(newApp());
    await registry.updateLinks(app.id, { preview: "https://preview.example.com/" });
    const updated = await registry.updateLinks(app.id, { live: "https://app.example.com/" });
    expect(updated.links).toEqual({
      preview: "https://preview.example.com/",
      live: "https://app.example.com/",
    });
  });
});

describe("re-verification", () => {
  it("derives the state from the expiry", () => {
    const expiry = new Date("2027-01-01T00:00:00.000Z");
    const before = (days: number) => new Date(expiry.getTime() - days * DAY);
    expect(appState(expiry, before(APP_EXPIRING_SOON_DAYS + 1))).toBe("active");
    expect(appState(expiry, before(APP_EXPIRING_SOON_DAYS))).toBe("expiring_soon");
    expect(appState(expiry, expiry)).toBe("expired");
  });

  it("lets only the owner confirm, moves the expiry and records who, with the audit inside", async () => {
    const { app } = await registry.register(newApp());
    clock = new Date(clock.getTime() + 100 * DAY);
    expect((await registry.byId(app.id))?.state).toBe("expired");
    const audits: unknown[] = [];
    expect(
      await registry.confirm({
        id: app.id,
        owner: { id: "bob", email: null },
        audit: async (change) => void audits.push(change),
      }),
    ).toBeNull();
    await expect(
      registry.confirm({
        id: app.id,
        owner: { id: "alice", email: "alice@example.com" },
        audit: async () => {
          throw new Error("audit down");
        },
      }),
    ).rejects.toMatchObject({ code: "registry_unavailable" });
    expect((await registry.byId(app.id))?.confirmedAt).toBeNull();
    const confirmed = await registry.confirm({
      id: app.id,
      owner: { id: "alice", email: "alice@example.com" },
      audit: async (change) => void audits.push(change),
    });
    expect(confirmed).toMatchObject({
      confirmedAt: clock.toISOString(),
      confirmedBy: "alice",
      expiresAt: new Date(clock.getTime() + APP_REVERIFICATION_DAYS * DAY).toISOString(),
      state: "active",
    });
    expect(audits).toEqual([
      { before: expect.objectContaining({ state: "expired" }), after: confirmed },
    ]);
  });

  it("never moves the expiry when an app is updated", async () => {
    const { app } = await registry.register(newApp());
    clock = new Date(clock.getTime() + 10 * DAY);
    await registry.markReady(app.id, "c".repeat(40));
    const updated = await registry.updateLinks(app.id, { live: "https://app.example.com/" });
    expect(updated.expiresAt).toBe(app.expiresAt);
  });
});

describe("lists", () => {
  async function seed() {
    const ids: string[] = [];
    for (const [index, owner] of ["alice", "bob", "alice"].entries()) {
      clock = new Date(Date.UTC(2026, 10, 1 + index * 40));
      const { app } = await registry.register(
        newApp({
          owner: { id: owner, email: `${owner}@example.com` },
          registeredBy: owner,
          name: `app${index}`,
          purpose: index === 1 ? "Holiday 100% planner" : "Tracks expenses",
          repository: { owner: "acme-apps", name: `app-${index}`, id: null, webUrl: null },
        }),
      );
      ids.push(app.id);
    }
    clock = new Date(Date.UTC(2027, 1, 28));
    return ids;
  }

  it("lists a person's own apps, expired first, and records the token's email", async () => {
    const ids = await seed();
    await database.sql`UPDATE apps SET owner_email = NULL WHERE id = ${ids[0]!}`;
    const own = await registry.listOwn({ id: "alice", email: "alice@example.org" });
    expect(own.map(({ id }) => id)).toEqual([ids[0], ids[2]]);
    expect(own.map(({ state }) => state)).toEqual(["expired", "active"]);
    expect(own.every(({ owner }) => owner.email === "alice@example.org")).toBe(true);
  });

  it("lists everything for administrators with state filter, search and pages", async () => {
    const ids = await seed();
    const all = await registry.listAll({ page: 1, pageSize: 2 });
    expect(all).toMatchObject({ total: 3 });
    expect(all.apps.map(({ id }) => id)).toEqual([ids[0], ids[1]]);
    expect((await registry.listAll({ page: 2, pageSize: 2 })).apps.map(({ id }) => id)).toEqual([
      ids[2],
    ]);
    const expired = await registry.listAll({ page: 1, pageSize: 50, state: "expired" });
    expect(expired.apps.map(({ id }) => id)).toEqual([ids[0]]);
    const soon = await registry.listAll({ page: 1, pageSize: 50, state: "expiring_soon" });
    expect(soon.apps.map(({ id }) => id)).toEqual([ids[1]]);
    expect(
      (await registry.listAll({ page: 1, pageSize: 50, q: "100%" })).apps.map(({ id }) => id),
    ).toEqual([ids[1]]);
    expect((await registry.listAll({ page: 1, pageSize: 50, q: "BOB@" })).total).toBe(1);
    expect((await registry.listAll({ page: 1, pageSize: 50, q: "_" })).total).toBe(0);
  });

  it("pages through the whole registry in creation order with a cursor", async () => {
    const ids = await seed();
    const first = await registry.listPage({ limit: 2 });
    expect(first.apps.map(({ id }) => id)).toEqual([ids[0], ids[1]]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await registry.listPage({ limit: 2, cursor: first.nextCursor! });
    expect(second.apps.map(({ id }) => id)).toEqual([ids[2]]);
    expect(second.nextCursor).toBeNull();
    expect((await registry.listPage({ limit: 10, state: "active" })).apps).toHaveLength(1);
    await expect(registry.listPage({ limit: 2, cursor: "bm9wZQ" })).rejects.toBeInstanceOf(
      InvalidCursorError,
    );
  });
});

describe("failures", () => {
  it("answers registry_unavailable when the database is gone", async () => {
    const broken = createAppRegistry({ sql: database.sql });
    await database.sql.end();
    await expect(broken.byId("app_1")).rejects.toMatchObject({
      code: "registry_unavailable",
      status: 503,
    });
  });
});

describe("logging", () => {
  it("logs a failed query by error name and code only", async () => {
    const logs: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    const logged = createAppRegistry({
      sql: database.sql,
      log: (_level, message, fields) => void logs.push({ message, ...(fields ? { fields } : {}) }),
    });
    await database.sql`DROP TABLE apps`;
    await expect(logged.byId("app_1")).rejects.toMatchObject({ code: "registry_unavailable" });
    expect(logs).toEqual([
      {
        message: "registry query failed",
        fields: { errorName: "PostgresError", errorCode: "42P01" },
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain(testDatabaseUrl());
  });
});
