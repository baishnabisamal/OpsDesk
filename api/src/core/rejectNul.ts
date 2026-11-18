import type { NextFunction, Request, Response } from "express";
import { badRequest } from "./errors.js";

// Rejects text containing the NUL character (U+0000).
//
// JSON may carry "\u0000" inside a string, and Zod happily accepts it, but
// PostgreSQL cannot store NUL in a text column: the insert fails with error
// 22021. Schemathesis found this: such a request crashed with a 500 on every
// endpoint that saves text. No real user needs a NUL in a ticket, so it is
// refused at the edge with a clear 400.

export function containsNul(value: unknown): boolean {
  if (typeof value === "string") return value.includes("\u0000");
  if (Array.isArray(value)) return value.some(containsNul);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(([key, inner]) => containsNul(key) || containsNul(inner));
  }
  return false;
}

export function invalidCharacters() {
  return Object.assign(badRequest("Text must not contain NUL characters (U+0000)."), {
    code: "invalid_characters",
  });
}

export function rejectNul(req: Request, _res: Response, next: NextFunction) {
  if (containsNul(req.body) || containsNul(req.query) || containsNul(req.params)) {
    next(invalidCharacters());
    return;
  }
  next();
}
