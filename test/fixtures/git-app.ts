import { generateKeyPairSync, randomBytes } from "node:crypto";
import { vi } from "vitest";
import {
  JWT_DPOP_GRANT,
  MACHINE_TOKEN_TYP,
  SKILL_ASSERTION_TYPE,
  createDpopProof,
  generateEs256KeyPair,
  issueIdJag,
  signEs256,
  type DpopKeyPair,
} from "@weldall/sdk";
import { LOGIN_SCOPE } from "../../src/app-host.js";
import { createGitApp, type CreateGitAppOptions } from "../../src/app.js";
import { loadConfig, type GitAppConfig } from "../../src/config.js";
import { openConfiguredHost, type ConfiguredHost } from "../../src/hosts/index.js";
import { createInstallationTokenCache } from "../../src/hosts/github/tokens.js";
import type { Logger } from "../../src/log.js";
import { createAppRegistry, type AppRegistry } from "../../src/registry/registry.js";
import { createTestDatabase, seedRegistryApp, testDatabaseUrl, type SeedApp } from "./database.js";
import { createFakeWeldall, type FakeWeldall } from "./fake-weldall.js";

export const WELDALL_ISSUER = "https://weldall.example.com";
export const GIT_APP_ORIGIN = "https://git-app.example.com";
export const GIT_APP_RESOURCE = `${GIT_APP_ORIGIN}/api`;
export const DOWNSTREAM_CLIENT_ID = "weldall-cli-at-git-app";
export const PUBLISH_SCOPE = "git-app:publish";
export const ADMIN_SCOPE = "git-app:admin";
export const REGISTRY_READ_SCOPE = "git-app:registry-read";

/** The GitHub host configuration the GitHub fixtures (`github-api.ts`) answer for. */
export const githubHostConfig = {
  appId: "123456",
  organization: "acme-apps",
  installationId: "987654",
  templates: [{ name: "react", repository: "acme-apps/react-starter" }],
  repositoryNamePrefix: "app-",
  reviewerTeam: "app-reviewers",
  setupMode: "customer-managed",
};

const jwk = (value: object) => JSON.stringify(value);

/** Environment of a test instance; keys are generated per run, nothing is committed. */
export async function testEnvironment(overrides: Record<string, string | undefined> = {}) {
  const signing = await generateEs256KeyPair();
  const machine = await generateEs256KeyPair();
  const privateKey = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  }).privateKey;
  return {
    GIT_APP_HOST: "github",
    GIT_APP_HOST_CONFIG: JSON.stringify(githubHostConfig),
    GIT_APP_HOST_SECRET: privateKey,
    GIT_APP_PUBLIC_ORIGIN: GIT_APP_ORIGIN,
    GIT_APP_DOWNSTREAM_CLIENT_ID: DOWNSTREAM_CLIENT_ID,
    GIT_APP_SIGNING_KID: "git-app-1",
    GIT_APP_SIGNING_PRIVATE_JWK: jwk(signing.privateJwk),
    GIT_APP_SIGNING_PUBLIC_JWK: jwk(signing.publicJwk),
    WELDALL_ISSUER,
    WELDALL_MACHINE_CLIENT_ID: "git-app-machine",
    WELDALL_MACHINE_KID: "machine-1",
    WELDALL_MACHINE_PRIVATE_JWK: jwk(machine.privateJwk),
    WELDALL_MACHINE_PUBLIC_JWK: jwk(machine.publicJwk),
    GIT_APP_GIT_CREDENTIAL_KEY: randomBytes(32).toString("base64"),
    GIT_APP_DATABASE_URL: testDatabaseUrl(),
    ...overrides,
  } as Record<string, string | undefined>;
}

/** People of the fake Weldall, by Weldall user id. */
export const people = {
  alice: [LOGIN_SCOPE, PUBLISH_SCOPE],
  bob: [LOGIN_SCOPE, PUBLISH_SCOPE],
  /** Signed in, but the publish permission was removed after the token was issued. */
  eve: [LOGIN_SCOPE],
  /** Lost the login permission after the token was issued. */
  mallory: [PUBLISH_SCOPE],
  admin: [LOGIN_SCOPE, ADMIN_SCOPE],
};
export type PersonName = keyof typeof people;

/**
 * A Git app instance with a fake Weldall, the app registry in its own schema of the test
 * PostgreSQL server, the real GitHub driver (the global fetch is replaced by a GitHub fixture per
 * test) and access tokens obtained through the instance's own token endpoint, as the CLI would
 * get them.
 */
export async function createTestGitApp(
  options: {
    /** Replaces the GitHub driver (e.g. a fake host in front of `git http-backend`). */
    host?: (config: GitAppConfig) => ConfiguredHost;
    /** People of the fake Weldall; mutate the object to change permissions between calls. */
    people?: Record<string, string[]>;
    gitProxy?: CreateGitAppOptions["gitProxy"];
  } = {},
) {
  const weldallKey = await generateEs256KeyPair();
  const deviceKey = await generateEs256KeyPair();
  const config: GitAppConfig = await loadConfig(await testEnvironment());
  const logs: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
  const log: Logger = (level, message, fields) =>
    logs.push({ level, message, fields: fields ?? {} });
  const holders = options.people ?? people;
  let weldall: FakeWeldall = createFakeWeldall({ resource: GIT_APP_RESOURCE, people: holders });
  let database = await createTestDatabase();
  let registry: AppRegistry = createAppRegistry({ sql: database.sql, log });
  /** Registry methods the services called, in order, and errors queued for the next calls. */
  const registryCalls: Array<keyof AppRegistry> = [];
  const registryFailures = new Map<keyof AppRegistry, unknown[]>();
  /** The current registry, recording calls and throwing queued failures. */
  const observedRegistry = new Proxy({} as AppRegistry, {
    get(_, key: keyof AppRegistry) {
      return async (...args: unknown[]) => {
        registryCalls.push(key);
        const queued = registryFailures.get(key);
        if (queued?.length) throw queued.shift();
        return (registry[key] as (...input: unknown[]) => Promise<unknown>)(...args);
      };
    },
  });
  let gitProxy = options.gitProxy;
  let app = build();
  let eventCount = 0;

  function build() {
    return createGitApp({
      config,
      registry: observedRegistry,
      weldall: weldall.api,
      host:
        options.host?.(config) ??
        openConfiguredHost({
          configuration: config.host,
          secret: config.hostSecret,
          tokens: createInstallationTokenCache(),
          timing: { readyTimeoutMs: 300, pollIntervalMs: 5 },
        }),
      log,
      ...(gitProxy ? { gitProxy } : {}),
      eventId: () => `event-${String(++eventCount).padStart(12, "0")}`,
    });
  }

  /** Weldall's discovery documents, for the token exchange; everything else goes to `next`. */
  function withWeldallDiscovery(next: typeof fetch) {
    return async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === `${WELDALL_ISSUER}/.well-known/oauth-authorization-server`)
        return Response.json({
          issuer: WELDALL_ISSUER,
          jwks_uri: `${WELDALL_ISSUER}/.well-known/jwks.json`,
        });
      if (url === `${WELDALL_ISSUER}/.well-known/jwks.json`)
        return Response.json({
          keys: [{ ...weldallKey.publicJwk, kid: "weldall-1", alg: "ES256", use: "sig" }],
        });
      return next(input, init);
    };
  }

  const tokens = new Map<string, string>();
  /** An access token of the Git app for `person`, with the scopes Weldall would grant at issue time. */
  async function tokenFor(person: string, scopes: string[]) {
    const key = `${person} ${scopes.join(" ")}`;
    const cached = tokens.get(key);
    if (cached) return cached;
    const previous = globalThis.fetch;
    vi.stubGlobal("fetch", withWeldallDiscovery(previous));
    try {
      const assertion = await issueIdJag({
        issuer: WELDALL_ISSUER,
        subject: person,
        email: `${person}@example.com`,
        audience: GIT_APP_ORIGIN,
        clientId: DOWNSTREAM_CLIENT_ID,
        resource: GIT_APP_RESOURCE,
        scopes,
        jkt: deviceKey.jkt,
        kid: "weldall-1",
        privateJwk: weldallKey.privateJwk,
      });
      const endpoint = `${GIT_APP_ORIGIN}/oauth/token`;
      const response = await app.request(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          dpop: await createDpopProof({ ...deviceKey, method: "POST", url: endpoint }),
        },
        body: new URLSearchParams({ grant_type: JWT_DPOP_GRANT, assertion }),
      });
      const body = (await response.json()) as { access_token?: string };
      if (!response.ok || !body.access_token)
        throw new Error(`token exchange failed: ${JSON.stringify(body)}`);
      tokens.set(key, body.access_token);
      return body.access_token;
    } finally {
      vi.stubGlobal("fetch", previous);
    }
  }

  /** Calls the Git app as `person` with a fresh DPoP proof. */
  async function call(
    person: PersonName | (string & {}),
    method: "GET" | "POST",
    path: string,
    {
      body,
      rawBody,
      headers = {},
      scopes = defaultScopes(person),
    }: {
      body?: unknown;
      /** Sent as is (with `content-type: application/json`) instead of `body`. */
      rawBody?: ReadableStream<Uint8Array> | string;
      headers?: Record<string, string>;
      scopes?: string[];
    } = {},
  ) {
    const token = await tokenFor(person, scopes);
    const url = `${GIT_APP_ORIGIN}${path}`;
    const proof = await createDpopProof({
      ...(deviceKey as DpopKeyPair),
      method,
      url: url.split("?")[0]!,
      accessToken: token,
    });
    const response = await app.request(url, {
      method,
      headers: {
        authorization: `DPoP ${token}`,
        dpop: proof,
        ...(body === undefined && rawBody === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...headers,
      },
      ...(rawBody !== undefined
        ? { body: rawBody, duplex: "half" }
        : body === undefined
          ? {}
          : { body: JSON.stringify(body) }),
    } as RequestInit);
    return { status: response.status, json: (await response.json()) as any };
  }

  /**
   * Calls the Git app as a Weldall machine client (the customer's own tool) with a machine token
   * Weldall would issue for this resource, and a fresh DPoP proof.
   */
  async function machineCall(
    path: string,
    { scopes = [REGISTRY_READ_SCOPE], clientId = "registry-export" } = {},
  ) {
    const now = Math.floor(Date.now() / 1_000);
    const token = await signEs256(
      {
        iss: WELDALL_ISSUER,
        sub: `machine:${clientId}`,
        aud: GIT_APP_RESOURCE,
        client_id: clientId,
        azp: clientId,
        identity_type: "machine",
        token_type: "machine",
        scope: scopes.join(" "),
        cnf: { jkt: deviceKey.jkt },
        iat: now,
        exp: now + 300,
        jti: `machine-${randomBytes(8).toString("hex")}`,
      },
      { kid: "weldall-1", privateJwk: weldallKey.privateJwk, typ: MACHINE_TOKEN_TYP },
    );
    const url = `${GIT_APP_ORIGIN}${path}`;
    const proof = await createDpopProof({
      ...(deviceKey as DpopKeyPair),
      method: "GET",
      url: url.split("?")[0]!,
      accessToken: token,
    });
    const previous = globalThis.fetch;
    vi.stubGlobal("fetch", withWeldallDiscovery(previous));
    try {
      const response = await app.request(url, {
        headers: { authorization: `DPoP ${token}`, dpop: proof },
      });
      return { status: response.status, json: (await response.json()) as any };
    } finally {
      vi.stubGlobal("fetch", previous);
    }
  }

  return {
    config,
    logs,
    call,
    machineCall,
    get weldall() {
      return weldall;
    },
    /** The instance's app registry (direct, not recorded). */
    get registry() {
      return registry;
    },
    /** Registry methods the services called since the last reset. */
    registryCalls,
    /** Makes the next calls of a registry method throw `errors`, in order. */
    failRegistry(method: keyof AppRegistry, ...errors: unknown[]) {
      registryFailures.set(method, [...(registryFailures.get(method) ?? []), ...errors]);
    },
    /** The registry's database (its own schema). */
    get sql() {
      return database.sql;
    },
    /** Writes an app straight into the registry. */
    seed: (seed: SeedApp) => seedRegistryApp(database.sql, seed),
    /** A fresh fake Weldall, registry and instance, keeping keys and issued tokens. */
    async reset(next: { gitProxy?: CreateGitAppOptions["gitProxy"] } = {}) {
      await database.close();
      database = await createTestDatabase();
      registry = createAppRegistry({ sql: database.sql, log });
      weldall = createFakeWeldall({ resource: GIT_APP_RESOURCE, people: holders });
      gitProxy = next.gitProxy ?? options.gitProxy;
      app = build();
      logs.length = 0;
      registryCalls.length = 0;
      registryFailures.clear();
    },
    /** Ends the registry's pool and drops its schema. */
    close: () => database.close(),
    request: (input: string, init?: RequestInit) => app.request(input, init),
    /** Fetches the skill catalog as Weldall's skill discovery does, with a signed assertion. */
    async skillCatalog(claims: Record<string, unknown> = {}) {
      const endpoint = `${GIT_APP_ORIGIN}/.well-known/weldall-skills`;
      const now = Math.floor(Date.now() / 1_000);
      const assertion = await signEs256(
        {
          iss: WELDALL_ISSUER,
          sub: WELDALL_ISSUER,
          aud: endpoint,
          resource: GIT_APP_RESOURCE,
          purpose: "skills:read",
          iat: now,
          exp: now + 60,
          jti: `skills-${randomBytes(8).toString("hex")}`,
          ...claims,
        },
        { kid: "weldall-1", privateJwk: weldallKey.privateJwk, typ: SKILL_ASSERTION_TYPE },
      );
      const previous = globalThis.fetch;
      vi.stubGlobal("fetch", withWeldallDiscovery(previous));
      try {
        return await app.request(endpoint, { headers: { authorization: `Bearer ${assertion}` } });
      } finally {
        vi.stubGlobal("fetch", previous);
      }
    },
    /** The current instance's fetch handler, for serving it over real HTTP. */
    fetch: (request: Request) => app.fetch(request),
  };
}

/** The scopes Weldall issued in the person's token: what they held when they signed in. */
function defaultScopes(person: string) {
  return person === "admin" ? [ADMIN_SCOPE] : [PUBLISH_SCOPE];
}
