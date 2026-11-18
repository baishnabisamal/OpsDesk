import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, type StartedTestContainer } from "testcontainers";

// Runs once before the integration tests. It starts a fresh PostgreSQL and a
// fresh Redis in Docker (Testcontainers), points the app's settings at it, and applies the
// migrations. The tests therefore never touch the development database.

let container: StartedPostgreSqlContainer;
let redis: StartedTestContainer;

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

  // A throwaway Redis for the job queue tests.
  redis = await new GenericContainer("redis:7-alpine").withExposedPorts(6379).start();
  process.env.REDIS_HOST = redis.getHost();
  process.env.REDIS_PORT = String(redis.getMappedPort(6379));
  // No ML service runs during tests. Nothing listens on this port, so most
  // test files exercise the "ML is down" path. Files that need a working
  // model start their own fake ML server (fakeMl.ts).
  process.env.ML_URL = "http://127.0.0.1:58211";
  process.env.ML_SHARED_SECRET = "test-ml-shared-secret";
  process.env.ML_TIMEOUT_MS = "150";

  // Imported here, after the settings exist, because config is read on import.
  const { migrate } = await import("../../scripts/migrate.js");
  await migrate(() => {});
}

export async function teardown() {
  await container.stop();
  await redis.stop();
}
