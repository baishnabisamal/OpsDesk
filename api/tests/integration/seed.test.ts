import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { seed, SEED_PASSWORD } from "../../scripts/seed.js";
import { createApp } from "../../src/app.js";
import { closeTestPools, ownerPool } from "./helpers.js";

const app = createApp();

afterAll(closeTestPools);

// A fingerprint of everything the seed wrote: row counts plus a checksum of
// the ticket ids, statuses and creation times. Other test files add their own
// rows to the same database, so only rows of the seeded agencies are counted.
async function fingerprint() {
  const result = await ownerPool.query(`
    WITH seeded AS (SELECT id FROM agencies WHERE slug IN
      ('skyline-travels', 'globe-trotters', 'sunrise-holidays', 'atlas-tours', 'bluewave-trips'))
    SELECT
      (SELECT count(*)::int FROM seeded) AS agencies,
      (SELECT count(*)::int FROM users WHERE email LIKE '%@opsdesk.test') AS staff,
      (SELECT count(*)::int FROM users WHERE agency_id IN (SELECT id FROM seeded)) AS requesters,
      (SELECT count(*)::int FROM bookings WHERE agency_id IN (SELECT id FROM seeded)) AS bookings,
      (SELECT count(*)::int FROM tickets WHERE agency_id IN (SELECT id FROM seeded)) AS tickets,
      (SELECT count(*)::int FROM messages WHERE agency_id IN (SELECT id FROM seeded)) AS messages,
      (SELECT count(*)::int FROM ticket_events WHERE agency_id IN (SELECT id FROM seeded)) AS events,
      (SELECT md5(string_agg(id::text || status || created_at::text, ',' ORDER BY id))
         FROM tickets WHERE agency_id IN (SELECT id FROM seeded)) AS ticket_checksum
  `);
  return result.rows[0];
}

describe("seed", () => {
  it("creates the expected data, and running it again changes nothing", async () => {
    await seed(() => {});
    const first = await fingerprint();

    expect(first).toMatchObject({
      agencies: 5,
      staff: 20,
      requesters: 10,
      bookings: 40,
      tickets: 80,
    });
    expect(first.messages).toBeGreaterThan(0);
    expect(first.events).toBeGreaterThanOrEqual(80);

    await seed(() => {});
    const second = await fingerprint();
    expect(second).toEqual(first);
  });

  it("seeded users can log in with the demo password", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "agent1.eu@opsdesk.test", password: SEED_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("agent");
  });

  it("seeded tickets are served by the API", async () => {
    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "user1@skyline-travels.test", password: SEED_PASSWORD });
    const res = await request(app)
      .get("/api/v1/tickets")
      .set("Authorization", `Bearer ${login.body.access_token}`)
      .query({ limit: 100 });

    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    // A requester only ever sees their own agency.
    const agencyIds = new Set(
      res.body.items.map((ticket: { agency_id: string }) => ticket.agency_id),
    );
    expect(agencyIds.size).toBe(1);
  });
});
