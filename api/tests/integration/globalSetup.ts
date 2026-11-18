import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import type { TestProject } from "vitest/node";

// Runs once before the integration tests. It starts a fresh PostgreSQL and a
// fresh Redis in Docker (Testcontainers), points the app's settings at it, and applies the
// migrations. The tests therefore never touch the development database.

let container: StartedPostgreSqlContainer;
let redis: StartedTestContainer;
let mailpit: StartedTestContainer;

export async function setup(project: TestProject) {
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
  process.env.INBOUND_WEBHOOK_SECRET = "test-inbound-webhook-secret-0123456789";
  // Very high limits for the app under test: concurrency tests fire hundreds
  // of requests as one user. rateLimit.test.ts builds its own small limiter.
  process.env.RATE_LIMIT_USER_CAPACITY = "1000000";
  process.env.RATE_LIMIT_AGENCY_CAPACITY = "1000000";
  process.env.RATE_LIMIT_LOGIN_CAPACITY = "1000000";
  // A fresh, empty archive directory for each test run.
  process.env.ARCHIVE_DIR = await mkdtemp(path.join(tmpdir(), "opsdesk-archive-"));

  // A throwaway Redis for the job queue tests.
  redis = await new GenericContainer("redis:7-alpine").withExposedPorts(6379).start();
  process.env.REDIS_HOST = redis.getHost();
  process.env.REDIS_PORT = String(redis.getMappedPort(6379));
  // A throwaway Mailpit: a real SMTP server that keeps every email it gets
  // and shows them through a small web API, so tests can count them.
  mailpit = await new GenericContainer("axllent/mailpit:v1.21")
    .withExposedPorts(1025, 8025)
    // Mailpit looks up the client's host name (reverse DNS) before it says
    // hello. With slow or broken DNS that hangs every connection.
    .withEnvironment({ MP_SMTP_DISABLE_RDNS: "true" })
    .withWaitStrategy(Wait.forHttp("/readyz", 8025))
    .start();
  // An IP address, not "localhost": nodemailer resolves host names through
  // DNS itself, and DNS on a laptop can be slow or offline.
  process.env.SMTP_HOST = mailpit.getHost() === "localhost" ? "127.0.0.1" : mailpit.getHost();
  process.env.SMTP_PORT = String(mailpit.getMappedPort(1025));
  // Handed to the tests with inject("mailpitUrl"). It is not app config.
  project.provide("mailpitUrl", `http://${mailpit.getHost()}:${mailpit.getMappedPort(8025)}`);

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
  await mailpit.stop();
}

// Tells TypeScript what inject() returns in the test files.
declare module "vitest" {
  export interface ProvidedContext {
    mailpitUrl: string;
  }
}
