import express from "express";
import { errorHandler, notFoundHandler } from "./core/errors.js";
import { requestLogger } from "./core/logger.js";
import { authRouter } from "./routes/auth.js";
import { casesRouter } from "./routes/cases.js";
import { healthRouter } from "./routes/health.js";
import { meRouter } from "./routes/me.js";
import { queuesRouter } from "./routes/queues.js";
import { sideConversationsRouter } from "./routes/sideConversations.js";
import { ticketsRouter } from "./routes/tickets.js";

// Builds the Express app without starting a server, so tests can use it
// directly with Supertest.
export function createApp() {
  const app = express();

  app.use(requestLogger);
  app.use(express.json({ limit: "100kb" }));

  app.use(healthRouter);
  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1/tickets", ticketsRouter);
  app.use("/api/v1/cases", casesRouter);
  app.use("/api/v1/me", meRouter);
  app.use("/api/v1/queues", queuesRouter);
  app.use("/api/v1/side-conversations", sideConversationsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
