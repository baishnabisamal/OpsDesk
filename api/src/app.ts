import express from "express";
import { config } from "./core/config.js";
import { errorHandler, notFoundHandler } from "./core/errors.js";
import { requestLogger } from "./core/logger.js";
import { metricsMiddleware } from "./core/metrics.js";
import { rejectNul } from "./core/rejectNul.js";
import { apiRules, createLimiterRedis, createRateLimiter } from "./core/rateLimit.js";
import { authRouter } from "./routes/auth.js";
import { casesRouter } from "./routes/cases.js";
import { exportsRouter } from "./routes/exports.js";
import { buildOpenApiDocument } from "./openapi.js";
import { healthRouter } from "./routes/health.js";
import { inboundRouter } from "./routes/inbound.js";
import { insightsRouter } from "./routes/insights.js";
import { meRouter } from "./routes/me.js";
import { queuesRouter } from "./routes/queues.js";
import { sideConversationsRouter } from "./routes/sideConversations.js";
import { staffRouter } from "./routes/staff.js";
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
  // Behind the deployment's proxy, req.ip must be the visitor, not the proxy
  // (see TRUST_PROXY in core/config.ts). 0 locally: the header is ignored.
  app.set("trust proxy", config.trustProxy);

  app.use(requestLogger);
  app.use(metricsMiddleware);
  // Before express.json on purpose: the webhook must see the raw bytes.
  app.use("/api/v1/inbound", inboundRouter);
  app.use(express.json({ limit: "100kb" }));
  // Text with NUL characters cannot be stored by PostgreSQL (core/rejectNul.ts).
  app.use(rejectNul);
  // One shared limiter for every /api/v1 route (not the webhook above: the
  // mail provider is limited by the signature, not by a user).
  app.use("/api/v1", createRateLimiter(limiterRedis(), apiRules()));

  app.use(healthRouter);
  // The API's own description, generated from the Zod schemas (openapi.ts).
  const openApiDocument = buildOpenApiDocument();
  app.get("/openapi.json", (_req, res) => {
    res.json(openApiDocument);
  });
  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1/tickets", ticketsRouter);
  app.use("/api/v1/cases", casesRouter);
  app.use("/api/v1/me", meRouter);
  app.use("/api/v1/queues", queuesRouter);
  app.use("/api/v1/staff", staffRouter);
  app.use("/api/v1/side-conversations", sideConversationsRouter);
  app.use("/api/v1/insights", insightsRouter);
  app.use("/api/v1/exports", exportsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
