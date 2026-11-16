import { defineConfig } from "vitest/config";

// Two groups of tests:
//   unit         pure functions, no database, runs in about a second
//   integration  real HTTP requests against a real PostgreSQL in Docker
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "node",
          // Fake settings, so importing core/config.ts works without a .env.
          env: {
            NODE_ENV: "test",
            POSTGRES_DB: "unused",
            POSTGRES_USER: "unused",
            POSTGRES_PASSWORD: "unused",
            APP_DB_PASSWORD: "unused-password",
            JWT_SECRET: "unit-test-secret-unit-test-secret-123",
            ML_SHARED_SECRET: "unit-test-ml-secret",
          },
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          // Starts a throwaway Postgres container once, before all files.
          globalSetup: ["tests/integration/globalSetup.ts"],
          testTimeout: 20_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
