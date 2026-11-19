import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // A throwaway PostgreSQL for the app registry (see test/setup/database.ts).
    globalSetup: ["test/setup/database.ts"],
  },
});
