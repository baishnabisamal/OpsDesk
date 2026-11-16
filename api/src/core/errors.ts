import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { logger } from "./logger.js";

// One error class for everything the API rejects on purpose.
// The error handler turns it into an RFC 9457 problem+json response.
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    public title: string,
    public detail?: string,
    public errors?: { field: string; message: string }[],
  ) {
    super(detail ?? title);
  }
}

// Small helpers so services read like `throw notFound()`.
export const badRequest = (detail: string, errors?: { field: string; message: string }[]) =>
  new AppError(400, "bad_request", "Bad request", detail, errors);

export const unauthorized = (detail = "Log in and send a valid access token.") =>
  new AppError(401, "unauthorized", "Unauthorized", detail);

export const forbidden = (detail = "Your role may not do this.") =>
  new AppError(403, "forbidden", "Forbidden", detail);

// Used both for "does not exist" and "exists but you may not see it",
// so ids cannot be probed.
export const notFound = (detail = "The resource was not found.") =>
  new AppError(404, "not_found", "Not found", detail);

export const conflict = (code: string, detail: string) =>
  new AppError(409, code, "Conflict", detail);

export const unprocessable = (code: string, detail: string) =>
  new AppError(422, code, "Unprocessable content", detail);

export const preconditionRequired = (detail: string) =>
  new AppError(428, "precondition_required", "Precondition required", detail);

// PostgreSQL error codes we expect, mapped to HTTP errors (README 8.4).
function fromDatabaseError(err: unknown): AppError | null {
  if (typeof err !== "object" || err === null || !("code" in err)) return null;
  switch (err.code) {
    case "23505": // unique_violation
      return conflict("duplicate", "A record with the same unique value already exists.");
    case "23503": // foreign_key_violation
      return unprocessable(
        "invalid_reference",
        "The request refers to a record that does not exist.",
      );
    case "23514": // check_violation
      return unprocessable("rule_violation", "The change breaks a data rule.");
    default:
      return null;
  }
}

function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;

  if (err instanceof ZodError) {
    const errors = err.issues.map((issue) => ({
      field: issue.path.join("."),
      message: issue.message,
    }));
    return badRequest("The request is not valid.", errors);
  }

  // express.json() throws this when the body is not valid JSON.
  if (err instanceof SyntaxError && "body" in err) {
    return badRequest("The request body is not valid JSON.");
  }

  const dbError = fromDatabaseError(err);
  if (dbError) return dbError;

  return new AppError(500, "internal_error", "Internal server error");
}

// Runs when no route matched.
export function notFoundHandler(_req: Request, _res: Response, next: NextFunction) {
  next(notFound("No such route."));
}

// Express knows this is an error handler because it has four parameters.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  void _next;
  const appError = toAppError(err);
  const requestId = res.locals.requestId as string | undefined;

  if (appError.status >= 500) {
    // Log the real error, but never send its details to the client.
    logger.error({ err, requestId, path: req.path }, "unhandled error");
  }

  res
    .status(appError.status)
    .type("application/problem+json")
    .json({
      type: `https://opsdesk.dev/problems/${appError.code.replaceAll("_", "-")}`,
      title: appError.title,
      status: appError.status,
      code: appError.code,
      detail: appError.detail,
      errors: appError.errors,
      request_id: requestId,
    });
}
