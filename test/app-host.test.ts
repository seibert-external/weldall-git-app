import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateEs256KeyPair } from "@weldall/sdk";
import {
  APP_HOST_AUDIT_EVENT_TYPES,
  appHostAuditEventRequestSchema,
  appHostCreateAppRequestSchema,
  appHostUpdateAppRequestSchema,
  createWeldallAppHostClient,
} from "../src/app-host.js";

/**
 * The example audit event request both sides of the contract check against. Weldall keeps an
 * identical copy and checks that its endpoint accepts it; keep the two files the same.
 */
const auditEventRequest = JSON.parse(
  readFileSync(new URL("./fixtures/app-host/audit-event-request.json", import.meta.url), "utf8"),
) as Record<string, unknown> & { resource: string };

const issuer = "https://weldall.example.com";
const resource = auditEventRequest.resource;

describe("app host client", () => {
  it("sends exactly the fixture's audit event request", async () => {
    const key = await generateEs256KeyPair();
    const requests: { method: string; url: string; headers: Headers; body: string }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      requests.push({ method: init?.method ?? "GET", url, headers, body: String(init?.body) });
      if (url === `${issuer}/api/auth/oauth2/token`)
        return Response.json({
          access_token: "machine-token",
          token_type: "DPoP",
          expires_in: 300,
          scope: "weldall:app-host",
        });
      if (url === `${issuer}/api/app-host/v1/audit-events`)
        return Response.json(
          {
            accepted: true,
            eventId: auditEventRequest.eventId,
            auditEventId: "audit-1",
            duplicate: false,
            recordedAt: "2026-11-19T12:00:00.000Z",
          },
          { status: 201 },
        );
      return new Response(null, { status: 404 });
    };
    const client = createWeldallAppHostClient({
      issuer,
      clientId: "git-app-machine",
      kid: "machine-1",
      key,
      resource,
      fetch: fetcher,
    });

    const { resource: _resource, ...report } = auditEventRequest;
    const answer = await client.reportAuditEvent(
      report as Parameters<typeof client.reportAuditEvent>[0],
    );

    expect(answer).toMatchObject({ accepted: true, duplicate: false });
    const token = requests.find(({ url }) => url.endsWith("/api/auth/oauth2/token"));
    expect(new URLSearchParams(token?.body).get("scope")).toBe("weldall:app-host");
    expect(new URLSearchParams(token?.body).get("resource")).toBe(`${issuer}/api`);
    const sent = requests.find(({ url }) => url.endsWith("/api/app-host/v1/audit-events"));
    expect(sent?.method).toBe("POST");
    expect(sent?.headers.get("authorization")).toBe("DPoP machine-token");
    expect(sent?.headers.get("dpop")).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(sent?.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(sent?.body ?? "null")).toStrictEqual(auditEventRequest);
  });
});

// Carried over from Weldall's own contract tests (`packages/sdk/test/app-host.test.ts`).
describe("app host contract", () => {
  const commit = "a".repeat(40);
  const forwarded = {
    resource,
    eventId: "0f3c4f0e-6a1b-4c1e-9d55-6b2f3c0d9a10",
    eventType: "git_push.forwarded",
    subject: "user-1",
    appId: "cm3k9x2f80001",
    details: {
      refUpdates: [
        { ref: "refs/heads/weldall/publish-1", oldCommit: "0".repeat(40), newCommit: commit },
      ],
      refUpdateCount: 1,
      credentialId: null,
    },
  };

  it("accepts the shared fixture", () => {
    expect(appHostAuditEventRequestSchema.safeParse(auditEventRequest).success).toBe(true);
  });

  it("covers every Git audit event", () => {
    expect(APP_HOST_AUDIT_EVENT_TYPES).toHaveLength(17);
    expect(APP_HOST_AUDIT_EVENT_TYPES).toContain("git_push.forwarded");
    expect(APP_HOST_AUDIT_EVENT_TYPES).toContain("git_host.checked");
  });

  it("accepts a well-formed report and rejects unknown fields and events", () => {
    expect(appHostAuditEventRequestSchema.safeParse(forwarded).success).toBe(true);
    for (const report of [
      { ...forwarded, extra: 1 },
      { ...forwarded, details: { ...forwarded.details, token: "x" } },
      { ...forwarded, eventType: "skill.created" },
      // A success always names the person and the app.
      { ...forwarded, subject: null },
      { ...forwarded, appId: null },
      { ...forwarded, details: { ...forwarded.details, refUpdateCount: 0 } },
      { ...forwarded, eventId: "too-short" },
    ])
      expect(appHostAuditEventRequestSchema.safeParse(report).success).toBe(false);
  });

  it("lets a rejection name either the app or the repository", () => {
    const denied = {
      resource,
      eventId: forwarded.eventId,
      eventType: "git_fetch.denied",
      subject: null,
      appId: null,
      repository: { owner: "acme-apps", name: "app-x" },
      reason: "Unknown credential.",
      details: {
        credentialId: null,
        requestBytes: null,
        responseBytes: null,
        durationMs: null,
        upstreamStatus: null,
      },
    };
    expect(appHostAuditEventRequestSchema.safeParse(denied).success).toBe(true);
    expect(
      appHostAuditEventRequestSchema.safeParse({ ...denied, appId: "cm3k9x2f80001" }).success,
    ).toBe(false);
  });

  it("accepts only https links without credentials and at least one change", () => {
    const app = {
      resource,
      owner: "user-1",
      name: "tracker",
      purpose: "Tracks expenses",
      repository: { owner: "acme-apps", name: "app-tracker", id: null, webUrl: null },
      defaultBranch: "main",
      template: { name: "react", commit: null },
    };
    expect(appHostCreateAppRequestSchema.safeParse(app).success).toBe(true);
    expect(
      appHostCreateAppRequestSchema.safeParse({
        ...app,
        repository: { ...app.repository, webUrl: "http://git.example.com/x" },
      }).success,
    ).toBe(false);
    expect(appHostUpdateAppRequestSchema.safeParse({ resource }).success).toBe(false);
    expect(
      appHostUpdateAppRequestSchema.safeParse({
        resource,
        links: { live: "https://user:secret@app.example.com/" },
      }).success,
    ).toBe(false);
    expect(
      appHostUpdateAppRequestSchema.safeParse({ resource, links: { preview: null } }).success,
    ).toBe(true);
  });
});
