import express from "express";
import { errorHandler, notFoundHandler } from "./core/errors.js";
import { requestLogger } from "./core/logger.js";
import { authRouter } from "./routes/auth.js";
import { healthRouter } from "./routes/health.js";

// Builds the Express app without starting a server, so tests can use it
// directly with Supertest.
export function createApp() {
  const app = express();

  app.use(requestLogger);
  app.use(express.json({ limit: "100kb" }));

  app.use(healthRouter);
  app.use("/api/v1/auth", authRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
