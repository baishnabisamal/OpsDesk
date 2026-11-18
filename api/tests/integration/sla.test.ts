import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { scanSla } from "../../src/services/slaScanService.js";
import {
  bearer,
  closeTestPools,
  createAgency,
  createBooking,
  createTeam,
  createUser,
  ownerPool,
  type TestAgency,
  type TestBooking,
  type TestUser,
} from "./helpers.js";

// This file owns the AMER region. Its agents have no presence row, so
// tickets are never routed automatically here: the lead assigns them by hand.
const REGION = "AMER";

const app = createApp();

let agency: TestAgency;
let requester: TestUser;
let booking: TestBooking;
let agent: TestUser;
let lead: TestUser;
let manager: TestUser;

beforeAll(async () => {
  agency = await createAgency();
  requester = await createUser("requester", { agencyId: agency.id });
  booking = await createBooking(agency.id, REGION);
  const teamId = await createTeam(REGION);
  agent = await createUser("agent", { teamId });
  lead = await createUser("lead", { teamId });
  manager = await createUser("escalation_manager", { teamId });
});

afterAll(closeTestPools);

type TicketBody = {
  id: string;
  version: number;
  status: string;
  assignee_id: string | null;
  created_at: string;
  sla_due_at: string;
  sla_at_risk_at: string;
  sla_state: string;
  sla_paused_at: string | null;
  sla_paused_total: number;
};

const MINUTE = 60_000;

async function create(priority = "normal", tboh = booking.tboh): Promise<TicketBody> {
  const res = await request(app)
    .post("/api/v1/tickets")
    .set(bearer(requester))
    .set("Idempotency-Key", randomUUID())
    .send({ tboh, subject: "Refund not received", body: "Please check.", priority });
  expect(res.status).toBe(201);
  return res.body;
}

// A ticket the agent is working on: status open.
async function openTicket(priority = "normal"): Promise<TicketBody> {
  const ticket = await create(priority);
  const res = await request(app)
    .post(`/api/v1/tickets/${ticket.id}/assign`)
    .set(bearer(lead))
    .set("If-Match", `"${ticket.version}"`)
    .send({ assignee_id: agent.id });
  expect(res.status).toBe(200);
  return res.body;
}

function transition(user: TestUser, ticket: { id: string; version: number }, to: string) {
  return request(app)
    .post(`/api/v1/tickets/${ticket.id}/transitions`)
    .set(bearer(user))
    .set("If-Match", `"${ticket.version}"`)
    .send({ to });
}

async function getTicket(id: string): Promise<TicketBody> {
  const res = await request(app).get(`/api/v1/tickets/${id}`).set(bearer(lead));
  return res.body;
}

// Moves a ticket's SLA times into the past, as if time had gone by.
async function makeAtRisk(id: string) {
  await ownerPool.query(
    `UPDATE tickets SET sla_at_risk_at = now() - interval '5 minutes',
                        sla_due_at = now() + interval '30 minutes' WHERE id = $1`,
    [id],
  );
}

async function makeOverdue(id: string) {
  await ownerPool.query(
    `UPDATE tickets SET sla_at_risk_at = now() - interval '2 hours',
                        sla_due_at = now() - interval '1 hour' WHERE id = $1`,
    [id],
  );
}

async function events(id: string, type: string) {
  const result = await ownerPool.query<{ actor_id: string | null; data: Record<string, unknown> }>(
    "SELECT actor_id, data FROM ticket_events WHERE ticket_id = $1 AND type = $2 ORDER BY created_at",
    [id, type],
  );
  return result.rows;
}

describe("SLA deadline on create", () => {
  it("an urgent ticket is due exactly two hours after it was created", async () => {
    // Urgent runs on plain clock time, so the answer does not depend on what
    // time of day the test happens to run.
    const ticket = await create("urgent");
    const created = new Date(ticket.created_at).getTime();

    expect(new Date(ticket.sla_due_at).getTime()).toBe(created + 120 * MINUTE);
    // At risk for the last fifth: after 96 of the 120 minutes.
    expect(new Date(ticket.sla_at_risk_at).getTime()).toBe(created + 96 * MINUTE);
    expect(ticket).toMatchObject({
      sla_state: "on_track",
      sla_paused_at: null,
      sla_paused_total: 0,
    });
  });

  it("lower priorities get later deadlines", async () => {
    const due = async (priority: string) => new Date((await create(priority)).sla_due_at).getTime();
    const [urgent, high, normal, low] = [
      await due("urgent"),
      await due("high"),
      await due("normal"),
      await due("low"),
    ];
    expect(urgent).toBeLessThan(normal);
    expect(high).toBeLessThanOrEqual(normal);
    expect(normal).toBeLessThan(low);
  });

  it("is pulled forward to one hour before check-in when the guest arrives soon", async () => {
    // A booking whose guest checks in tomorrow. Free cancellation has passed.
    const supplier = await ownerPool.query<{ id: string }>(
      "INSERT INTO suppliers (code, name) VALUES ($1, 'S') RETURNING id",
      [`SUP-${randomUUID().slice(0, 8)}`],
    );
    const tboh = `TBOH-${randomUUID().slice(0, 8).toUpperCase()}`;
    await ownerPool.query(
      `INSERT INTO bookings (tboh, agency_id, supplier_id, region_code, hotel_name, check_in_date,
                             hotel_time_zone, lcd_at, amount, currency)
       VALUES ($1, $2, $3, $4, 'Hotel Soon',
               (now() AT TIME ZONE 'America/New_York')::date + 1, 'America/New_York',
               now() - interval '2 days', 100, 'USD')`,
      [tboh, agency.id, supplier.rows[0]!.id, REGION],
    );

    // Low priority alone would allow almost three working days.
    const ticket = await create("low", tboh);
    const full = await ownerPool.query<{ check_in_at: Date }>(
      "SELECT check_in_at FROM tickets WHERE id = $1",
      [ticket.id],
    );
    const checkIn = full.rows[0]!.check_in_at.getTime();
    expect(new Date(ticket.sla_due_at).getTime()).toBe(checkIn - 60 * MINUTE);

    const created = await events(ticket.id, "ticket_created");
    expect(created[0]!.data.sla_basis).toBe("travel_deadline");
  });

  it("skips the region's holidays", async () => {
    // Make today and the next nine days holidays in this region.
    await ownerPool.query(
      `INSERT INTO region_holidays (region_code, holiday, name)
       SELECT $1, (now() AT TIME ZONE 'America/New_York')::date + day, 'Test holiday'
         FROM generate_series(0, 9) AS day`,
      [REGION],
    );
    try {
      const ticket = await create("normal");
      const lastHoliday = await ownerPool.query<{ day: string }>(
        "SELECT max(holiday)::text AS day FROM region_holidays WHERE region_code = $1",
        [REGION],
      );
      const dueDay = await ownerPool.query<{ day: string }>(
        `SELECT (sla_due_at AT TIME ZONE 'America/New_York')::date::text AS day
           FROM tickets WHERE id = $1`,
        [ticket.id],
      );
      // Business time cannot be used up on a holiday, so the deadline falls
      // on a later day than the last one.
      expect(dueDay.rows[0]!.day > lastHoliday.rows[0]!.day).toBe(true);
    } finally {
      // region_holidays is reference data that only the owner role changes.
      await ownerPool.query("DELETE FROM region_holidays WHERE name = 'Test holiday'");
    }
  });

  it("changing the priority works the deadline out again", async () => {
    const ticket = await create("low");
    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}`)
      .set(bearer(agent))
      .set("If-Match", `"${ticket.version}"`)
      .send({ priority: "urgent" });

    expect(res.status).toBe(200);
    const created = new Date(ticket.created_at).getTime();
    // Still counted from when the ticket was created, not from the edit.
    expect(new Date(res.body.sla_due_at).getTime()).toBe(created + 120 * MINUTE);
  });
});

describe("the SLA clock pauses while waiting on the requester", () => {
  it("pending pauses it, and coming back moves the deadline later by the wait", async () => {
    const ticket = await openTicket();
    const dueBefore = new Date(ticket.sla_due_at).getTime();

    const pending = await transition(agent, ticket, "pending");
    expect(pending.body.sla_paused_at).not.toBeNull();
    expect(pending.body.sla_due_at).toBe(ticket.sla_due_at); // unchanged while paused

    // Pretend the ticket has been waiting for one hour.
    await ownerPool.query(
      "UPDATE tickets SET sla_paused_at = now() - interval '1 hour' WHERE id = $1",
      [ticket.id],
    );

    const resumed = await transition(agent, pending.body, "open");
    expect(resumed.body.sla_paused_at).toBeNull();

    const shift = new Date(resumed.body.sla_due_at).getTime() - dueBefore;
    expect(shift).toBeGreaterThanOrEqual(60 * MINUTE);
    expect(shift).toBeLessThan(61 * MINUTE);
    expect(resumed.body.sla_paused_total).toBeGreaterThanOrEqual(3600);
    expect(resumed.body.sla_paused_total).toBeLessThan(3660);
  });

  it("a requester's reply resumes the clock too", async () => {
    const ticket = await openTicket();
    await transition(agent, ticket, "pending");

    await request(app)
      .post(`/api/v1/tickets/${ticket.id}/messages`)
      .set(bearer(requester))
      .send({ body: "Here is the document." });

    expect(await getTicket(ticket.id)).toMatchObject({ status: "open", sla_paused_at: null });
  });

  it("the database refuses a paused clock on a ticket that is not pending", async () => {
    const ticket = await openTicket();
    await expect(
      ownerPool.query("UPDATE tickets SET sla_paused_at = now() WHERE id = $1", [ticket.id]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("the SLA scanner", () => {
  it("flags a ticket as at risk, as the system, without escalating it", async () => {
    const ticket = await openTicket();
    await makeAtRisk(ticket.id);

    await scanSla();

    const after = await getTicket(ticket.id);
    expect(after).toMatchObject({ sla_state: "at_risk", status: "open", assignee_id: agent.id });
    expect(after.version).toBe(ticket.version + 1);

    const changes = await events(ticket.id, "sla_state_changed");
    expect(changes.length).toBe(1);
    expect(changes[0]).toMatchObject({ actor_id: null, data: { from: "on_track", to: "at_risk" } });

    const outbox = await ownerPool.query(
      "SELECT 1 FROM outbox WHERE ticket_id = $1 AND event_type = 'ticket.sla_at_risk'",
      [ticket.id],
    );
    expect(outbox.rowCount).toBe(1);
  });

  it("a breached open ticket is escalated to the escalation manager", async () => {
    const ticket = await openTicket();
    await makeOverdue(ticket.id);

    const result = await scanSla();
    expect(result.escalated).toBeGreaterThanOrEqual(1);

    const after = await getTicket(ticket.id);
    expect(after).toMatchObject({
      sla_state: "breached",
      status: "escalated",
      assignee_id: manager.id,
    });

    // Both steps are on the timeline, done by the system.
    const escalation = (await events(ticket.id, "status_changed")).filter(
      (event) => event.data.to === "escalated",
    );
    expect(escalation).toEqual([{ actor_id: null, data: { from: "open", to: "escalated" } }]);
  });

  it("goes straight from on-track to breached when the scanner was late", async () => {
    const ticket = await openTicket();
    await makeOverdue(ticket.id);
    await scanSla();

    const changes = await events(ticket.id, "sla_state_changed");
    expect(changes.map((event) => event.data.to)).toEqual(["breached"]);
  });

  it("a breached ticket still in triage is flagged but stays new", async () => {
    const ticket = await create();
    await makeOverdue(ticket.id);

    await scanSla();

    expect(await getTicket(ticket.id)).toMatchObject({
      sla_state: "breached",
      status: "new",
      assignee_id: null,
    });
  });

  it("leaves a pending ticket alone: its clock is paused", async () => {
    const ticket = await openTicket();
    const pending = await transition(agent, ticket, "pending");
    await makeOverdue(ticket.id);

    await scanSla();

    const after = await getTicket(ticket.id);
    expect(after).toMatchObject({ status: "pending", sla_state: "on_track" });
    expect(after.version).toBe(pending.body.version);
  });

  it("leaves resolved tickets and tickets with time left alone", async () => {
    const fine = await openTicket();
    const done = await openTicket();
    const resolved = await transition(agent, done, "resolved");
    await makeOverdue(done.id);

    await scanSla();

    expect((await getTicket(fine.id)).version).toBe(fine.version);
    expect(await getTicket(done.id)).toMatchObject({
      status: "resolved",
      version: resolved.body.version,
    });
  });

  it("running it again changes nothing (idempotent)", async () => {
    const ticket = await openTicket();
    await makeOverdue(ticket.id);

    await scanSla();
    const afterFirst = await getTicket(ticket.id);
    await scanSla();
    await scanSla();

    expect((await getTicket(ticket.id)).version).toBe(afterFirst.version);
    expect((await events(ticket.id, "sla_state_changed")).length).toBe(1);
  });

  // Phase 3 gate, hazard 8 in README section 9.
  it("two scanners at once escalate each breached ticket exactly once", async () => {
    const tickets: TicketBody[] = [];
    for (let i = 0; i < 12; i++) tickets.push(await openTicket());
    for (const ticket of tickets) await makeOverdue(ticket.id);

    const [one, two] = await Promise.all([scanSla(), scanSla()]);
    // Between them they handled each ticket once.
    expect(one.escalated + two.escalated).toBeGreaterThanOrEqual(12);

    for (const ticket of tickets) {
      const after = await getTicket(ticket.id);
      expect(after).toMatchObject({ status: "escalated", sla_state: "breached" });

      const breaches = (await events(ticket.id, "sla_state_changed")).filter(
        (event) => event.data.to === "breached",
      );
      const escalations = (await events(ticket.id, "status_changed")).filter(
        (event) => event.data.to === "escalated",
      );
      expect(breaches.length).toBe(1);
      expect(escalations.length).toBe(1);
    }
  });

  // Hazard 7 in README section 9.
  it("the scanner racing an agent's resolve ends in one valid state", async () => {
    for (let round = 0; round < 6; round++) {
      const ticket = await openTicket();
      await makeOverdue(ticket.id);

      const [resolve] = await Promise.all([transition(agent, ticket, "resolved"), scanSla()]);

      const after = await getTicket(ticket.id);
      const escalations = (await events(ticket.id, "status_changed")).filter(
        (event) => event.data.to === "escalated",
      );

      if (resolve.status === 200) {
        // The agent won: the ticket is resolved and was never escalated.
        expect(after.status).toBe("resolved");
        expect(escalations.length).toBe(0);
      } else {
        // The scanner won: the agent was told (409) and the ticket is escalated.
        expect(resolve.status).toBe(409);
        expect(after.status).toBe("escalated");
        expect(escalations.length).toBe(1);
      }
    }
  });
});
