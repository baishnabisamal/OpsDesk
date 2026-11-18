import { hostname } from "node:os";
import { config } from "../core/config.js";
import { logger } from "../core/logger.js";
import { createRedis } from "../core/redis.js";
import { closePool } from "../db/pool.js";
import { createMailTransport } from "../services/emailService.js";
import { startRelay } from "../services/outboxRelay.js";
import { startEmailConsumer } from "./emailConsumer.js";
import { JOBS } from "./jobs.js";
import { startRunner } from "./runner.js";

// The worker process. Started with `make worker`, separately from the API:
// the same code base, a different entry point. It runs three things:
//   - the scheduled jobs (BullMQ)
//   - the outbox relay (outbox table -> Redis Stream), in a loop
//   - the email consumer (Redis Stream -> SMTP), in a loop

const runner = await startRunner({
  queueName: "opsdesk-jobs",
  jobs: JOBS,
  redis: config.redis,
});

// Each loop gets its own Redis connection: the email consumer's blocking
// read would otherwise hold up the relay's commands.
const relayRedis = createRedis();
const emailRedis = createRedis();
const transport = createMailTransport();

const stopRelay = startRelay(relayRedis);
// The consumer name must be unique per worker process within the group.
const stopEmail = startEmailConsumer(emailRedis, transport, `${hostname()}-${process.pid}`);

logger.info({ jobs: Object.keys(JOBS) }, "worker started: jobs, outbox relay, email consumer");

// On Ctrl+C or a container stop: finish the current round of each loop, then exit.
async function shutdown() {
  await Promise.all([stopRelay(), stopEmail(), runner.close()]);
  relayRedis.disconnect();
  emailRedis.disconnect();
  transport.close();
  await closePool();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
