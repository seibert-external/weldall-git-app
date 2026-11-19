import { createGitApp } from "./app.js";
import { GitAppConfigError, loadConfig, type GitAppConfig } from "./config.js";
import {
  DatabaseTooNewError,
  migrateDatabase,
  openDatabase,
  type Database,
} from "./registry/database.js";
import { jsonLogger } from "./log.js";
import { createAppRegistry } from "./registry/registry.js";

type Env = Parameters<typeof loadConfig>[0];
type ReadFile = Parameters<typeof loadConfig>[1];

/** The registry database could not be reached or migrated; the message names no value. */
export class GitAppDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitAppDatabaseError";
  }
}

/** A database error's code (e.g. `ECONNREFUSED`, `28P01`) when it is one; never its text. */
function databaseErrorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : null;
}

/**
 * Loads the configuration, opens the registry database, applies its migrations and builds the
 * app. A configuration problem is a {@link GitAppConfigError}, whose message names variables
 * only: an error from building the app (the SDK or the host driver refusing a value) is replaced
 * by a fixed message, because its text is not ours to vouch for. A database that cannot be
 * reached or migrated is a {@link GitAppDatabaseError} with at most the error code.
 */
export async function prepareGitApp(
  env?: Env,
  readFile?: ReadFile,
): Promise<{
  config: GitAppConfig;
  app: ReturnType<typeof createGitApp>;
  database: Database;
}> {
  const config = await loadConfig(env, readFile);
  const database = openDatabase(config.databaseUrl);
  try {
    await migrateDatabase(database);
  } catch (error) {
    await database.end({ timeout: 1 }).catch(() => {});
    if (error instanceof DatabaseTooNewError)
      throw new GitAppDatabaseError(
        `The app registry database (GIT_APP_DATABASE_URL) was migrated by a newer Git app (schema version ${error.version}); run that version or a newer one.`,
      );
    const code = databaseErrorCode(error);
    throw new GitAppDatabaseError(
      `The app registry database (GIT_APP_DATABASE_URL) could not be reached or migrated${code ? ` (${code})` : ""}.`,
    );
  }
  try {
    return {
      config,
      database,
      app: createGitApp({
        config,
        registry: createAppRegistry({ sql: database, log: jsonLogger }),
      }),
    };
  } catch {
    await database.end({ timeout: 1 }).catch(() => {});
    throw new GitAppConfigError(["The Git app could not start with this configuration."]);
  }
}

/** The start-up error text for stderr: never a value, never a stack trace. */
export function startupErrorMessage(error: unknown): string {
  if (error instanceof GitAppConfigError || error instanceof GitAppDatabaseError)
    return error.message;
  return "Invalid Git app configuration.";
}
