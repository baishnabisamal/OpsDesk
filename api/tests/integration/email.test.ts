import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import nodemailer from "nodemailer";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createRedis } from "../../src/core/redis.js";
import {
  createMailTransport,
  messageIdFor,
  replyAddressFor,
} from "../../src/services/emailService.js";
import { relayOnce } from "../../src/services/outboxRelay.js";
import {
  ensureGroup,
  runEmailConsumerOnce as runRound,
  type ConsumerOptions,
} from "../../src/workers/emailConsumer.js";
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
const mailpitUrl = inject("mailpitUrl");
const transport = createMailTransport();

let redis: Redis;
let requester: TestUser;
let booking: TestBooking;
let agent: TestUser;

beforeAll(async () => {
  redis = createRedis();
  ({ requester, booking } = await createAgencyWithRequester());
  agent = await createUser("agent");
});

afterAll(async () => {
  redis.disconnect();
  transport.close();
  await closeTestPools();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MailpitMessage = {
  ID: string;
  MessageID: string;
  To: { Address: string }[];
  ReplyTo: { Address: string }[];
  Subject: string;
};

// Every email Mailpit holds for these addresses.
async function mailsTo(addresses: string[]): Promise<MailpitMessage[]> {
  const res = await fetch(`${mailpitUrl}/api/v1/messages?limit=1000`);
  const body = (await res.json()) as { messages: MailpitMessage[] };
  return body.messages.filter((message) =>
    message.To.some((to) => addresses.includes(to.Address.toLowerCase())),
  );
}

// Unique addresses per test, so tests never count each other's emails.
function hotelAddresses(count = 2): string[] {
  const tag = randomUUID().slice(0, 8);
  return Array.from({ length: count }, (_, i) => `desk${i}.${tag}@hotel.example`);
}

// Starts a side conversation and returns its ids. Its first message is
// outbound, so its event asks for emails to every participant.
async function startThread(recipients: string[]) {
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
    .send({
      subject: "Please confirm the reservation",
      participants: recipients.map((email) => ({ email })),
      body: "Do you have this booking?",
    });
  expect(res.status).toBe(201);
  return {
    ticketId: created.body.id as string,
    conversationId: res.body.id as string,
    sideMessageId: res.body.messages[0].id as string,
  };
}

// Publishes everything waiting in the outbox. Other test files may be
// relaying at the same time; this loops until our side message is out.
async function relayAll(sideMessageId: string) {
  for (let i = 0; i < 50; i++) {
    await relayOnce(redis);
    const left = await ownerPool.query(
      "SELECT 1 FROM outbox WHERE payload->>'side_message_id' = $1 AND published_at IS NULL",
      [sideMessageId],
    );
    if (left.rowCount === 0) return;
  }
  throw new Error("the side message event was not published");
}

// A fresh consumer group per test that only sees entries from now on, so
// tests do not share pending entries.
async function newGroup(): Promise<string> {
  const group = `email-test-${randomUUID().slice(0, 8)}`;
  await ensureGroup(redis, group, "$");
  return group;
}

async function deliveries(sideMessageId: string) {
  const result = await ownerPool.query<{ recipient: string; status: string; attempts: number }>(
    "SELECT recipient, status, attempts FROM email_deliveries WHERE side_message_id = $1 ORDER BY recipient",
    [sideMessageId],
  );
  return result.rows;
}

const strip = (id: string) => id.replace(/^<|>$/g, "");

// Other test files add stream entries all the time, so a round reads
// everything that is waiting, not just the first 50.
function runEmailConsumerOnce(
  redisClient: Redis,
  mailTransport: Parameters<typeof runRound>[1],
  options: ConsumerOptions,
) {
  return runRound(redisClient, mailTransport, { count: 100_000, ...options });
}

// ---------------------------------------------------------------------------

describe("the email worker", () => {
  it("emails every participant once, with a reply address that names the thread", async () => {
    const group = await newGroup();
    const recipients = hotelAddresses(2);
    const thread = await startThread(recipients);
    await relayAll(thread.sideMessageId);

    await runEmailConsumerOnce(redis, transport, { group, consumer: "w1", blockMs: 100 });

    const mails = await mailsTo(recipients);
    expect(mails.length).toBe(2);
    for (const mail of mails) {
      expect(mail.Subject).toBe("[OpsDesk] Please confirm the reservation");
      expect(mail.ReplyTo[0]!.Address).toBe(replyAddressFor(thread.conversationId));
      const recipient = mail.To[0]!.Address.toLowerCase();
      expect(mail.MessageID).toBe(strip(messageIdFor(thread.sideMessageId, recipient)));
    }
    expect(await deliveries(thread.sideMessageId)).toEqual(
      recipients.sort().map((recipient) => ({ recipient, status: "sent", attempts: 1 })),
    );
  });

  it("the same event delivered twice still sends one email per person", async () => {
    const group = await newGroup();
    const recipients = hotelAddresses(1);
    const thread = await startThread(recipients);
    await relayAll(thread.sideMessageId);
    // The relay publishes it a second time (as after a relay crash).
    await ownerPool.query(
      "UPDATE outbox SET published_at = NULL WHERE payload->>'side_message_id' = $1",
      [thread.sideMessageId],
    );
    await relayAll(thread.sideMessageId);

    await runEmailConsumerOnce(redis, transport, { group, consumer: "w1", blockMs: 100 });

    expect((await mailsTo(recipients)).length).toBe(1);
  });

  // Phase 4 gate: a killed and retried email job sends once.
  it("a worker killed after sending, before acknowledging, is retried and sends nothing more", async () => {
    const group = await newGroup();
    const recipients = hotelAddresses(2);
    const thread = await startThread(recipients);
    await relayAll(thread.sideMessageId);

    // Worker 1 reads the entry and delivers, then "dies" before XACK: we
    // read the entry into worker 1's pending list and deliver by hand
    // without acknowledging.
    const read = (await redis.xreadgroup(
      "GROUP",
      group,
      "w1",
      "COUNT",
      100,
      "STREAMS",
      "opsdesk:events",
      ">",
    )) as [string, [string, string[]][]][];
    expect(read[0]![1].length).toBeGreaterThan(0);
    const { deliverSideMessage } = await import("../../src/services/emailService.js");
    await deliverSideMessage(transport, thread.sideMessageId);
    expect((await mailsTo(recipients)).length).toBe(2);

    // Worker 2 takes over everything worker 1 left pending (minIdleMs 0 =
    // no waiting, for the test) and handles it again.
    const result = await runEmailConsumerOnce(redis, transport, {
      group,
      consumer: "w2",
      blockMs: 100,
      minIdleMs: 0,
    });
    expect(result.handled).toBeGreaterThan(0);

    // Still exactly one email each, and nothing left pending.
    expect((await mailsTo(recipients)).length).toBe(2);
    const pending = (await redis.xpending("opsdesk:events", group)) as [number];
    expect(pending[0]).toBe(0);
  });

  it("the one window that cannot be closed: killed between sending and recording", async () => {
    const group = await newGroup();
    const recipients = hotelAddresses(1);
    const thread = await startThread(recipients);
    await relayAll(thread.sideMessageId);

    // The mail server accepts the email, then the worker dies before step 3.
    const crashed = await runEmailConsumerOnce(redis, transport, {
      group,
      consumer: "w1",
      blockMs: 100,
      delivery: { crashAfterSend: true },
    });
    expect(crashed.failed).toBeGreaterThan(0);
    expect(await deliveries(thread.sideMessageId)).toMatchObject([{ status: "sending" }]);

    // While the lease is fresh, a retry does NOT send again, and it does not
    // acknowledge the entry either: it is not finished.
    const early = await runEmailConsumerOnce(redis, transport, {
      group,
      consumer: "w2",
      blockMs: 100,
      minIdleMs: 0,
    });
    expect(early.inProgress).toBeGreaterThan(0);
    expect((await mailsTo(recipients)).length).toBe(1);
    const stillPending = (await redis.xpending("opsdesk:events", group)) as [number];
    expect(stillPending[0]).toBeGreaterThan(0);

    // ...but once the lease runs out, it must assume the email may not have
    // gone and sends again. With the SAME Message-ID, so the receiving mail
    // client can tell it is a repeat.
    await ownerPool.query(
      "UPDATE email_deliveries SET claimed_at = now() - interval '2 minutes' WHERE side_message_id = $1",
      [thread.sideMessageId],
    );
    await runEmailConsumerOnce(redis, transport, {
      group,
      consumer: "w2",
      blockMs: 100,
      minIdleMs: 0,
    });

    const mails = await mailsTo(recipients);
    expect(mails.length).toBe(2);
    expect(mails[0]!.MessageID).toBe(mails[1]!.MessageID);
    expect(await deliveries(thread.sideMessageId)).toMatchObject([{ status: "sent", attempts: 2 }]);
  });

  // Hazard 11 in README section 9.
  it("two workers delivering the same message at once send it once", async () => {
    const recipients = hotelAddresses(3);
    const thread = await startThread(recipients);
    const { deliverSideMessage } = await import("../../src/services/emailService.js");

    const [one, two] = await Promise.all([
      deliverSideMessage(transport, thread.sideMessageId),
      deliverSideMessage(transport, thread.sideMessageId),
    ]);

    // Each email was sent by exactly one of them; the other one found it
    // claimed (in progress) or already sent.
    expect(one.sent + two.sent).toBe(3);
    expect(one.skipped + two.skipped + one.inProgress + two.inProgress).toBe(3);
    expect((await mailsTo(recipients)).length).toBe(3);
  });

  it("an inbound message is never emailed", async () => {
    const recipients = hotelAddresses(1);
    const thread = await startThread(recipients);
    const inbound = await ownerPool.query<{ id: string }>(
      `INSERT INTO side_messages (side_conversation_id, ticket_id, direction, from_email, body)
       VALUES ($1, $2, 'inbound', $3, 'Yes, we have it.') RETURNING id`,
      [thread.conversationId, thread.ticketId, recipients[0]],
    );
    const { deliverSideMessage } = await import("../../src/services/emailService.js");

    expect(await deliverSideMessage(transport, inbound.rows[0]!.id)).toEqual({
      sent: 0,
      skipped: 0,
      inProgress: 0,
    });
  });

  it("when the mail server is down it retries, then stores a dead letter", async () => {
    const group = await newGroup();
    const recipients = hotelAddresses(1);
    const thread = await startThread(recipients);
    await relayAll(thread.sideMessageId);

    // A transport pointing at a port where nothing listens.
    const broken = nodemailer.createTransport({
      host: "127.0.0.1",
      port: 9,
      connectionTimeout: 500,
    });
    const options = { group, consumer: "w1", blockMs: 100, minIdleMs: 0, maxDeliveries: 3 };

    const first = await runEmailConsumerOnce(redis, broken, options);
    expect(first.failed).toBeGreaterThan(0);
    expect(first.deadLettered).toBe(0); // not yet: it will be retried

    let deadLettered = 0;
    for (let i = 0; i < 4 && deadLettered === 0; i++) {
      deadLettered = (await runEmailConsumerOnce(redis, broken, options)).deadLettered;
    }
    expect(deadLettered).toBeGreaterThan(0);

    const letters = await ownerPool.query<{ payload: Record<string, string>; attempts: number }>(
      "SELECT payload, attempts FROM dead_letter_jobs WHERE queue = 'email' AND payload->>'side_message_id' = $1",
      [thread.sideMessageId],
    );
    expect(letters.rows.length).toBe(1);
    expect(letters.rows[0]!.attempts).toBe(3);
    expect((await mailsTo(recipients)).length).toBe(0);
    broken.close();
  });
});
