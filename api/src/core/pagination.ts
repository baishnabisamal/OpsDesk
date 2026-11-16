import { badRequest } from "./errors.js";

// Keyset pagination: instead of "skip N rows" (OFFSET), the client sends back
// the sort values of the last row it saw, and the next query starts right
// after that row. It stays fast on page 1000, and rows added or removed
// between pages cannot cause repeats or gaps.
//
// A cursor holds the two sort values, (created_at, id). created_at is kept as
// PostgreSQL's own text, because a JavaScript Date only has milliseconds while
// PostgreSQL stores microseconds; rounding would make the cursor point at the
// wrong place.

export type Cursor = { createdAt: string; id: string };

// base64url only makes the cursor opaque and URL-safe. It is not secret.
export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.id])).toString("base64url");
}

export function decodeCursor(value: string): Cursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string" &&
      !Number.isNaN(Date.parse(parsed[0])) &&
      /^[0-9a-f-]{36}$/i.test(parsed[1])
    ) {
      return { createdAt: parsed[0], id: parsed[1] };
    }
  } catch {
    // fall through to the error below
  }
  throw badRequest("The cursor is not valid.");
}
