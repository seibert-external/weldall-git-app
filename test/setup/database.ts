import { execFileSync } from "node:child_process";
import type { TestProject } from "vitest/node";
import postgres from "postgres";

/**
 * Provides the tests with a PostgreSQL server. With `GIT_APP_TEST_DATABASE_URL` set (CI service,
 * or a database you started), that one is used and left alone; otherwise a throwaway container
 * `weldall-git-app-test-db-<pid>` is started from `postgres:17-alpine` on a free loopback port
 * and removed when the run ends. Every test instance works in its own schema
 * (`test/fixtures/database.ts`), so test files can run in parallel.
 */

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

const IMAGE = process.env.GIT_APP_TEST_DATABASE_IMAGE ?? "postgres:17-alpine";

const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function waitUntilReady(url: string) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const sql = postgres(url, { max: 1, connect_timeout: 2, onnotice: () => {} });
    try {
      await sql`SELECT 1`;
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  }
}

export default async function setup(project: TestProject) {
  const given = process.env.GIT_APP_TEST_DATABASE_URL;
  if (given) {
    await waitUntilReady(given);
    project.provide("databaseUrl", given);
    return;
  }
  const name = `weldall-git-app-test-db-${process.pid}`;
  // Throwaway credentials for a container that listens on loopback only and is removed after the run.
  const password = `test-${process.pid}`;
  docker(
    "run",
    "--detach",
    "--rm",
    "--name",
    name,
    "--publish",
    "127.0.0.1::5432",
    "--env",
    `POSTGRES_PASSWORD=${password}`,
    "--env",
    "POSTGRES_DB=git_app_test",
    "--tmpfs",
    "/var/lib/postgresql/data",
    IMAGE,
    "-c",
    "max_connections=500",
    "-c",
    "fsync=off",
  );
  const remove = () => {
    try {
      docker("rm", "--force", name);
    } catch {
      /* Already gone. */
    }
  };
  try {
    const port = docker("port", name, "5432/tcp").split("\n")[0]!.split(":").at(-1);
    const url = `postgres://postgres:${password}@127.0.0.1:${port}/git_app_test`;
    await waitUntilReady(url);
    project.provide("databaseUrl", url);
  } catch (error) {
    remove();
    throw error;
  }
  return remove;
}
