import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { tx } from "../../src/db/tx.js";
import { SYSTEM_PRINCIPAL } from "../../src/domain/enums.js";
import { findLoadDrift } from "../../src/services/loadService.js";
import { retryRouting } from "../../src/services/routingService.js";
import {
  bearer,
  closeTestPools,
  createAgency,
  createBooking,
  createRoutableAgent,
  createTeam,
  createUser,
  ownerPool,
  type TestAgency,
  type TestBooking,
  type TestUser,
} from "./helpers.js";

// This file owns the APAC region: no other test file creates APAC bookings
// or agents, so nothing else can take these agents' capacity.
const REGION = "APAC";

const app = createApp();

let agency: TestAgency;
let requester: TestUser;
let booking: TestBooking;
let teamId: string;
let lead: TestUser;

beforeAll(async () => {
  agency = await createAgency();
  requester = await createUser("requester", { agencyId: agency.id });
  booking = await createBooking(agency.id, REGION);
  teamId = await createTeam(REGION);
  lead = await createUser("lead", { teamId });
});

// Every test starts with no agent online and an empty triage queue in this
// region, then creates the agents it needs.
beforeEach(async () => {
  await ownerPool.query(
    `UPDATE agent_presence SET is_online = false
      WHERE user_id IN (SELECT u.id FROM users u JOIN teams t ON t.id = u.team_id
                         WHERE t.region_code = $1)`,
    [REGION],
  );
  await ownerPool.query(
    `UPDATE tickets SET status = 'resolved', resolved_at = now()
      WHERE region_code = $1 AND assignee_id IS NULL AND status = 'new'`,
    [REGION],
  );
});

afterAll(closeTestPools);

type TicketBody = {
  id: string;
  version: number;
  status: string;
  assignee_id: string | null;
  team_id: string | null;
};

async function create(subject = "Refund not received", priority = "normal"): Promise<TicketBody> {
  const res = await request(app)
    .post("/api/v1/tickets")
    .set(bearer(requester))
    .set("Idempotency-Key", randomUUID())
    .send({ tboh: booking.tboh, subject, body: "Please check this booking.", priority });
  expect(res.status).toBe(201);
  return res.body;
}

function transition(user: TestUser, ticket: { id: string; version: number }, to: string) {
  return request(app)
    .post(`/api/v1/tickets/${ticket.id}/transitions`)
    .set(bearer(user))
    .set("If-Match", `"${ticket.version}"`)
    .send({ to });
}

function assign(user: TestUser, ticket: { id: string; version: number }, assigneeId: string) {
  return request(app)
    .post(`/api/v1/tickets/${ticket.id}/assign`)
    .set(bearer(user))
    .set("If-Match", `"${ticket.version}"`)
    .send({ assignee_id: assigneeId });
}

async function getTicket(id: string): Promise<TicketBody> {
  const res = await request(app).get(`/api/v1/tickets/${id}`).set(bearer(lead));
  return res.body;
}

async function openCount(agent: TestUser): Promise<number> {
  const result = await ownerPool.query<{ open_count: number }>(
    "SELECT open_count FROM agent_presence WHERE user_id = $1",
    [agent.id],
  );
  return result.rows[0]!.open_count;
}

// The stored counter of each of these agents must equal a fresh count of
// their live tickets.
async function expectNoDrift(agents: TestUser[]) {
  const drift = await tx(SYSTEM_PRINCIPAL, (db) => findLoadDrift(db));
  const ids = new Set(agents.map((agent) => agent.id));
  expect(drift.filter((row) => ids.has(row.user_id))).toEqual([]);
}

describe("routing on create", () => {
  it("gives a new ticket to the online agent and opens it", async () => {
    const agent = await createRoutableAgent(teamId);
    const ticket = await create();

    expect(ticket).toMatchObject({
      status: "open",
      assignee_id: agent.id,
      team_id: teamId,
      version: 2,
    });
    expect(await openCount(agent)).toBe(1);
  });

  it("records who was chosen and why", async () => {
    const skilled = await createRoutableAgent(teamId, { skills: ["refund"] });
    const offline = await createRoutableAgent(teamId, { online: false });
    const ticket = await create();

    const decisions = await ownerPool.query<{ outcome: string; chosen_id: string; details: never }>(
      "SELECT outcome, chosen_id, details FROM routing_decisions WHERE ticket_id = $1",
      [ticket.id],
    );
    expect(decisions.rows.length).toBe(1);
    const decision = decisions.rows[0]! as {
      outcome: string;
      chosen_id: string;
      details: {
        ranked: { userId: string; score: number; reasons: string[] }[];
        rejected: { userId: string; reason: string }[];
      };
    };
    expect(decision.outcome).toBe("assigned");
    expect(decision.chosen_id).toBe(skilled.id);
    expect(decision.details.ranked[0]).toMatchObject({
      userId: skilled.id,
      score: 80,
      reasons: ["has the refund skill (+40)", "0 of 5 open (+40)"],
    });
    expect(decision.details.rejected).toContainEqual(
      expect.objectContaining({ userId: offline.id, reason: "offline" }),
    );
  });

  it("writes the timeline as the system, in the same transaction as the ticket", async () => {
    const agent = await createRoutableAgent(teamId);
    const ticket = await create();

    const events = await ownerPool.query<{ type: string; actor_id: string | null; data: object }>(
      "SELECT type, actor_id, data FROM ticket_events WHERE ticket_id = $1 ORDER BY type",
      [ticket.id],
    );
    expect(events.rows).toEqual([
      { type: "status_changed", actor_id: null, data: { from: "new", to: "open" } },
      {
        type: "ticket_assigned",
        actor_id: null,
        data: { from: null, to: agent.id, by: "routing" },
      },
      expect.objectContaining({ type: "ticket_created", actor_id: requester.id }),
    ]);
  });

  it("prefers the agent with the matching skill", async () => {
    await createRoutableAgent(teamId);
    const skilled = await createRoutableAgent(teamId, { skills: ["refund"] });
    await createRoutableAgent(teamId, { skills: ["voucher"] });

    const ticket = await create("Refund not received");
    expect(ticket.assignee_id).toBe(skilled.id);
  });

  it("spreads tickets: the next one goes to the agent with more free capacity", async () => {
    const first = await createRoutableAgent(teamId);
    const second = await createRoutableAgent(teamId);

    const a = await create();
    const b = await create();
    expect(new Set([a.assignee_id, b.assignee_id])).toEqual(new Set([first.id, second.id]));
  });

  it("skips an agent who is at their limit", async () => {
    const full = await createRoutableAgent(teamId, { maxOpen: 1, skills: ["refund"] });
    const other = await createRoutableAgent(teamId);

    const a = await create(); // goes to the skilled agent, who is now full
    const b = await create();
    expect(a.assignee_id).toBe(full.id);
    expect(b.assignee_id).toBe(other.id);
  });

  it("leaves the ticket in triage when nobody can take it, and says why", async () => {
    const offline = await createRoutableAgent(teamId, { online: false });
    const ticket = await create();

    expect(ticket).toMatchObject({ status: "new", assignee_id: null, version: 1 });

    const decisions = await ownerPool.query<{ outcome: string; details: { rejected: object[] } }>(
      "SELECT outcome, details FROM routing_decisions WHERE ticket_id = $1",
      [ticket.id],
    );
    expect(decisions.rows[0]!.outcome).toBe("no_candidate");
    expect(decisions.rows[0]!.details.rejected).toContainEqual(
      expect.objectContaining({ userId: offline.id, reason: "offline" }),
    );
  });

  it("never routes to an agent of another region", async () => {
    const otherTeam = await createTeam("MEA");
    const elsewhere = await createUser("agent", { teamId: otherTeam });
    // Online and free, but in the wrong region. (No shifts row is needed to
    // prove the point: the region filter comes first.)
    await ownerPool.query("INSERT INTO agent_presence (user_id, is_online) VALUES ($1, true)", [
      elsewhere.id,
    ]);

    const ticket = await create();
    expect(ticket.assignee_id).toBeNull();
    await ownerPool.query("UPDATE agent_presence SET is_online = false WHERE user_id = $1", [
      elsewhere.id,
    ]);
  });
});

// Phase 3 gate, hazard 4 in README section 9.
describe("100 simultaneous creates", () => {
  it("never put an agent above their limit and never double-assign", async () => {
    // 5 agents who can hold 5 tickets each: room for 25 of the 100.
    const agents = await Promise.all(
      Array.from({ length: 5 }, () => createRoutableAgent(teamId, { maxOpen: 5 })),
    );
    const agentIds = agents.map((agent) => agent.id);

    const tickets = await Promise.all(
      Array.from({ length: 100 }, (_, i) => create(`Refund question number ${i}`)),
    );
    expect(new Set(tickets.map((ticket) => ticket.id)).size).toBe(100);

    // No agent is above their limit...
    const presence = await ownerPool.query<{ user_id: string; open_count: number }>(
      "SELECT user_id, open_count FROM agent_presence WHERE user_id = ANY($1)",
      [agentIds],
    );
    for (const row of presence.rows) {
      expect(row.open_count).toBeLessThanOrEqual(5);
    }

    // ...every stored counter equals a recount of that agent's tickets...
    await expectNoDrift(agents);

    // ...and every ticket is either with exactly one of the agents and open,
    // or with nobody and still new. Nothing in between.
    const ids = tickets.map((ticket) => ticket.id);
    const rows = await ownerPool.query<{ status: string; assignee_id: string | null }>(
      "SELECT status, assignee_id FROM tickets WHERE id = ANY($1)",
      [ids],
    );
    const assigned = rows.rows.filter((row) => row.assignee_id !== null);
    const waiting = rows.rows.filter((row) => row.assignee_id === null);
    expect(
      assigned.every((row) => row.status === "open" && agentIds.includes(row.assignee_id!)),
    ).toBe(true);
    expect(waiting.every((row) => row.status === "new")).toBe(true);
    expect(assigned.length).toBeLessThanOrEqual(25);
    expect(assigned.length).toBeGreaterThan(0);

    // One routing decision per ticket: nothing was routed twice.
    const decisions = await ownerPool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM routing_decisions WHERE ticket_id = ANY($1)",
      [ids],
    );
    expect(decisions.rows[0]!.n).toBe(100);

    // Under contention a create does not wait for a busy agent row, so some
    // capacity can be left unused at first. The retry job fills it exactly.
    await retryRouting({ regionCode: REGION });

    const after = await ownerPool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM tickets WHERE id = ANY($1) AND assignee_id IS NOT NULL",
      [ids],
    );
    expect(after.rows[0]!.n).toBe(25);
    for (const agent of agents) {
      expect(await openCount(agent)).toBe(5);
    }
    await expectNoDrift(agents);
  }, 60_000);
});

describe("the routing retry job", () => {
  it("assigns waiting tickets once an agent comes online", async () => {
    const first = await create();
    const second = await create();
    expect(first.status).toBe("new");

    const agent = await createRoutableAgent(teamId, { online: false });
    const online = await request(app)
      .put("/api/v1/me/presence")
      .set(bearer(agent))
      .send({ online: true });
    expect(online.status).toBe(200);
    expect(online.body).toMatchObject({ user_id: agent.id, is_online: true, open_count: 0 });

    const result = await retryRouting({ regionCode: REGION });
    expect(result).toEqual({ examined: 2, assigned: 2 });

    expect((await getTicket(first.id)).assignee_id).toBe(agent.id);
    expect((await getTicket(second.id)).status).toBe("open");
    expect(await openCount(agent)).toBe(2);
  });

  it("takes the most urgent deadline first", async () => {
    const normal = await create("Refund not received", "normal");
    const urgent = await create("Refund not received", "urgent");

    await createRoutableAgent(teamId, { maxOpen: 1 });
    await retryRouting({ regionCode: REGION });

    // Room for one ticket only: the urgent one gets it.
    expect((await getTicket(urgent.id)).status).toBe("open");
    expect((await getTicket(normal.id)).status).toBe("new");
  });

  it("does nothing, and records nothing, when nobody is available", async () => {
    const ticket = await create();
    const result = await retryRouting({ regionCode: REGION });

    expect(result).toEqual({ examined: 1, assigned: 0 });
    const decisions = await ownerPool.query(
      "SELECT 1 FROM routing_decisions WHERE ticket_id = $1",
      [ticket.id],
    );
    expect(decisions.rowCount).toBe(1); // only the one from create
  });

  // Hazard 5 in README section 9.
  it("two workers running at once never assign the same ticket twice", async () => {
    const tickets = await Promise.all(Array.from({ length: 12 }, () => create()));
    const agents = await Promise.all(
      Array.from({ length: 3 }, () => createRoutableAgent(teamId, { maxOpen: 3 })),
    );

    const [one, two] = await Promise.all([
      retryRouting({ regionCode: REGION }),
      retryRouting({ regionCode: REGION }),
    ]);

    // 9 places, 12 tickets. Workers skip rows the other one holds, so a
    // third pass may be needed to use the last places.
    await retryRouting({ regionCode: REGION });
    expect(one.assigned + two.assigned).toBeLessThanOrEqual(9);

    const rows = await ownerPool.query<{ assignee_id: string | null }>(
      "SELECT assignee_id FROM tickets WHERE id = ANY($1)",
      [tickets.map((ticket) => ticket.id)],
    );
    expect(rows.rows.filter((row) => row.assignee_id !== null).length).toBe(9);

    // One "assigned" event per assigned ticket: no ticket was assigned twice.
    const events = await ownerPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ticket_events
        WHERE ticket_id = ANY($1) AND type = 'ticket_assigned'`,
      [tickets.map((ticket) => ticket.id)],
    );
    expect(events.rows[0]!.n).toBe(9);

    for (const agent of agents) expect(await openCount(agent)).toBe(3);
    await expectNoDrift(agents);
  });
});

describe("PUT /me/presence", () => {
  it("creates the presence row the first time, then switches it", async () => {
    const agent = await createUser("agent", { teamId });

    const on = await request(app)
      .put("/api/v1/me/presence")
      .set(bearer(agent))
      .send({ online: true });
    expect(on.body).toMatchObject({ is_online: true, open_count: 0, max_open: 5 });

    const off = await request(app)
      .put("/api/v1/me/presence")
      .set(bearer(agent))
      .send({ online: false });
    expect(off.body.is_online).toBe(false);
  });

  it("going offline keeps the tickets the agent already has", async () => {
    const agent = await createRoutableAgent(teamId);
    const ticket = await create();

    await request(app).put("/api/v1/me/presence").set(bearer(agent)).send({ online: false });

    expect((await getTicket(ticket.id)).assignee_id).toBe(agent.id);
    expect(await openCount(agent)).toBe(1);
    // But new tickets no longer come to them.
    expect((await create()).assignee_id).toBeNull();
  });

  it("is not for requesters, and validates the body", async () => {
    const asRequester = await request(app)
      .put("/api/v1/me/presence")
      .set(bearer(requester))
      .send({ online: true });
    expect(asRequester.status).toBe(403);

    const agent = await createUser("agent", { teamId });
    const bad = await request(app)
      .put("/api/v1/me/presence")
      .set(bearer(agent))
      .send({ online: "yes" });
    expect(bad.status).toBe(400);
  });
});

describe("agent load follows the ticket", () => {
  it("resolving releases the agent, reopening takes a place again", async () => {
    const agent = await createRoutableAgent(teamId);
    const ticket = await create();
    expect(await openCount(agent)).toBe(1);

    const resolved = await transition(agent, ticket, "resolved");
    expect(await openCount(agent)).toBe(0);

    await transition(agent, resolved.body, "open");
    expect(await openCount(agent)).toBe(1);
    await expectNoDrift([agent]);
  });

  it("a reopen by the requester counts too", async () => {
    // The requester's own identity cannot see agent tables (RLS), so this
    // proves the counter update really runs as the system.
    const agent = await createRoutableAgent(teamId);
    const ticket = await create();
    const resolved = await transition(agent, ticket, "resolved");

    const reopened = await transition(requester, resolved.body, "open");
    expect(reopened.status).toBe(200);
    expect(reopened.body.assignee_id).toBe(agent.id);
    expect(await openCount(agent)).toBe(1);
    await expectNoDrift([agent]);
  });

  it("pending still counts as load", async () => {
    const agent = await createRoutableAgent(teamId);
    const ticket = await create();
    await transition(agent, ticket, "pending");
    expect(await openCount(agent)).toBe(1);
  });

  it("a ticket reopened while its agent is full goes back to triage", async () => {
    const agent = await createRoutableAgent(teamId, { maxOpen: 1 });
    const first = await create();
    const resolved = await transition(agent, first, "resolved");
    const second = await create(); // takes the agent's only place
    expect(second.assignee_id).toBe(agent.id);

    const reopened = await transition(requester, resolved.body, "open");
    expect(reopened.status).toBe(200);
    expect(reopened.body).toMatchObject({ status: "open", assignee_id: null });
    expect(await openCount(agent)).toBe(1); // still within the limit
    await expectNoDrift([agent]);
  });

  it("a manual assign to a full agent is refused and changes nothing", async () => {
    const full = await createRoutableAgent(teamId, { maxOpen: 1 });
    await create(); // fills the agent
    await ownerPool.query("UPDATE agent_presence SET is_online = false WHERE user_id = $1", [
      full.id,
    ]);
    const waiting = await create();
    expect(waiting.status).toBe("new");

    const res = await assign(lead, waiting, full.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("agent_at_capacity");

    // The ticket change was rolled back together with the failed counter change.
    expect(await getTicket(waiting.id)).toMatchObject({
      status: "new",
      assignee_id: null,
      version: 1,
    });
    expect(await openCount(full)).toBe(1);
  });

  it("a transfer moves the load from one agent to the other", async () => {
    const from = await createRoutableAgent(teamId);
    const to = await createRoutableAgent(teamId, { online: false });
    const ticket = await create();
    expect(ticket.assignee_id).toBe(from.id);

    const res = await assign(lead, ticket, to.id);
    expect(res.status).toBe(200);
    expect(await openCount(from)).toBe(0);
    expect(await openCount(to)).toBe(1);
  });

  // Hazard 16 in README section 9.
  it("transfers in opposite directions at once leave the counters right", async () => {
    const a = await createRoutableAgent(teamId, { maxOpen: 10, online: false });
    const b = await createRoutableAgent(teamId, { maxOpen: 10, online: false });

    // Four tickets with A and four with B.
    const withA: TicketBody[] = [];
    const withB: TicketBody[] = [];
    for (let i = 0; i < 4; i++) {
      withA.push((await assign(lead, await create(), a.id)).body);
      withB.push((await assign(lead, await create(), b.id)).body);
    }

    // Swap them all at the same moment: A's go to B while B's go to A.
    const results = await Promise.all([
      ...withA.map((ticket) => assign(lead, ticket, b.id)),
      ...withB.map((ticket) => assign(lead, ticket, a.id)),
    ]);
    expect(results.map((res) => res.status)).toEqual(Array(8).fill(200));

    expect(await openCount(a)).toBe(4);
    expect(await openCount(b)).toBe(4);
    await expectNoDrift([a, b]);
  });
});

describe("escalation changes the owner", () => {
  it("an escalated ticket goes to the region's escalation manager and frees the agent", async () => {
    const manager = await createUser("escalation_manager", { teamId });
    const agent = await createRoutableAgent(teamId);
    const ticket = await create();

    const escalated = await transition(agent, ticket, "escalated");
    expect(escalated.status).toBe(200);
    expect(escalated.body).toMatchObject({ status: "escalated", assignee_id: manager.id });
    expect(await openCount(agent)).toBe(0);

    const events = await ownerPool.query<{ data: object }>(
      `SELECT data FROM ticket_events
        WHERE ticket_id = $1 AND type = 'ticket_assigned' AND data->>'by' = 'escalation'`,
      [ticket.id],
    );
    expect(events.rows).toEqual([{ data: { from: agent.id, to: manager.id, by: "escalation" } }]);

    // De-escalating sends it back to triage, to be routed again.
    const back = await transition(manager, escalated.body, "open");
    expect(back.body).toMatchObject({ status: "open", assignee_id: null });

    await ownerPool.query("UPDATE users SET is_active = false WHERE id = $1", [manager.id]);
  });

  it("the escalate and de-escalate endpoints do the same as the transition", async () => {
    const manager = await createUser("escalation_manager", { teamId });
    const agent = await createRoutableAgent(teamId);
    const ticket = await create();

    const escalated = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/escalate`)
      .set(bearer(agent))
      .set("If-Match", `"${ticket.version}"`);
    expect(escalated.status).toBe(200);
    expect(escalated.body).toMatchObject({ status: "escalated", assignee_id: manager.id });

    // An agent may not de-escalate; the manager may.
    const byAgent = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/de-escalate`)
      .set(bearer(agent))
      .set("If-Match", `"${escalated.body.version}"`);
    expect(byAgent.status).toBe(403);

    const byManager = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/de-escalate`)
      .set(bearer(manager))
      .set("If-Match", `"${escalated.body.version}"`);
    expect(byManager.body.status).toBe("open");

    await ownerPool.query("UPDATE users SET is_active = false WHERE id = $1", [manager.id]);
  });
});

describe("the database is the backstop", () => {
  it("refuses a counter above the limit or below zero", async () => {
    const agent = await createRoutableAgent(teamId, { maxOpen: 2 });

    await expect(
      ownerPool.query("UPDATE agent_presence SET open_count = 3 WHERE user_id = $1", [agent.id]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      ownerPool.query("UPDATE agent_presence SET open_count = -1 WHERE user_id = $1", [agent.id]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
