import { describe, expect, it } from "vitest";
import { sign, TOLERANCE_SECONDS, verify } from "../../src/core/webhookSignature.js";

const SECRET = "a-shared-secret-that-is-long-enough-123";
const NOW = 1_800_000_000;
const BODY = Buffer.from('{"provider_message_id":"abc","text":"Yes, we have it."}');

function check(overrides: Partial<Parameters<typeof verify>[0]> = {}) {
  const timestamp = String(NOW);
  return verify({
    secret: SECRET,
    rawBody: BODY,
    timestamp,
    signature: sign(SECRET, timestamp, BODY),
    nowSeconds: NOW,
    ...overrides,
  });
}

describe("webhook signatures", () => {
  it("accepts a correctly signed, fresh request", () => {
    expect(check()).toEqual({ ok: true });
  });

  it("signatures look like v1=<64 hex characters>", () => {
    expect(sign(SECRET, "1", BODY)).toMatch(/^v1=[0-9a-f]{64}$/);
  });

  it("rejects a changed body", () => {
    const tampered = Buffer.from(BODY.toString().replace("Yes", "No"));
    expect(check({ rawBody: tampered })).toEqual({ ok: false, reason: "signature does not match" });
  });

  it("rejects a signature made with another secret", () => {
    const forged = sign("not-the-secret", String(NOW), BODY);
    expect(check({ signature: forged }).ok).toBe(false);
  });

  it("rejects a changed timestamp, because it is part of what is signed", () => {
    expect(check({ timestamp: String(NOW - 10) }).ok).toBe(false);
  });

  it("rejects an old request (a replay) and one from the future", () => {
    const old = String(NOW - TOLERANCE_SECONDS - 1);
    const future = String(NOW + TOLERANCE_SECONDS + 1);
    expect(check({ timestamp: old, signature: sign(SECRET, old, BODY) })).toEqual({
      ok: false,
      reason: "timestamp too old or in the future",
    });
    expect(check({ timestamp: future, signature: sign(SECRET, future, BODY) }).ok).toBe(false);
  });

  it("accepts the edge of the tolerance window", () => {
    const edge = String(NOW - TOLERANCE_SECONDS);
    expect(check({ timestamp: edge, signature: sign(SECRET, edge, BODY) }).ok).toBe(true);
  });

  it("rejects missing headers, garbage and a truncated signature without crashing", () => {
    expect(check({ signature: undefined }).ok).toBe(false);
    expect(check({ timestamp: undefined }).ok).toBe(false);
    expect(check({ timestamp: "yesterday" }).ok).toBe(false);
    expect(check({ signature: "v1=abc" }).ok).toBe(false);
    expect(check({ signature: "" }).ok).toBe(false);
  });
});
