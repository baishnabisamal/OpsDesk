import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { config } from "../../src/core/config.js";
import { sign } from "../../src/core/webhookSignature.js";
import { replyAddressFor } from "../../src/services/emailService.js";
import {
  bearer,
  closeTestPools,
  createAgencyWithRequester,
  createUser,
  ownerPool,
  type TestBooking,
  type TestUser,
} from "./helpers.js";

const app = createApp();

let requester: TestUser;
let booking: TestBooking;
let agent: TestUser;

beforeAll(async () => {
  ({ requester, booking } = await createAgencyWithRequester());
  agent = await createUser("agent");
});

afterAll(closeTestPools);

const HOTEL = "reservations@hotel-lindenhof.example";

async function startThread(): Promise<{ conversationId: string; ticketId: string }> {
  const created = await request(app)
    .post("/api/v1/tickets")
    .set(bearer(requester))
    .set("Idempotency-Key", randomUUID())
    .send({
      tboh: booking.tboh,
      subject: "Booking not found at hotel",
      body: "Guest at reception.",
    });
  const res = await request(app)
    .post(`/api/v1/tickets/${created.body.id}/side-conversations`)
    .set(bearer(agent))
    .send({ subject: "Please confirm", participants: [{ email: HOTEL }], body: "Do you have it?" });
  expect(res.status).toBe(201);
  return { conversationId: res.body.id, ticketId: created.body.id };
}

type Email = {
  provider_message_id: string;
  from: string;
  to: string;
  subject: string;
  text: string;
};

function replyTo(conversationId: string, overrides: Partial<Email> = {}): Email {
  return {
    provider_message_id: `prov-${randomUUID()}`,
    from: "Reservations@Hotel-Lindenhof.example",
    to: replyAddressFor(conversationId),
    subject: "Re: Please confirm",
    text: "Yes, we have the reservation.",
    ...overrides,
  };
}

// Posts like the mail provider does: raw JSON, signed.
function post(
  email: object | string,
  options: { secret?: string; timestamp?: number; signature?: string } = {},
) {
  const raw = typeof email === "string" ? email : JSON.stringify(email);
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const signature =
    options.signature ?? sign(options.secret ?? config.inboundWebhookSecret, timestamp, raw);
  return request(app)
    .post("/api/v1/inbound/email")
    .set("Content-Type", "application/json")
    .set("X-OpsDesk-Timestamp", timestamp)
    .set("X-OpsDesk-Signature", signature)
    .send(raw);
}

async function threadMessages(conversationId: string) {
  const res = await request(app)
    .get(`/api/v1/side-conversations/${conversationId}`)
    .set(bearer(agent));
  return res.body.messages as { direction: string; from_email: string | null; body: string }[];
}

describe("POST /inbound/email", () => {
  it("a signed reply from a participant lands in its thread", async () => {
    const { conversationId, ticketId } = await startThread();
    const res = await post(replyTo(conversationId));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "accepted", side_message_id: expect.any(String) });

    const messages = await threadMessages(conversationId);
    expect(messages[1]).toMatchObject({
      direction: "inbound",
      from_email: HOTEL, // lower-cased
      body: "Yes, we have the reservation.",
    });

    // The reply is announced like every change: timeline event and outbox row.
    const outbox = await ownerPool.query(
      `SELECT 1 FROM outbox WHERE ticket_id = $1 AND event_type = 'side_message.created'
          AND payload->>'direction' = 'inbound'`,
      [ticketId],
    );
    expect(outbox.rowCount).toBe(1);
  });

  // Hazard 12 in README section 9.
  it("the same email posted twice adds one message", async () => {
    const { conversationId } = await startThread();
    const email = replyTo(conversationId);

    const first = await post(email);
    const second = await post(email);
    expect(first.body.status).toBe("accepted");
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ status: "duplicate" });
    expect((await threadMessages(conversationId)).length).toBe(2);
  });

  it("the same email posted five times at once adds one message", async () => {
    const { conversationId } = await startThread();
    const email = replyTo(conversationId);

    const results = await Promise.all(Array.from({ length: 5 }, () => post(email)));
    const statuses = results.map((res) => res.body.status).sort();
    expect(statuses).toEqual(["accepted", "duplicate", "duplicate", "duplicate", "duplicate"]);
    expect((await threadMessages(conversationId)).length).toBe(2);
  });

  // Phase 4 gate: a bad signature is rejected.
  it("rejects a bad signature, a changed body, and a missing signature with 401", async () => {
    const { conversationId } = await startThread();
    const email = replyTo(conversationId);

    const wrongSecret = await post(email, { secret: "not-the-shared-secret-at-all-0123456789" });
    expect(wrongSecret.status).toBe(401);
    expect(wrongSecret.body.code).toBe("invalid_signature");

    // Signed for one body, sent with another.
    const timestamp = Math.floor(Date.now() / 1000);
    const goodSignature = sign(
      config.inboundWebhookSecret,
      String(timestamp),
      JSON.stringify(email),
    );
    const tampered = await post(
      { ...email, text: "Cancel everything." },
      { timestamp, signature: goodSignature },
    );
    expect(tampered.status).toBe(401);

    const unsigned = await request(app)
      .post("/api/v1/inbound/email")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(email));
    expect(unsigned.status).toBe(401);

    // Nothing reached the thread.
    expect((await threadMessages(conversationId)).length).toBe(1);
  });

  it("rejects a replayed request with an old timestamp", async () => {
    const { conversationId } = await startThread();
    const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
    const res = await post(replyTo(conversationId), { timestamp: tenMinutesAgo });
    expect(res.status).toBe(401);
    expect(res.body.detail).toBe("timestamp too old or in the future");
  });

  it("quarantines what it cannot place, with the reason, and still answers 200", async () => {
    const { conversationId } = await startThread();

    const stranger = await post(replyTo(conversationId, { from: "someone@elsewhere.example" }));
    const noThread = await post(replyTo(randomUUID()));
    const notReply = await post(replyTo(conversationId, { to: "support@opsdesk.local" }));

    expect(stranger.body).toEqual({ status: "quarantined", reason: "sender is not a participant" });
    expect(noThread.body).toEqual({ status: "quarantined", reason: "unknown side conversation" });
    expect(notReply.body).toEqual({ status: "quarantined", reason: "not a reply address" });
    expect((await threadMessages(conversationId)).length).toBe(1);

    // Kept for a person to look at.
    const kept = await ownerPool.query(
      "SELECT 1 FROM inbound_emails WHERE status = 'quarantined' AND from_email = 'someone@elsewhere.example'",
    );
    expect(kept.rowCount).toBeGreaterThanOrEqual(1);
  });

  it("a correctly signed body that is not valid JSON or misses fields is a 400", async () => {
    expect((await post("{not json")).status).toBe(400);
    expect((await post({ provider_message_id: "x" })).status).toBe(400);
  });

  it("is not reachable through the normal login: it needs no token, only the signature", async () => {
    const { conversationId } = await startThread();
    const res = await post(replyTo(conversationId));
    expect(res.status).toBe(200);
  });
});
