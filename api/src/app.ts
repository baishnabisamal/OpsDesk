import express from "express";
import { errorHandler, notFoundHandler } from "./core/errors.js";
import { requestLogger } from "./core/logger.js";
import { apiRules, createLimiterRedis, createRateLimiter } from "./core/rateLimit.js";
import { authRouter } from "./routes/auth.js";
import { casesRouter } from "./routes/cases.js";
import { exportsRouter } from "./routes/exports.js";
import { healthRouter } from "./routes/health.js";
import { inboundRouter } from "./routes/inbound.js";
import { insightsRouter } from "./routes/insights.js";
import { meRouter } from "./routes/me.js";
import { queuesRouter } from "./routes/queues.js";
import { sideConversationsRouter } from "./routes/sideConversations.js";
import { ticketsRouter } from "./routes/tickets.js";

// One Redis connection for the rate limiter, shared by every app built in
// this process (tests build many).
let sharedLimiterRedis: ReturnType<typeof createLimiterRedis> | undefined;
function limiterRedis() {
  sharedLimiterRedis ??= createLimiterRedis();
  return sharedLimiterRedis;
}

// Builds the Express app without starting a server, so tests can use it
// directly with Supertest.
export function createApp() {
  const app = express();

  app.use(requestLogger);
  // Before express.json on purpose: the webhook must see the raw bytes.
  app.use("/api/v1/inbound", inboundRouter);
  app.use(express.json({ limit: "100kb" }));
  // One shared limiter for every /api/v1 route (not the webhook above: the
  // mail provider is limited by the signature, not by a user).
  app.use("/api/v1", createRateLimiter(limiterRedis(), apiRules()));

  app.use(healthRouter);
  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1/tickets", ticketsRouter);
  app.use("/api/v1/cases", casesRouter);
  app.use("/api/v1/me", meRouter);
  app.use("/api/v1/queues", queuesRouter);
  app.use("/api/v1/side-conversations", sideConversationsRouter);
  app.use("/api/v1/insights", insightsRouter);
  app.use("/api/v1/exports", exportsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
