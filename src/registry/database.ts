import postgres from "postgres";
import { MIGRATIONS, type Migration } from "./migrations.js";

/**
 * The Git app's own PostgreSQL database, which holds the app registry. `postgres` (postgres.js) is
 * a small driver without dependencies; the registry uses plain SQL and the migrations in
 * `migrations.ts`, applied at start.
 */
export type Database = postgres.Sql;

export interface DatabaseOptions {
  /** Pool size; one instance runs one process, so a few connections are enough. */
  max?: number;
  /** Seconds an idle connection stays open. */
  idleTimeout?: number;
  /** Schema for every connection (tests); default the server's `search_path`. */
  schema?: string;
}

/** Opens a pool for `url`. Connects lazily: call {@link migrateDatabase} to fail early. */
export function openDatabase(url: string, options: DatabaseOptions = {}): Database {
  return postgres(url, {
    max: options.max ?? 10,
    idle_timeout: options.idleTimeout ?? 30,
    connect_timeout: 10,
    // Notices (e.g. "relation already exists, skipping") are not errors and not worth logging.
    onnotice: () => {},
    ...(options.schema ? { connection: { search_path: options.schema } } : {}),
  });
}

/** The database holds migrations this Git app does not know: it was migrated by a newer version. */
export class DatabaseTooNewError extends Error {
  constructor(readonly version: number) {
    super(`The database schema is at version ${version}, newer than this Git app knows.`);
    this.name = "DatabaseTooNewError";
  }
}

/**
 * Applies the missing migrations in order, each in the same transaction as its bookkeeping row.
 * An advisory lock serialises concurrent starts. Refuses a database migrated by a newer Git app.
 * Returns the versions applied now.
 */
export async function migrateDatabase(
  sql: Database,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<number[]> {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(current_schema() || '.weldall_git_app_migrations'))`;
    await tx`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    integer PRIMARY KEY,
        name       text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`;
    const rows = await tx<{ version: number }[]>`SELECT version FROM schema_migrations`;
    const applied = new Set(rows.map(({ version }) => version));
    const known = new Set(migrations.map(({ version }) => version));
    const unknown = [...applied].filter((version) => !known.has(version));
    if (unknown.length) throw new DatabaseTooNewError(Math.max(...unknown));
    const now: number[] = [];
    for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
      if (applied.has(migration.version)) continue;
      await tx.unsafe(migration.sql);
      await tx`INSERT INTO schema_migrations (version, name) VALUES (${migration.version}, ${migration.name})`;
      now.push(migration.version);
    }
    return now;
  });
}
