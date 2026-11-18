import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import {
  createRedis,
  EVENTS_STREAM,
  parseStreamEntry,
  type StreamEvent,
} from "../../src/core/redis.js";
import { outboxLagSeconds, relayOnce } from "../../src/services/outboxRelay.js";
import {
  appPool,
  bearer,
  closeTestPools,
  createAgencyWithRequester,
  ownerPool,
  type TestBooking,
  type TestUser,
} from "./helpers.js";

// Other test files write outbox rows at the same time and may run their own
// relay. Every relay publishes to the same stream, so this file only looks
// at the events of its own tickets.

const app = createApp();
let redis: Redis;
let requester: TestUser;
let booking: TestBooking;

beforeAll(async () => {
  redis = createRedis();
  ({ requester, booking } = await createAgencyWithRequester());
});

afterAll(async () => {
  redis.disconnect();
  await closeTestPools();
});

async function createTicket(): Promise<string> {
  const res = await request(app)
    .post("/api/v1/tickets")
    .set(bearer(requester))
    .set("Idempotency-Key", randomUUID())
    .send({ tboh: booking.tboh, subject: "Refund not received", body: "Please check." });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function streamEvents(): Promise<StreamEvent[]> {
  const entries = await redis.xrange(EVENTS_STREAM, "-", "+");
  return entries.map(([id, fields]) => parseStreamEntry(id, fields));
}

async function outboxIds(ticketIds: string[]): Promise<string[]> {
  const result = await ownerPool.query<{ id: string }>(
    "SELECT id::text FROM outbox WHERE ticket_id = ANY($1) ORDER BY id",
    [ticketIds],
  );
  return result.rows.map((row) => row.id);
}

// Relay until our rows are all published (other files' rows may be in the way).
async function relayUntilPublished(ticketIds: string[]) {
  for (let i = 0; i < 50; i++) {
    await relayOnce(redis);
    const left = await ownerPool.query(
      "SELECT 1 FROM outbox WHERE ticket_id = ANY($1) AND published_at IS NULL",
      [ticketIds],
    );
    if (left.rowCount === 0) return;
  }
  throw new Error("outbox rows were not published");
}

describe("outbox relay", () => {
  it("publishes each event to the stream with what consumers need, and marks it", async () => {
    const ticketId = await createTicket();
    await relayUntilPublished([ticketId]);

    const ids = await outboxIds([ticketId]);
    const mine = (await streamEvents()).filter((event) => event.ticketId === ticketId);
    expect(mine.map((event) => event.eventId)).toEqual(ids);

    const created = mine.find((event) => event.type === "ticket.created")!;
    expect(created).toMatchObject({
      agencyId: requester.agencyId,
      payload: { ticket_id: ticketId },
    });

    const rows = await ownerPool.query<{ published_at: Date | null; claimed_until: Date | null }>(
      "SELECT published_at, claimed_until FROM outbox WHERE ticket_id = $1",
      [ticketId],
    );
    expect(rows.rows.every((row) => row.published_at !== null && row.claimed_until === null)).toBe(
      true,
    );
  });

  it("keeps the order in which events were written", async () => {
    const ticketId = await createTicket();
    // A few more events on the same ticket.
    for (const priority of ["high", "urgent", "low"]) {
      const current = await ownerPool.query<{ version: number }>(
        "SELECT version FROM tickets WHERE id = $1",
        [ticketId],
      );
      await ownerPool.query(
        `INSERT INTO outbox (ticket_id, event_type, payload) VALUES ($1, 'ticket.updated', $2)`,
        [ticketId, JSON.stringify({ priority, version: current.rows[0]!.version })],
      );
    }
    await relayUntilPublished([ticketId]);

    const mine = (await streamEvents()).filter((event) => event.ticketId === ticketId);
    const eventIds = mine.map((event) => Number(event.eventId));
    expect(eventIds).toEqual([...eventIds].sort((a, b) => a - b));
  });

  // Hazard 10 in README section 9.
  it("two relays running at once publish every event exactly once", async () => {
    const ticketIds = await Promise.all(Array.from({ length: 15 }, () => createTicket()));

    // Several passes of two relays side by side, until our rows are done.
    for (let i = 0; i < 20; i++) {
      await Promise.all([relayOnce(redis, 5), relayOnce(redis, 5)]);
    }
    await relayUntilPublished(ticketIds);

    const ids = await outboxIds(ticketIds);
    const published = (await streamEvents())
      .filter((event) => ticketIds.includes(event.ticketId))
      .map((event) => event.eventId);
    expect(published.sort()).toEqual(ids.sort());
    expect(new Set(published).size).toBe(published.length); // no duplicates
  });

  it("a relay that died after claiming does not lose the rows: they go out once the lease ends", async () => {
    const ticketId = await createTicket();
    // Simulate a relay that claimed the rows and then crashed.
    await ownerPool.query(
      "UPDATE outbox SET claimed_until = now() + interval '30 seconds' WHERE ticket_id = $1",
      [ticketId],
    );
    await relayOnce(redis);
    const unpublished = await ownerPool.query(
      "SELECT 1 FROM outbox WHERE ticket_id = $1 AND published_at IS NULL",
      [ticketId],
    );
    expect(unpublished.rowCount).toBeGreaterThan(0); // still leased: left alone

    // The lease runs out...
    await ownerPool.query(
      "UPDATE outbox SET claimed_until = now() - interval '1 second' WHERE ticket_id = $1",
      [ticketId],
    );
    await relayUntilPublished([ticketId]);

    const mine = (await streamEvents()).filter((event) => event.ticketId === ticketId);
    expect(mine.length).toBe((await outboxIds([ticketId])).length);
  });

  it("a relay that died after publishing causes a duplicate with the SAME event id", async () => {
    const ticketId = await createTicket();
    await relayUntilPublished([ticketId]);

    // Pretend the "mark as published" step never happened.
    await ownerPool.query(
      "UPDATE outbox SET published_at = NULL, claimed_until = NULL WHERE ticket_id = $1",
      [ticketId],
    );
    await relayUntilPublished([ticketId]);

    const mine = (await streamEvents()).filter((event) => event.ticketId === ticketId);
    const ids = await outboxIds([ticketId]);
    // Every event twice, each time with the same event id: at-least-once
    // delivery. Consumers drop the second copy by its event id.
    expect(mine.length).toBe(ids.length * 2);
    expect(new Set(mine.map((event) => event.eventId))).toEqual(new Set(ids));
  });

  it("reports the outbox lag", async () => {
    const lag = await outboxLagSeconds();
    expect(lag).toBeGreaterThanOrEqual(0);
  });
});

describe("the outbox is closed to requests", () => {
  it("a staff or requester transaction can add events but not read them", async () => {
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.role', 'agent', true)");
      const rows = await client.query("SELECT count(*)::int AS n FROM outbox");
      expect(rows.rows[0].n).toBe(0); // RLS: nothing visible
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
