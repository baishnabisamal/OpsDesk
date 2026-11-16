import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { pino } from "pino";
import { config } from "./config.js";

export const logger = pino({ level: config.logLevel });

// Gives every request an id, returns it in X-Request-Id, and writes one log
// line when the response is finished. Bodies and tokens are never logged.
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const requestId = `req_${randomUUID().slice(0, 8)}`;
  res.locals.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);

  const startedAt = Date.now();
  res.on("finish", () => {
    logger.info({
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
    });
  });

  next();
}
