import { Router } from "express";
import { pingDatabase } from "../db/pool.js";

export const healthRouter = Router();

// Liveness: the process is running and can answer.
healthRouter.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

// Readiness: the process can do real work, which needs PostgreSQL.
healthRouter.get("/readyz", async (_req, res) => {
  const postgresOk = await pingDatabase();
  res.status(postgresOk ? 200 : 503).json({
    status: postgresOk ? "ready" : "not_ready",
    checks: { postgres: postgresOk ? "ok" : "down" },
  });
});
