import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { config } from "../../src/core/config.js";
import { containsNul } from "../../src/core/rejectNul.js";
import { sign } from "../../src/core/webhookSignature.js";
import {
  bearer,
  closeTestPools,
  createAgencyWithRequester,
  createUser,
  type TestBooking,
  type TestUser,
} from "./helpers.js";

// Regression tests for the bugs Schemathesis found (make contract): text
// containing a NUL character crashed every endpoint that saves text with a
// 500, because PostgreSQL cannot store NUL.

const app = createApp();
let requester: TestUser;
let booking: TestBooking;
let agent: TestUser;
let ticketId: string;

beforeAll(async () => {
  ({ requester, booking } = await createAgencyWithRequester());
  agent = await createUser("agent");
  const created = await request(app)
    .post("/api/v1/tickets")
    .set(bearer(requester))
    .set("Idempotency-Key", randomUUID())
    .send({ tboh: booking.tboh, subject: "Refund not received", body: "Please check." });
  ticketId = created.body.id;
});

afterAll(closeTestPools);

describe("text with NUL characters", () => {
  it("a message is refused with 400, not 500", async () => {
    const res = await request(app)
      .post(`/api/v1/tickets/${ticketId}/messages`)
      .set(bearer(requester))
      .send({ body: "hello\u0000world" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_characters");
  });

  it("a ticket, a supplier thread and a search are refused too", async () => {
    const ticket = await request(app)
      .post("/api/v1/tickets")
      .set(bearer(requester))
      .set("Idempotency-Key", randomUUID())
      .send({ tboh: booking.tboh, subject: "a\u0000b", body: "x" });
    const thread = await request(app)
      .post(`/api/v1/tickets/${ticketId}/side-conversations`)
      .set(bearer(agent))
      .send({ subject: "Hi", participants: [{ email: "a@b.example", name: "\u0000" }], body: "x" });
    const search = await request(app)
      .get("/api/v1/tickets")
      .query({ q: "refund\u0000" })
      .set(bearer(requester));

    for (const res of [ticket, thread, search]) {
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invalid_characters");
    }
  });

  it("the signed webhook refuses it as well", async () => {
    const raw = JSON.stringify({
      provider_message_id: `p-${randomUUID()}`,
      from: "a@b.example",
      to: "reply+x@inbound.opsdesk.local",
      text: "bad\u0000text",
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const res = await request(app)
      .post("/api/v1/inbound/email")
      .set("Content-Type", "application/json")
      .set("X-OpsDesk-Timestamp", timestamp)
      .set("X-OpsDesk-Signature", sign(config.inboundWebhookSecret, timestamp, raw))
      .send(raw);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_characters");
  });

  it("other unusual characters are still accepted", async () => {
    const res = await request(app)
      .post(`/api/v1/tickets/${ticketId}/messages`)
      .set(bearer(requester))
      .send({ body: "Ünïcödé ✓ 😀 \u0019 tab\there" });
    expect(res.status).toBe(201);
  });

  it("containsNul looks inside nested objects, arrays and keys", () => {
    expect(containsNul({ a: [{ b: "x\u0000" }] })).toBe(true);
    expect(containsNul({ ["k\u0000"]: 1 })).toBe(true);
    expect(containsNul({ a: ["fine", 1, null] })).toBe(false);
  });
});

describe("bodies the parser refuses", () => {
  it("a body over the size limit is a 413, not a 500", async () => {
    // Schemathesis sent 20,000 characters written as \uXXXX escapes: valid
    // for the schema, but about 240 KB on the wire, over the 100 KB limit.
    const huge = JSON.stringify({ body: "\\ud83d\\ude00".repeat(20_000) }).replaceAll("\\\\", "\\");
    const res = await request(app)
      .post(`/api/v1/tickets/${ticketId}/messages`)
      .set(bearer(requester))
      .set("Content-Type", "application/json")
      .send(huge);
    expect(res.status).toBe(413);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(res.body.code).toBe("entity_too_large");
  });

  it("an unsupported body encoding is a 415", async () => {
    const res = await request(app)
      .post(`/api/v1/tickets/${ticketId}/messages`)
      .set(bearer(requester))
      .set("Content-Type", "application/json")
      .set("Content-Encoding", "made-up")
      .send('{"body":"hi"}');
    expect(res.status).toBe(415);
    expect(res.body.code).toBe("encoding_unsupported");
  });
});
