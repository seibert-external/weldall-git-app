import { randomBytes } from "node:crypto";
import { inject } from "vitest";
import postgres from "postgres";
import { migrateDatabase, openDatabase, type Database } from "../../src/registry/database.js";

/** The URL of the test PostgreSQL server (`test/setup/database.ts`). */
export const testDatabaseUrl = () => inject("databaseUrl");

/**
 * A fresh, migrated schema on the test server and a small pool bound to it. Every test instance
 * gets its own, so tests never see each other's apps. `close` ends the pool and drops the schema.
 */
export async function createTestDatabase(): Promise<{
  sql: Database;
  schema: string;
  close: () => Promise<void>;
}> {
  const url = testDatabaseUrl();
  const schema = `t_${randomBytes(8).toString("hex")}`;
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await admin`CREATE SCHEMA ${admin(schema)}`;
  } finally {
    await admin.end();
  }
  const sql = openDatabase(url, { schema, max: 3, idleTimeout: 2 });
  await migrateDatabase(sql);
  return {
    sql,
    schema,
    async close() {
      await sql.end({ timeout: 1 });
      const cleanup = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await cleanup`DROP SCHEMA IF EXISTS ${cleanup(schema)} CASCADE`;
      } finally {
        await cleanup.end();
      }
    },
  };
}

/** An app row as a test wants it in the registry; omitted fields get a ready template app's values. */
export interface SeedApp {
  id: string;
  owner: string;
  ownerEmail?: string | null;
  name?: string;
  purpose?: string;
  repository?: { owner: string; name: string; id: string | null; webUrl: string | null };
  defaultBranch?: string;
  template?: { name: string; commit: string | null } | null;
  links?: { preview: string | null; live: string | null };
  createdAt?: string;
  expiresAt?: string;
}

/** Writes an app straight into the registry, bypassing the services (for tests that need one). */
export async function seedRegistryApp(sql: Database, seed: SeedApp) {
  const repository = seed.repository ?? {
    owner: "acme-apps",
    name: "app-expenses",
    id: "4242",
    webUrl: "https://github.com/acme-apps/app-expenses",
  };
  const template =
    seed.template === undefined ? { name: "react", commit: "c".repeat(40) } : seed.template;
  const createdAt = new Date(seed.createdAt ?? "2026-11-01T00:00:00.000Z");
  await sql`
    INSERT INTO apps (
      id, name, purpose, owner_subject, owner_email, repository_owner, repository_name,
      repository_id, repository_web_url, default_branch, template, template_commit, preview_url,
      live_url, registered_by, created_at, updated_at, expires_at
    ) VALUES (
      ${seed.id}, ${seed.name ?? "expenses"}, ${seed.purpose ?? "Tracks team expenses"},
      ${seed.owner}, ${seed.ownerEmail === undefined ? `${seed.owner}@example.com` : seed.ownerEmail},
      ${repository.owner}, ${repository.name}, ${repository.id}, ${repository.webUrl},
      ${seed.defaultBranch ?? "main"}, ${template?.name ?? null}, ${template?.commit ?? null},
      ${seed.links?.preview ?? null}, ${seed.links?.live ?? null}, ${seed.owner}, ${createdAt},
      ${createdAt}, ${new Date(seed.expiresAt ?? "2027-05-01T00:00:00.000Z")}
    )`;
}
