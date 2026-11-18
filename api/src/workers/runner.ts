import { Queue, Worker, type Job } from "bullmq";
import { logger } from "../core/logger.js";
import { tx } from "../db/tx.js";
import { SYSTEM_PRINCIPAL } from "../domain/enums.js";
import type { JobDefinition } from "./jobs.js";

// Runs the scheduled jobs with BullMQ, a job queue that keeps its state in
// Redis.
//
//   Queue   where jobs wait. A "job scheduler" adds a job every N ms.
//   Worker  takes a job from the queue and runs its function.
//
// Why a queue and not just setInterval in the API process?
//   - Retries: a failed job is tried again, with a growing pause in between.
//   - Several workers can run. Redis hands each job to exactly one of them.
//   - A crash loses nothing: the job is still in Redis and runs again.
//
// Redis holds only the schedule and the retry state. Nothing in it is a
// business fact; if Redis were wiped, starting the worker rebuilds it all.

export type RunnerOptions = {
  queueName: string;
  jobs: Record<string, JobDefinition>;
  redis: { host: string; port: number };
  attempts?: number; // how many times a job is tried in total
  backoffMs?: number; // first pause; it doubles after each failure
};

// Stores a job that failed on every attempt, so a person can see it.
async function recordDeadLetter(queueName: string, job: Job, error: Error) {
  await tx(SYSTEM_PRINCIPAL, async (db) => {
    await db.query(
      `INSERT INTO dead_letter_jobs (queue, job_name, payload, error, attempts)
       VALUES ($1, $2, $3, $4, $5)`,
      [queueName, job.name, JSON.stringify(job.data ?? {}), error.message, job.attemptsMade],
    );
  });
}

export async function startRunner(options: RunnerOptions) {
  const { queueName, jobs, redis } = options;
  const attempts = options.attempts ?? 3;

  const queue = new Queue(queueName, { connection: redis });

  // One scheduler per job. "upsert" = create it, or update it if it already
  // exists, so starting the worker twice does not schedule everything twice.
  for (const [name, job] of Object.entries(jobs)) {
    await queue.upsertJobScheduler(
      name,
      { every: job.everyMs },
      {
        name,
        opts: {
          attempts,
          // Exponential backoff: wait 5 s, then 10 s, then 20 s... A failing
          // dependency gets time to recover instead of being hammered.
          backoff: { type: "exponential", delay: options.backoffMs ?? 5000 },
          // Keep only the last few finished jobs in Redis.
          removeOnComplete: 50,
          removeOnFail: 50,
        },
      },
    );
  }

  const worker = new Worker(
    queueName,
    async (job) => {
      const definition = jobs[job.name];
      if (!definition) throw new Error(`Unknown job: ${job.name}`);
      // If this throws, BullMQ marks the attempt failed and schedules a
      // retry. The job is acknowledged only after the function returns, so
      // work is repeated rather than lost (at-least-once).
      return definition.run();
    },
    { connection: redis },
  );

  worker.on("completed", (job, result) => {
    logger.info({ job: job.name, result }, "job completed");
  });

  worker.on("failed", (job, error) => {
    if (!job) return;
    const lastAttempt = job.attemptsMade >= attempts;
    logger.warn({ job: job.name, attempt: job.attemptsMade, error: error.message }, "job failed");
    if (lastAttempt) {
      recordDeadLetter(queueName, job, error).catch((err) => {
        logger.error({ err }, "could not store the dead letter");
      });
    }
  });

  return {
    queue,
    worker,
    async close() {
      await worker.close();
      await queue.close();
    },
  };
}
