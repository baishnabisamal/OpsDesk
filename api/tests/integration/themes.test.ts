import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { rollupWeek } from "../../src/services/themeService.js";
import { FakeMl } from "./fakeMl.js";
import {
  bearer,
  closeTestPools,
  createAgencyWithRequester,
  createUser,
  ownerPool,
  type TestUser,
} from "./helpers.js";

// Themes for a week long ago (2020), so no other test file has tickets in it.
const WEEK = "2020-03-02"; // a Monday

const app = createApp();
const fakeMl = new FakeMl();

let lead: TestUser;
let agent: TestUser;
let requester: TestUser;
const ticketIds: string[] = [];

// Puts a ticket into the test week, directly in the database.
async function ticketAt(createdAt: string, intent: string, subject: string): Promise<string> {
  const { requester: owner, booking } = await createAgencyWithRequester();
  await ownerPool.query(
    `INSERT INTO cases (booking_id, agency_id) SELECT id, agency_id FROM bookings WHERE id = $1
     ON CONFLICT (booking_id) WHERE status = 'open' DO NOTHING`,
    [booking.id],
  );
  const result = await ownerPool.query<{ id: string }>(
    `INSERT INTO tickets (agency_id, booking_id, case_id, requester_id, subject, body, intent,
                          intent_source, check_in_at, lcd_at, region_code, sla_due_at,
                          sla_at_risk_at, status, resolved_at, closed_at, created_at)
     SELECT b.agency_id, b.id, c.id, $2, $3, 'Body text.', $4, 'manual', now(), now(), 'EU',
            $5::timestamptz + interval '8 hours', $5::timestamptz + interval '6 hours',
            'closed', $5::timestamptz, $5::timestamptz, $5::timestamptz
       FROM bookings b JOIN cases c ON c.booking_id = b.id AND c.status = 'open'
      WHERE b.id = $1
     RETURNING id`,
    [booking.id, owner.id, subject, intent, createdAt],
  );
  return result.rows[0]!.id;
}

beforeAll(async () => {
  lead = await createUser("lead");
  agent = await createUser("agent");
  ({ requester } = await createAgencyWithRequester());

  // Inside the week: Monday 00:00 exactly, and Sunday 23:59.
  ticketIds.push(await ticketAt("2020-03-02T00:00:00Z", "refund", "Refund not received"));
  ticketIds.push(await ticketAt("2020-03-04T10:00:00Z", "refund", "Refund still missing"));
  ticketIds.push(await ticketAt("2020-03-08T23:59:59Z", "voucher", "Voucher wrong dates"));
  // Outside it: the Sunday before, and the next Monday 00:00 (half-open range).
  await ticketAt("2020-03-01T23:59:59Z", "refund", "Too early");
  await ticketAt("2020-03-09T00:00:00Z", "refund", "Too late");

  await fakeMl.start();
});

beforeEach(() => fakeMl.reset());

afterAll(async () => {
  await fakeMl.stop();
  await closeTestPools();
});

describe("weekly themes", () => {
  it("counts the week's tickets per intent, with samples, and stores the clusters", async () => {
    fakeMl.handler = (path, body) => {
      const tickets = body.tickets as { id: string }[];
      return path === "/themes/cluster"
        ? {
            clusters: [
              {
                label: "refund / received",
                terms: ["refund", "received"],
                size: tickets.length,
                ticket_ids: tickets.map((t) => t.id),
              },
            ],
          }
        : {};
    };

    const result = await rollupWeek(WEEK);

    expect(result.week_start).toBe(WEEK);
    expect(result.ticket_count).toBe(3); // the half-open range drops the two outside
    expect(result.intents).toEqual([
      {
        intent: "refund",
        count: 2,
        sample_ticket_ids: expect.arrayContaining([ticketIds[0], ticketIds[1]]),
      },
      { intent: "voucher", count: 1, sample_ticket_ids: [ticketIds[2]] },
    ]);
    expect(result.clusters).toEqual([
      {
        label: "refund / received",
        terms: ["refund", "received"],
        size: 3,
        sample_ticket_ids: expect.any(Array),
      },
    ]);

    // Only the week's tickets were sent to be clustered.
    const sent = fakeMl.callsTo("/themes/cluster")[0]!.body.tickets as { id: string }[];
    expect(sent.map((t) => t.id).sort()).toEqual([...ticketIds].sort());
  });

  it("running it again replaces the week instead of adding to it", async () => {
    fakeMl.handler = () => ({ clusters: [] });
    await rollupWeek(WEEK);
    await rollupWeek(WEEK);

    const rows = await ownerPool.query("SELECT 1 FROM theme_weekly WHERE week_start = $1", [WEEK]);
    expect(rows.rowCount).toBe(1);
  });

  it("with the ML service down, the intent counts are still stored", async () => {
    fakeMl.status = 503;
    const result = await rollupWeek(WEEK);
    expect(result.ticket_count).toBe(3);
    expect(result.clusters).toBeNull();
  });

  it("GET /insights/themes returns the week for a lead, for any day of that week", async () => {
    fakeMl.handler = () => ({ clusters: [] });
    await rollupWeek(WEEK);

    const res = await request(app)
      .get("/api/v1/insights/themes")
      .query({ week: "2020-03-05" }) // a Thursday
      .set(bearer(lead));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ week_start: WEEK, ticket_count: 3 });
  });

  it("is for leads only, 404 for a week never computed, 400 for a bad date", async () => {
    const agentRes = await request(app)
      .get("/api/v1/insights/themes")
      .query({ week: WEEK })
      .set(bearer(agent));
    const requesterRes = await request(app)
      .get("/api/v1/insights/themes")
      .query({ week: WEEK })
      .set(bearer(requester));
    expect(agentRes.status).toBe(403);
    expect(requesterRes.status).toBe(403);

    const never = await request(app)
      .get("/api/v1/insights/themes")
      .query({ week: "1999-01-04" })
      .set(bearer(lead));
    expect(never.status).toBe(404);

    const bad = await request(app)
      .get("/api/v1/insights/themes")
      .query({ week: "last week" })
      .set(bearer(lead));
    expect(bad.status).toBe(400);
  });

  it("the database only accepts a Monday as the start of a week", async () => {
    await expect(
      ownerPool.query(
        "INSERT INTO theme_weekly (week_start, ticket_count, intents) VALUES ('2020-03-03', 0, '[]')",
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
