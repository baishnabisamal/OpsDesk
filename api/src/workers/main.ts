import { config } from "../core/config.js";
import { logger } from "../core/logger.js";
import { closePool } from "../db/pool.js";
import { JOBS } from "./jobs.js";
import { startRunner } from "./runner.js";

// The worker process. Started with `make worker`, separately from the API:
// the same code base, a different entry point.

const runner = await startRunner({
  queueName: "opsdesk-jobs",
  jobs: JOBS,
  redis: config.redis,
});

logger.info({ jobs: Object.keys(JOBS) }, "worker started");

// On Ctrl+C or a container stop: let the running job finish, then exit.
async function shutdown() {
  await runner.close();
  await closePool();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
