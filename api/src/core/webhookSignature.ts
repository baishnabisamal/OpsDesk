import { createHmac, timingSafeEqual } from "node:crypto";

// Signing and checking inbound webhooks. No I/O.
//
// The sender (the mail provider) and OpsDesk share a secret. For every
// request the sender computes
//
//     HMAC-SHA256(secret, "<timestamp>.<raw body>")
//
// and sends it with the timestamp in two headers. HMAC is a "keyed hash":
// without the secret nobody can produce the right value, and changing a
// single byte of the body or the timestamp gives a completely different one.
//
// The timestamp is part of what is signed, and must be recent. Otherwise
// someone who once captured a valid request could send it again (a replay)
// days later.

export const SIGNATURE_HEADER = "x-opsdesk-signature";
export const TIMESTAMP_HEADER = "x-opsdesk-timestamp";
export const TOLERANCE_SECONDS = 300; // 5 minutes either way

export function sign(secret: string, timestamp: string, rawBody: Buffer | string): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(`${timestamp}.`);
  hmac.update(rawBody);
  return `v1=${hmac.digest("hex")}`;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export function verify(input: {
  secret: string;
  rawBody: Buffer;
  timestamp: string | undefined;
  signature: string | undefined;
  nowSeconds: number;
}): VerifyResult {
  if (!input.timestamp || !input.signature) {
    return { ok: false, reason: "missing signature headers" };
  }
  if (!/^\d{1,12}$/.test(input.timestamp)) {
    return { ok: false, reason: "bad timestamp" };
  }
  if (Math.abs(input.nowSeconds - Number(input.timestamp)) > TOLERANCE_SECONDS) {
    return { ok: false, reason: "timestamp too old or in the future" };
  }

  const expected = Buffer.from(sign(input.secret, input.timestamp, input.rawBody));
  const given = Buffer.from(input.signature);
  // timingSafeEqual takes the same time however many leading characters
  // match. A normal comparison stops at the first difference, and measuring
  // how long it took would let an attacker guess the signature character by
  // character. It needs equal lengths, so that is checked first (the length
  // of a valid signature is no secret).
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "signature does not match" };
  }
  return { ok: true };
}
