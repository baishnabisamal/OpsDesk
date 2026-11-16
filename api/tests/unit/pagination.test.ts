import { describe, expect, it } from "vitest";
import { AppError } from "../../src/core/errors.js";
import { decodeCursor, encodeCursor } from "../../src/core/pagination.js";

describe("cursor", () => {
  const cursor = {
    createdAt: "2026-11-16 10:15:30.123456+00",
    id: "7b0c6f0e-3a57-4a43-9d4b-0c5a4a0f6b11",
  };

  it("survives a round trip, keeping microseconds", () => {
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("is safe to put in a URL", () => {
    expect(encodeCursor(cursor)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ["random text", "garbage"],
    ["valid base64 but not JSON", Buffer.from("hello").toString("base64url")],
    ["JSON of the wrong shape", Buffer.from('{"a":1}').toString("base64url")],
    ["a bad date", Buffer.from(`["not a date","${cursor.id}"]`).toString("base64url")],
    ["a bad id", Buffer.from(`["${cursor.createdAt}","1; DROP TABLE"]`).toString("base64url")],
  ])("rejects %s with a 400", (_name, value) => {
    try {
      decodeCursor(value);
      expect.unreachable("decodeCursor should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).status).toBe(400);
    }
  });
});
