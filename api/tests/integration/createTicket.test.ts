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
  type TestAgency,
  type TestBooking,
  type TestUser,
} from "./helpers.js";

const app = createApp();

let agency: TestAgency;
let requester: TestUser;
let booking: TestBooking;
let agent: TestUser;

beforeAll(async () => {
  ({ agency, requester, booking } = await createAgencyWithRequester());
  agent = await createUser("agent");
});

afterAll(closeTestPools);

function validBody() {
  return {
    tboh: booking.tboh,
    subject: "Booking missing at hotel",
    body: "Guest was turned away.",
  };
}

function create(user: TestUser, body: object, key: string = randomUUID()) {
  return request(app)
    .post("/api/v1/tickets")
    .set(bearer(user))
    .set("Idempotency-Key", key)
    .send(body);
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const result = await ownerPool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${sql}`,
    params,
  );
  return result.rows[0]!.n;
}

describe("POST /tickets", () => {
  it("creates a ticket, with the server choosing agency, requester and status", async () => {
    const res = await create(requester, validBody());

    expect(res.status).toBe(201);
    expect(res.headers.etag).toBe('"1"');
    expect(res.headers.location).toBe(`/api/v1/tickets/${res.body.id}`);
    expect(res.body).toMatchObject({
      agency_id: agency.id,
      booking_id: booking.id,
      requester_id: requester.id,
      status: "new",
      priority: "normal",
      intent: "other",
      assignee_id: null,
      region_code: "EU",
      version: 1,
    });
    expect(res.body.search_vector).toBeUndefined();
  });

  it("copies travel dates from the booking", async () => {
    const res = await create(requester, validBody());
    // Check-in is 10 June 2027 at 14:00 in Berlin (UTC+2 in summer) = 12:00 UTC.
    expect(res.body.check_in_at).toBe("2027-06-10T12:00:00.000Z");
    expect(res.body.lcd_at).toBe("2027-06-01T12:00:00.000Z");
  });

  it("writes the ticket, a timeline event and an outbox row together", async () => {
    const res = await create(requester, validBody());
    const id = res.body.id;

    expect(
      await count("ticket_events WHERE ticket_id = $1 AND type = 'ticket_created'", [id]),
    ).toBe(1);
    expect(await count("outbox WHERE ticket_id = $1 AND event_type = 'ticket.created'", [id])).toBe(
      1,
    );
  });

  it("requires a login", async () => {
    const res = await request(app).post("/api/v1/tickets").send(validBody());
    expect(res.status).toBe(401);
  });

  it("requires the Idempotency-Key header", async () => {
    const res = await request(app).post("/api/v1/tickets").set(bearer(requester)).send(validBody());
    expect(res.status).toBe(400);
  });

  it("does not let staff create tickets", async () => {
    const res = await create(agent, validBody());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("forbidden");
  });

  it("rejects fields the client may not set", async () => {
    const res = await create(requester, {
      ...validBody(),
      status: "closed",
      agency_id: randomUUID(),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an empty subject", async () => {
    const res = await create(requester, { ...validBody(), subject: "   " });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].field).toBe("subject");
  });

  it("returns 422 for an unknown TBOH", async () => {
    const res = await create(requester, { ...validBody(), tboh: "TBOH-NOPE" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("booking_not_found");
  });

  it("returns the same 422 for another agency's TBOH", async () => {
    const other = await createAgencyWithRequester();
    const res = await create(requester, { ...validBody(), tboh: other.booking.tboh });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("booking_not_found");
  });

  it("a failed create does not use up the key", async () => {
    const key = randomUUID();
    const bad = await create(requester, { ...validBody(), tboh: "TBOH-NOPE" }, key);
    expect(bad.status).toBe(422);
    expect(await count("idempotency_keys WHERE key = $1", [key])).toBe(0);
  });
});

describe("idempotency", () => {
  it("a retry with the same key replays the first response", async () => {
    const key = randomUUID();
    const first = await create(requester, validBody(), key);
    const retry = await create(requester, validBody(), key);

    expect(first.status).toBe(201);
    expect(first.headers["idempotent-replayed"]).toBeUndefined();
    expect(retry.status).toBe(201);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(retry.body).toEqual(first.body);
  });

  it("the same key with a different body is a 422", async () => {
    const key = randomUUID();
    await create(requester, validBody(), key);
    const res = await create(requester, { ...validBody(), subject: "Something else" }, key);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("idempotency_key_reused");
  });

  it("two users may use the same key", async () => {
    const other = await createAgencyWithRequester();
    const key = randomUUID();
    const mine = await create(requester, validBody(), key);
    const theirs = await create(other.requester, { ...validBody(), tboh: other.booking.tboh }, key);

    expect(mine.status).toBe(201);
    expect(theirs.status).toBe(201);
    expect(theirs.body.id).not.toBe(mine.body.id);
  });

  // Phase 1 gate, hazard 1 in README section 9.
  it("10 simultaneous retries create exactly 1 ticket", async () => {
    const key = randomUUID();
    const body = { ...validBody(), subject: `Retry storm ${key}` };

    const results = await Promise.all(
      Array.from({ length: 10 }, () => create(requester, body, key)),
    );

    // Every caller got a 201 with the same ticket.
    expect(results.map((res) => res.status)).toEqual(Array(10).fill(201));
    const ids = new Set(results.map((res) => res.body.id));
    expect(ids.size).toBe(1);

    // One was the real create, nine were replays.
    const replays = results.filter((res) => res.headers["idempotent-replayed"] === "true");
    expect(replays.length).toBe(9);

    // And the database agrees: one ticket, one event, one outbox row.
    const id = [...ids][0];
    expect(await count("tickets WHERE subject = $1", [body.subject])).toBe(1);
    expect(await count("ticket_events WHERE ticket_id = $1", [id])).toBe(1);
    expect(await count("outbox WHERE ticket_id = $1", [id])).toBe(1);
  });
});

describe("GET /tickets/:id", () => {
  it("returns the ticket with its version as the ETag", async () => {
    const created = await create(requester, validBody());
    const res = await request(app).get(`/api/v1/tickets/${created.body.id}`).set(bearer(requester));

    expect(res.status).toBe(200);
    expect(res.headers.etag).toBe('"1"');
    expect(res.body.id).toBe(created.body.id);
  });

  it("staff can read any agency's ticket", async () => {
    const created = await create(requester, validBody());
    const res = await request(app).get(`/api/v1/tickets/${created.body.id}`).set(bearer(agent));
    expect(res.status).toBe(200);
  });

  it("returns 404 for an unknown id and for a value that is not an id", async () => {
    const unknown = await request(app)
      .get(`/api/v1/tickets/${randomUUID()}`)
      .set(bearer(requester));
    const garbage = await request(app).get("/api/v1/tickets/not-a-uuid").set(bearer(requester));
    expect(unknown.status).toBe(404);
    expect(garbage.status).toBe(404);
  });
});
