import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
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
let otherRequester: TestUser;

const SUBJECTS = [
  "Refund not received for cancelled stay",
  "Voucher shows wrong dates",
  "Booking missing at hotel",
  "Refund amount is lower than expected",
  "Guest name spelled wrong",
  "Late checkout request",
  "Invoice copy needed",
];

async function create(user: TestUser, tboh: string, subject: string, priority = "normal") {
  const res = await request(app)
    .post("/api/v1/tickets")
    .set(bearer(user))
    .set("Idempotency-Key", randomUUID())
    .send({ tboh, subject, body: "Please help with this booking.", priority });
  expect(res.status).toBe(201);
  return res.body as { id: string };
}

function list(user: TestUser, query: Record<string, string | number> = {}) {
  return request(app).get("/api/v1/tickets").set(bearer(user)).query(query);
}

beforeAll(async () => {
  ({ requester, booking } = await createAgencyWithRequester());
  agent = await createUser("agent");

  // Seven tickets for our agency, created one after another.
  for (const [index, subject] of SUBJECTS.entries()) {
    await create(requester, booking.tboh, subject, index === 0 ? "urgent" : "normal");
  }

  // One ticket for a different agency, which our requester must never see.
  const other = await createAgencyWithRequester();
  otherRequester = other.requester;
  await create(otherRequester, other.booking.tboh, "Refund for the other agency");
});

afterAll(closeTestPools);

describe("GET /tickets", () => {
  it("returns the caller's agency's tickets, newest first", async () => {
    const res = await list(requester);

    expect(res.status).toBe(200);
    expect(res.body.next_cursor).toBeNull();
    const subjects = res.body.items.map((ticket: { subject: string }) => ticket.subject);
    expect(subjects).toEqual([...SUBJECTS].reverse());
  });

  it("a requester never sees another agency's tickets", async () => {
    const mine = await list(requester, { limit: 100 });
    const theirs = await list(otherRequester, { limit: 100 });

    expect(mine.body.items.length).toBe(7);
    expect(theirs.body.items.length).toBe(1);
    expect(theirs.body.items[0].subject).toBe("Refund for the other agency");
  });

  it("staff see tickets from every agency", async () => {
    const res = await list(agent, { q: "refund", limit: 100 });
    const subjects = res.body.items.map((ticket: { subject: string }) => ticket.subject);
    expect(subjects).toContain("Refund not received for cancelled stay");
    expect(subjects).toContain("Refund for the other agency");
  });

  it("pages through everything with no repeats and no gaps", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const query: Record<string, string | number> = { limit: 3 };
      if (cursor) query.cursor = cursor;
      const res = await list(requester, query);
      expect(res.status).toBe(200);
      seen.push(...res.body.items.map((ticket: { subject: string }) => ticket.subject));
      cursor = res.body.next_cursor;
      pages += 1;
    } while (cursor);

    // 7 tickets at 3 per page = pages of 3, 3 and 1.
    expect(pages).toBe(3);
    expect(seen).toEqual([...SUBJECTS].reverse());
  });

  it("a ticket created between pages does not shift the next page", async () => {
    const first = await list(requester, { limit: 3 });
    const cursor = first.body.next_cursor as string;

    // With OFFSET this new row would push an already-seen ticket onto page 2.
    const extra = await create(requester, booking.tboh, "Created during pagination");

    const second = await list(requester, { limit: 3, cursor });
    const firstIds = first.body.items.map((ticket: { id: string }) => ticket.id);
    const secondIds = second.body.items.map((ticket: { id: string }) => ticket.id);

    expect(secondIds).not.toContain(extra.id);
    expect(secondIds.filter((id: string) => firstIds.includes(id))).toEqual([]);
  });

  it("filters by priority", async () => {
    const res = await list(requester, { priority: "urgent" });
    expect(res.body.items.length).toBe(1);
    expect(res.body.items[0].subject).toBe(SUBJECTS[0]);
  });

  it("filters by status", async () => {
    const res = await list(requester, { status: "closed" });
    expect(res.body.items).toEqual([]);
  });

  it("searches the subject and body, matching word forms", async () => {
    // "refunds" matches "Refund" because full-text search compares word stems.
    const res = await list(requester, { q: "refunds" });
    const subjects = res.body.items.map((ticket: { subject: string }) => ticket.subject);
    expect(subjects.sort()).toEqual([
      "Refund amount is lower than expected",
      "Refund not received for cancelled stay",
    ]);
  });

  it("rejects a bad cursor, a bad limit and unknown filters with 400", async () => {
    expect((await list(requester, { cursor: "garbage" })).status).toBe(400);
    expect((await list(requester, { limit: 1000 })).status).toBe(400);
    expect((await list(requester, { status: "nope" })).status).toBe(400);
    expect((await list(requester, { agency_id: randomUUID() })).status).toBe(400);
  });

  it("requires a login", async () => {
    const res = await request(app).get("/api/v1/tickets");
    expect(res.status).toBe(401);
  });

  it("the agency index can serve a requester's list without sorting", async () => {
    // Ask PostgreSQL for its plan. The test table is tiny, and on a tiny table
    // the planner may simply read every row and sort, so sequential and bitmap
    // scans are switched off for this one transaction. That shows the index fits the query.
    const client = await ownerPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      await client.query("SET LOCAL enable_bitmapscan = off");
      const plan = await client.query<{ "QUERY PLAN": string }>(
        `EXPLAIN SELECT id FROM tickets WHERE agency_id = '${requester.agencyId}'
          ORDER BY created_at DESC, id DESC LIMIT 21`,
      );
      await client.query("ROLLBACK");
      const text = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
      expect(text).toContain("tickets_agency_newest");
      expect(text).not.toContain("Sort");
    } finally {
      client.release();
    }
  });
});
