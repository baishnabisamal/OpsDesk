import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

// Runs once before the integration tests. It starts a fresh PostgreSQL in
// Docker (Testcontainers), points the app's settings at it, and applies the
// migrations. The tests therefore never touch the development database.

let container: StartedPostgreSqlContainer;

export async function setup() {
  // Ryuk is Testcontainers' helper container that removes leftovers after a
  // crash. It needs an extra image download; teardown() below stops our one
  // container, so it is switched off.
  process.env.TESTCONTAINERS_RYUK_DISABLED = "true";

  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("opsdesk_test")
    .withUsername("opsdesk_owner")
    .withPassword("owner-test-password")
    .start();

  // Test files run in worker processes started after this function, so they
  // inherit these values and core/config.ts reads them as usual.
  process.env.NODE_ENV = "test";
  process.env.POSTGRES_HOST = container.getHost();
  process.env.POSTGRES_PORT = String(container.getPort());
  process.env.POSTGRES_DB = "opsdesk_test";
  process.env.POSTGRES_USER = "opsdesk_owner";
  process.env.POSTGRES_PASSWORD = "owner-test-password";
  process.env.APP_DB_USER = "opsdesk_app";
  process.env.APP_DB_PASSWORD = "app-test-password";
  process.env.JWT_SECRET = "test-secret-test-secret-test-secret-123";

  // Imported here, after the settings exist, because config is read on import.
  const { migrate } = await import("../../scripts/migrate.js");
  await migrate(() => {});
}

export async function teardown() {
  await container.stop();
}
