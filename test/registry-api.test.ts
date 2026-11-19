import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mockGitHub, mockGitHubPullRequests } from "./fixtures/github-api.js";
import {
  ADMIN_SCOPE,
  createTestGitApp,
  GIT_APP_RESOURCE,
  PUBLISH_SCOPE,
} from "./fixtures/git-app.js";

/** The app registry's API: own apps and confirmation, the admin list and registration, tools. */

let gitApp: Awaited<ReturnType<typeof createTestGitApp>>;
const DAY = 86_400_000;

beforeAll(async () => {
  gitApp = await createTestGitApp();
});
beforeEach(() => gitApp.reset());
afterEach(() => vi.unstubAllGlobals());
afterAll(() => gitApp.close());

const events = () => gitApp.weldall.events;
const repo = (name: string) => ({ owner: "acme-apps", name, id: null, webUrl: null });

async function seedThree() {
  await gitApp.seed({
    id: "app_alice_old",
    owner: "alice",
    name: "old",
    repository: repo("app-old"),
    createdAt: "2026-06-01T00:00:00.000Z",
    expiresAt: "2026-09-01T00:00:00.000Z",
  });
  await gitApp.seed({
    id: "app_bob",
    owner: "bob",
    ownerEmail: null,
    name: "bobs",
    repository: repo("app-bobs"),
    createdAt: "2026-07-01T00:00:00.000Z",
    expiresAt: new Date(Date.now() + 5 * DAY).toISOString(),
  });
  await gitApp.seed({
    id: "app_alice_new",
    owner: "alice",
    name: "new",
    repository: repo("app-new"),
    createdAt: "2026-11-01T00:00:00.000Z",
    expiresAt: new Date(Date.now() + 80 * DAY).toISOString(),
    links: { preview: null, live: "https://new.example.com/" },
  });
}

describe("GET /api/apps", () => {
  it("lists only the person's apps, expired first, with the registry's rules", async () => {
    await seedThree();
    const { status, json } = await gitApp.call("alice", "GET", "/api/apps");
    expect(status).toBe(200);
    expect(json).toMatchObject({
      resource: GIT_APP_RESOURCE,
      reverificationDays: 90,
      expiringSoonDays: 14,
    });
    expect(json.apps.map(({ id, state }: { id: string; state: string }) => [id, state])).toEqual([
      ["app_alice_old", "expired"],
      ["app_alice_new", "active"],
    ]);
    expect(json.apps[1]).toEqual({
      id: "app_alice_new",
      name: "new",
      purpose: "Tracks team expenses",
      repository: { owner: "acme-apps", name: "app-new", webUrl: null },
      template: "react",
      links: { preview: null, live: "https://new.example.com/" },
      createdAt: "2026-11-01T00:00:00.000Z",
      confirmedAt: null,
      expiresAt: expect.any(String),
      state: "active",
    });
    // Reads are not audited.
    expect(events()).toEqual([]);
  });

  it("records the email address of the owner's token", async () => {
    await seedThree();
    await gitApp.call("bob", "GET", "/api/apps");
    expect((await gitApp.registry.byId("app_bob"))?.owner).toEqual({
      id: "bob",
      email: "bob@example.com",
    });
  });

  it("refuses a person whose publish permission was removed", async () => {
    const { status, json } = await gitApp.call("eve", "GET", "/api/apps");
    expect(status).toBe(403);
    expect(json.error).toBe("access_denied");
  });
});

describe("POST /api/apps/:id/confirm", () => {
  it("moves the owner's expiry 90 days ahead, records who, and audits it", async () => {
    await seedThree();
    const started = Date.now();
    const { status, json } = await gitApp.call("alice", "POST", "/api/apps/app_alice_old/confirm");
    expect(status).toBe(200);
    expect(json.app).toMatchObject({ id: "app_alice_old", state: "active" });
    expect(Date.parse(json.app.expiresAt)).toBeGreaterThanOrEqual(started + 90 * DAY);
    expect(Date.parse(json.app.confirmedAt)).toBeGreaterThanOrEqual(started);
    expect((await gitApp.registry.byId("app_alice_old"))?.confirmedBy).toBe("alice");
    expect(events()).toEqual([
      expect.objectContaining({
        eventType: "app_confirmation.succeeded",
        subject: "alice",
        appId: "app_alice_old",
        repository: { owner: "acme-apps", name: "app-old" },
        details: {
          previousExpiresAt: "2026-09-01T00:00:00.000Z",
          expiresAt: json.app.expiresAt,
          previousState: "expired",
        },
      }),
    ]);
  });

  it("answers another person's app like an unknown id and audits the refusal without linking it", async () => {
    await seedThree();
    const other = await gitApp.call("alice", "POST", "/api/apps/app_bob/confirm");
    const unknown = await gitApp.call("alice", "POST", "/api/apps/app_nope/confirm");
    expect(other).toEqual(unknown);
    expect(other.status).toBe(404);
    expect((await gitApp.registry.byId("app_bob"))?.confirmedAt).toBeNull();
    expect(events()).toEqual([
      expect.objectContaining({
        eventType: "app_confirmation.denied",
        subject: "alice",
        appId: null,
        repository: null,
        reason: "No app of yours has this id. (requested: app_bob)",
        details: {},
      }),
      expect.objectContaining({ eventType: "app_confirmation.denied", appId: null }),
    ]);
  });

  it("changes nothing when Weldall does not store the confirmation", async () => {
    await seedThree();
    gitApp.weldall.fail("reportAuditEvent", new TypeError("fetch failed"), new TypeError("again"));
    const { status, json } = await gitApp.call("alice", "POST", "/api/apps/app_alice_old/confirm");
    expect(status).toBe(503);
    expect(json.error).toBe("audit_unavailable");
    expect(await gitApp.registry.byId("app_alice_old")).toMatchObject({
      confirmedAt: null,
      expiresAt: "2026-09-01T00:00:00.000Z",
      state: "expired",
    });
  });

  it("only flags an expired app: publishing still works and does not extend the expiry", async () => {
    await gitApp.seed({
      id: "app_expired",
      owner: "alice",
      expiresAt: "2026-09-01T00:00:00.000Z",
    });
    mockGitHubPullRequests();
    const opened = await gitApp.call("alice", "POST", "/api/apps/app_expired/pull-requests", {
      body: { head: "weldall/publish-1", title: "Add receipts" },
    });
    expect(opened.status).toBe(200);
    expect(await gitApp.registry.byId("app_expired")).toMatchObject({
      state: "expired",
      expiresAt: "2026-09-01T00:00:00.000Z",
      confirmedAt: null,
    });
  });
});

describe("GET /api/admin/apps", () => {
  it("lists every app with its owner for administrators, flagged ones first", async () => {
    await seedThree();
    const { status, json } = await gitApp.call("admin", "GET", "/api/admin/apps");
    expect(status).toBe(200);
    expect(json).toMatchObject({ total: 3, page: 1, pageSize: 50, reverificationDays: 90 });
    expect(json.apps.map(({ id }: { id: string }) => id)).toEqual([
      "app_alice_old",
      "app_bob",
      "app_alice_new",
    ]);
    expect(json.apps[1]).toMatchObject({
      owner: { id: "bob", email: null },
      registeredBy: "bob",
      confirmedBy: null,
      state: "expiring_soon",
    });
    const flagged = await gitApp.call("admin", "GET", "/api/admin/apps?state=expired");
    expect(flagged.json.apps.map(({ id }: { id: string }) => id)).toEqual(["app_alice_old"]);
    const found = await gitApp.call("admin", "GET", "/api/admin/apps?q=APP-BOBS&pageSize=1");
    expect(found.json).toMatchObject({ total: 1, pageSize: 1 });
  });

  it("refuses people without the admin scope and malformed queries", async () => {
    expect((await gitApp.call("alice", "GET", "/api/admin/apps")).status).toBe(403);
    for (const query of ["state=gone", "pageSize=500", "page=1&page=2", "sort=name"])
      expect((await gitApp.call("admin", "GET", `/api/admin/apps?${query}`)).json.error).toBe(
        "invalid_request",
      );
  });
});

describe("POST /api/admin/apps", () => {
  const existing = { owner: "bob", repository: "legacy-tool", name: "legacy", purpose: "Old tool" };

  it("registers an existing repository for its owner, ready at once, audited as the administrator", async () => {
    mockGitHub();
    const { status, json } = await gitApp.call("admin", "POST", "/api/admin/apps", {
      body: existing,
    });
    expect(status).toBe(200);
    expect(json).toMatchObject({
      created: true,
      app: {
        name: "legacy",
        purpose: "Old tool",
        owner: { id: "bob", email: null },
        registeredBy: "admin",
        repository: {
          owner: "acme-apps",
          name: "legacy-tool",
          webUrl: "https://github.com/acme-apps/legacy-tool",
        },
        template: null,
        state: "active",
      },
      warnings: [],
    });
    expect(await gitApp.registry.byId(json.app.id)).toMatchObject({ ready: true, template: null });
    expect(gitApp.weldall.callsOf("checkSubjectScopes")).toEqual([
      { subject: "admin", scopes: ["weldall:login", ADMIN_SCOPE] },
      { subject: "bob", scopes: ["weldall:login", PUBLISH_SCOPE] },
    ]);
    expect(events()).toEqual([
      expect.objectContaining({
        eventType: "git_repository.registered",
        subject: "admin",
        appId: json.app.id,
        repository: { owner: "acme-apps", name: "legacy-tool" },
        details: {
          owner: "bob",
          repositoryId: expect.any(String),
          defaultBranch: "main",
          warnings: [],
        },
      }),
    ]);

    // The owner sees it and can get a git credential for it.
    expect((await gitApp.call("bob", "GET", "/api/apps")).json.apps).toHaveLength(1);
    const credential = await gitApp.call("bob", "POST", "/api/git-credentials", {
      body: { path: "git/acme-apps/legacy-tool.git" },
    });
    expect(credential.status).toBe(200);

    // Repeating it returns the entry unchanged.
    const again = await gitApp.call("admin", "POST", "/api/admin/apps", { body: existing });
    expect(again.json).toMatchObject({ created: false, app: { id: json.app.id } });
  });

  it.each([
    ["an owner without the publish permission", { owner: "eve" }, "owner_not_allowed"],
    ["an owner Weldall does not know", { owner: "stranger" }, "owner_not_allowed"],
    ["a template repository", { repository: "react-starter" }, "repository_is_template"],
  ])("refuses %s before registering", async (_, overrides, code) => {
    mockGitHub();
    const { status, json } = await gitApp.call("admin", "POST", "/api/admin/apps", {
      body: { ...existing, ...overrides },
    });
    expect(status).toBe(409);
    expect(json.error).toBe(code);
    expect(await gitApp.registry.byRepository({ owner: "acme-apps", name: "legacy-tool" })).toBe(
      null,
    );
    expect(events()).toEqual([
      expect.objectContaining({
        eventType: "git_repository.denied",
        subject: "admin",
        appId: null,
        details: { template: null },
      }),
    ]);
  });

  it("refuses a repository already registered for someone else without asking the host", async () => {
    await gitApp.seed({ id: "app_alice", owner: "alice", repository: repo("legacy-tool") });
    const github = mockGitHub();
    const { status, json } = await gitApp.call("admin", "POST", "/api/admin/apps", {
      body: existing,
    });
    expect(status).toBe(409);
    expect(json.error).toBe("app_exists");
    expect(github.calls).toEqual([]);
  });

  it("registers nothing when Weldall does not store the audit entry", async () => {
    mockGitHub();
    gitApp.weldall.fail("reportAuditEvent", new TypeError("fetch failed"), new TypeError("again"));
    const { status, json } = await gitApp.call("admin", "POST", "/api/admin/apps", {
      body: existing,
    });
    expect(status).toBe(503);
    expect(json.error).toBe("audit_unavailable");
    expect(await gitApp.registry.byRepository({ owner: "acme-apps", name: "legacy-tool" })).toBe(
      null,
    );
  });

  it("is for administrators only", async () => {
    const { status } = await gitApp.call("alice", "POST", "/api/admin/apps", { body: existing });
    expect(status).toBe(403);
  });
});

describe("GET /api/registry/apps", () => {
  it("pages through the whole registry for a machine client with the read scope", async () => {
    await seedThree();
    const first = await gitApp.machineCall("/api/registry/apps?limit=2");
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({
      resource: GIT_APP_RESOURCE,
      reverificationDays: 90,
      expiringSoonDays: 14,
      generatedAt: expect.any(String),
    });
    expect(first.json.apps.map(({ id }: { id: string }) => id)).toEqual([
      "app_alice_old",
      "app_bob",
    ]);
    expect(first.json.apps[0].owner).toEqual({ id: "alice", email: "alice@example.com" });
    const second = await gitApp.machineCall(
      `/api/registry/apps?limit=2&cursor=${encodeURIComponent(first.json.nextCursor)}`,
    );
    expect(second.json.apps.map(({ id }: { id: string }) => id)).toEqual(["app_alice_new"]);
    expect(second.json.nextCursor).toBeNull();
    const expired = await gitApp.machineCall("/api/registry/apps?state=expired");
    expect(expired.json.apps).toHaveLength(1);
  });

  it("refuses tokens without the scope, people, and cursors it did not issue", async () => {
    const withoutScope = await gitApp.machineCall("/api/registry/apps", {
      scopes: [PUBLISH_SCOPE],
    });
    expect(withoutScope).toMatchObject({ status: 403, json: { error: "insufficient_scope" } });
    const person = await gitApp.call("admin", "GET", "/api/registry/apps", {
      scopes: ["git-app:registry-read"],
    });
    expect(person).toMatchObject({ status: 403, json: { error: "access_denied" } });
    const cursor = await gitApp.machineCall("/api/registry/apps?cursor=bm9wZQ");
    expect(cursor).toMatchObject({ status: 400, json: { error: "invalid_request" } });
  });

  it("refuses machine tokens on the people's routes", async () => {
    const { status } = await gitApp.machineCall("/api/apps", { scopes: [PUBLISH_SCOPE] });
    expect(status).toBe(403);
  });
});
