import { Router } from "express";
import { renderMetrics } from "../core/metrics.js";
import { createLimiterRedis } from "../core/rateLimit.js";
import { pingDatabase } from "../db/pool.js";

export const healthRouter = Router();

// Liveness: the process is running and can answer.
healthRouter.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

// A fail-fast Redis connection just for the readiness check.
let redis: ReturnType<typeof createLimiterRedis> | undefined;

async function pingRedis(): Promise<boolean> {
  redis ??= createLimiterRedis();
  try {
    return (await redis.ping()) === "PONG";
  } catch {
    return false;
  }
}

// Readiness: can the process do real work?
//   PostgreSQL is REQUIRED: without it nothing works, so the answer is 503.
//   Redis is reported but not required: without it tickets are still created
//   and events wait in the outbox, so the answer is 200 with "degraded".
healthRouter.get("/readyz", async (_req, res) => {
  const [postgresOk, redisOk] = await Promise.all([pingDatabase(), pingRedis()]);
  const status = !postgresOk ? "not_ready" : redisOk ? "ready" : "degraded";
  res.status(postgresOk ? 200 : 503).json({
    status,
    checks: { postgres: postgresOk ? "ok" : "down", redis: redisOk ? "ok" : "down" },
  });
});

// Prometheus metrics (core/metrics.ts). Meant for the internal network only:
// in a deployment this path is not exposed to the internet.
healthRouter.get("/metrics", async (_req, res) => {
  const metrics = await renderMetrics();
  res.type(metrics.contentType).send(metrics.body);
});
