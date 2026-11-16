import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import {
  bearer,
  closeTestPools,
  createAgencyWithRequester,
  createTeam,
  createUser,
  ownerPool,
  type TestBooking,
  type TestUser,
} from "./helpers.js";

const app = createApp();

let requester: TestUser;
let booking: TestBooking;
let agent: TestUser;
let agent2: TestUser;
let manager: TestUser;
let lead: TestUser;
let teamId: string;

beforeAll(async () => {
  ({ requester, booking } = await createAgencyWithRequester());
  teamId = await createTeam();
  agent = await createUser("agent", { teamId });
  agent2 = await createUser("agent", { teamId });
  manager = await createUser("escalation_manager", { teamId });
  lead = await createUser("lead", { teamId });
});

afterAll(closeTestPools);

type TicketBody = { id: string; version: number; status: string };

async function newTicket(): Promise<TicketBody> {
  const res = await request(app)
    .post("/api/v1/tickets")
    .set(bearer(requester))
    .set("Idempotency-Key", randomUUID())
    .send({ tboh: booking.tboh, subject: "Voucher shows wrong dates", body: "Please fix." });
  expect(res.status).toBe(201);
  return res.body;
}

function patch(user: TestUser, id: string, version: number, body: object) {
  return request(app)
    .patch(`/api/v1/tickets/${id}`)
    .set(bearer(user))
    .set("If-Match", `"${version}"`)
    .send(body);
}

function transition(user: TestUser, id: string, version: number, to: string) {
  return request(app)
    .post(`/api/v1/tickets/${id}/transitions`)
    .set(bearer(user))
    .set("If-Match", `"${version}"`)
    .send({ to });
}

function assign(user: TestUser, id: string, version: number, assigneeId: string) {
  return request(app)
    .post(`/api/v1/tickets/${id}/assign`)
    .set(bearer(user))
    .set("If-Match", `"${version}"`)
    .send({ assignee_id: assigneeId });
}

// A ticket that an agent has taken: status open, version 2.
async function openTicket(): Promise<TicketBody> {
  const ticket = await newTicket();
  const res = await assign(agent, ticket.id, ticket.version, agent.id);
  expect(res.status).toBe(200);
  return res.body;
}

async function eventTypes(ticketId: string): Promise<string[]> {
  const result = await ownerPool.query<{ type: string }>(
    "SELECT type FROM ticket_events WHERE ticket_id = $1 ORDER BY created_at, type",
    [ticketId],
  );
  return result.rows.map((row) => row.type);
}

describe("PATCH /tickets/:id", () => {
  it("edits fields and moves the version forward", async () => {
    const ticket = await newTicket();
    const res = await patch(agent, ticket.id, 1, {
      priority: "high",
      subject: "Voucher dates are wrong",
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      priority: "high",
      subject: "Voucher dates are wrong",
      version: 2,
    });
    expect(res.headers.etag).toBe('"2"');
  });

  it("records old and new values on the timeline, and an outbox row", async () => {
    const ticket = await newTicket();
    await patch(agent, ticket.id, 1, { priority: "urgent" });

    const events = await ownerPool.query<{ data: object; actor_id: string }>(
      "SELECT data, actor_id FROM ticket_events WHERE ticket_id = $1 AND type = 'ticket_updated'",
      [ticket.id],
    );
    expect(events.rows).toEqual([
      { actor_id: agent.id, data: { changes: { priority: { from: "normal", to: "urgent" } } } },
    ]);

    const outbox = await ownerPool.query(
      "SELECT 1 FROM outbox WHERE ticket_id = $1 AND event_type = 'ticket.updated'",
      [ticket.id],
    );
    expect(outbox.rowCount).toBe(1);
  });

  it("returns 428 when If-Match is missing", async () => {
    const ticket = await newTicket();
    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}`)
      .set(bearer(agent))
      .send({ priority: "high" });
    expect(res.status).toBe(428);
    expect(res.body.code).toBe("precondition_required");
  });

  it("returns 409 for a stale version and changes nothing", async () => {
    const ticket = await newTicket();
    await patch(agent, ticket.id, 1, { priority: "high" });

    const stale = await patch(agent2, ticket.id, 1, { priority: "low" });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("version_conflict");

    const now = await request(app).get(`/api/v1/tickets/${ticket.id}`).set(bearer(agent));
    expect(now.body).toMatchObject({ priority: "high", version: 2 });
  });

  it("does not let a requester edit", async () => {
    const ticket = await newTicket();
    const res = await patch(requester, ticket.id, 1, { priority: "urgent" });
    expect(res.status).toBe(403);
  });

  it("rejects status, assignee and empty bodies", async () => {
    const ticket = await newTicket();
    expect((await patch(agent, ticket.id, 1, { status: "closed" })).status).toBe(400);
    expect((await patch(agent, ticket.id, 1, { intent: "refund" })).status).toBe(400);
    expect((await patch(agent, ticket.id, 1, { assignee_id: agent.id })).status).toBe(400);
    expect((await patch(agent, ticket.id, 1, {})).status).toBe(400);
  });

  // Phase 1 gate, hazard 2 in README section 9.
  it("12 simultaneous edits: exactly 1 wins, 11 get 409", async () => {
    const ticket = await newTicket();
    const priorities = ["low", "high", "urgent"];

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        patch(i % 2 === 0 ? agent : agent2, ticket.id, 1, { priority: priorities[i % 3] }),
      ),
    );

    const statuses = results.map((res) => res.status);
    expect(statuses.filter((status) => status === 200).length).toBe(1);
    expect(statuses.filter((status) => status === 409).length).toBe(11);

    // The saved ticket is exactly what the one winner wrote.
    const winner = results.find((res) => res.status === 200)!;
    const now = await request(app).get(`/api/v1/tickets/${ticket.id}`).set(bearer(agent));
    expect(now.body.version).toBe(2);
    expect(now.body.priority).toBe(winner.body.priority);

    // One edit means one timeline event, not twelve.
    expect(await eventTypes(ticket.id)).toEqual(["ticket_created", "ticket_updated"]);
  });
});

describe("POST /tickets/:id/assign", () => {
  it("an agent taking a new ticket becomes the assignee and the ticket opens", async () => {
    const ticket = await newTicket();
    const res = await assign(agent, ticket.id, 1, agent.id);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      assignee_id: agent.id,
      team_id: teamId,
      status: "open",
      version: 2,
    });
    expect(await eventTypes(ticket.id)).toEqual([
      "ticket_created",
      "status_changed",
      "ticket_assigned",
    ]);
  });

  it("an agent cannot assign a ticket to someone else", async () => {
    const ticket = await newTicket();
    const res = await assign(agent, ticket.id, 1, agent2.id);
    expect(res.status).toBe(403);
  });

  it("an agent cannot take a ticket that already has an owner", async () => {
    const ticket = await openTicket();
    const res = await assign(agent2, ticket.id, ticket.version, agent2.id);
    expect(res.status).toBe(403);
  });

  it("a lead can reassign", async () => {
    const ticket = await openTicket();
    const res = await assign(lead, ticket.id, ticket.version, agent2.id);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ assignee_id: agent2.id, status: "open", version: 3 });
  });

  it("a requester cannot assign", async () => {
    const ticket = await newTicket();
    const res = await assign(requester, ticket.id, 1, agent.id);
    expect(res.status).toBe(403);
  });

  it("the assignee must be active staff", async () => {
    const ticket = await newTicket();
    const toRequester = await assign(lead, ticket.id, 1, requester.id);
    const toNobody = await assign(lead, ticket.id, 1, randomUUID());

    expect(toRequester.status).toBe(422);
    expect(toRequester.body.code).toBe("invalid_assignee");
    expect(toNobody.status).toBe(422);
  });

  it("a resolved ticket cannot be assigned", async () => {
    const ticket = await openTicket();
    const resolved = await transition(agent, ticket.id, ticket.version, "resolved");
    const res = await assign(lead, ticket.id, resolved.body.version, agent2.id);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ticket_not_assignable");
  });

  // Hazard 3 in README section 9.
  it("two agents clicking 'assign to me' at once: one owner", async () => {
    const ticket = await newTicket();

    const [first, second] = await Promise.all([
      assign(agent, ticket.id, 1, agent.id),
      assign(agent2, ticket.id, 1, agent2.id),
    ]);

    // One wins. The loser is told so: 409 if its UPDATE lost the version race,
    // 403 if it started late enough to see the ticket was already taken.
    const statuses = [first.status, second.status].sort();
    expect(statuses[0]).toBe(200);
    expect([403, 409]).toContain(statuses[1]);

    const winner = first.status === 200 ? agent : agent2;
    const now = await request(app).get(`/api/v1/tickets/${ticket.id}`).set(bearer(agent));
    expect(now.body).toMatchObject({ assignee_id: winner.id, version: 2 });
  });
});

describe("POST /tickets/:id/transitions", () => {
  it("walks a ticket through its normal life", async () => {
    let ticket = await openTicket();

    let res = await transition(agent, ticket.id, ticket.version, "pending");
    expect(res.body.status).toBe("pending");
    ticket = res.body;

    res = await transition(agent, ticket.id, ticket.version, "resolved");
    expect(res.body.status).toBe("resolved");
    expect(res.body.resolved_at).not.toBeNull();
    expect(res.body.closed_at).toBeNull();
    ticket = res.body;

    res = await transition(requester, ticket.id, ticket.version, "closed");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("closed");
    expect(res.body.closed_at).not.toBeNull();
    expect(res.body.resolved_at).not.toBeNull();
  });

  it("reopening clears resolved_at", async () => {
    const ticket = await openTicket();
    const resolved = await transition(agent, ticket.id, ticket.version, "resolved");
    const reopened = await transition(requester, ticket.id, resolved.body.version, "open");

    expect(reopened.status).toBe(200);
    expect(reopened.body).toMatchObject({ status: "open", resolved_at: null });
  });

  it("writes a status_changed event and an outbox row", async () => {
    const ticket = await openTicket();
    await transition(agent, ticket.id, ticket.version, "pending");

    const events = await ownerPool.query<{ data: object }>(
      `SELECT data FROM ticket_events
        WHERE ticket_id = $1 AND type = 'status_changed' AND data->>'to' = 'pending'`,
      [ticket.id],
    );
    expect(events.rows).toEqual([{ data: { from: "open", to: "pending" } }]);

    const outbox = await ownerPool.query(
      "SELECT 1 FROM outbox WHERE ticket_id = $1 AND event_type = 'ticket.status_changed'",
      [ticket.id],
    );
    expect(outbox.rowCount).toBe(1);
  });

  it("a move that is not in the table is a 409", async () => {
    const ticket = await openTicket();
    const res = await transition(agent, ticket.id, ticket.version, "closed");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("invalid_transition");
  });

  it("a move the role may not make is a 403", async () => {
    const ticket = await openTicket();
    // open -> resolved exists, but only for staff.
    const res = await transition(requester, ticket.id, ticket.version, "resolved");
    expect(res.status).toBe(403);
  });

  it("only an escalation manager or lead can de-escalate", async () => {
    const ticket = await openTicket();
    const escalated = await transition(agent, ticket.id, ticket.version, "escalated");
    expect(escalated.body.status).toBe("escalated");

    const byAgent = await transition(agent, ticket.id, escalated.body.version, "open");
    expect(byAgent.status).toBe(403);

    const byManager = await transition(manager, ticket.id, escalated.body.version, "open");
    expect(byManager.status).toBe(200);
    expect(byManager.body.status).toBe("open");
  });

  it("a new ticket cannot be opened without assigning it", async () => {
    const ticket = await newTicket();
    const res = await transition(agent, ticket.id, 1, "open");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("invalid_transition");
  });

  it("closed is final", async () => {
    const ticket = await openTicket();
    const resolved = await transition(agent, ticket.id, ticket.version, "resolved");
    const closed = await transition(agent, ticket.id, resolved.body.version, "closed");

    const res = await transition(lead, ticket.id, closed.body.version, "open");
    expect(res.status).toBe(409);
  });

  it("needs If-Match, and rejects a stale version", async () => {
    const ticket = await openTicket();

    const missing = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/transitions`)
      .set(bearer(agent))
      .send({ to: "pending" });
    expect(missing.status).toBe(428);

    const stale = await transition(agent, ticket.id, ticket.version - 1, "pending");
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("version_conflict");
  });

  it("resolve and escalate at the same moment: only one happens", async () => {
    const ticket = await openTicket();

    const results = await Promise.all([
      transition(agent, ticket.id, ticket.version, "resolved"),
      transition(agent2, ticket.id, ticket.version, "escalated"),
    ]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);

    const winner = results.find((res) => res.status === 200)!;
    const now = await request(app).get(`/api/v1/tickets/${ticket.id}`).set(bearer(agent));
    expect(now.body.status).toBe(winner.body.status);
    expect(now.body.version).toBe(ticket.version + 1);
  });
});
