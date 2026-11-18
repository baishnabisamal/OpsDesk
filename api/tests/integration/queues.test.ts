import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
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

// This file owns the MEA region. Its agents have no presence row, so nothing
// is routed automatically: tickets are placed in queues by hand.
const REGION = "MEA";

const app = createApp();

let agency: TestAgency;
let requester: TestUser;
let teamId: string;
let agent: TestUser;
let otherAgent: TestUser;
let lead: TestUser;
let manager: TestUser;

beforeAll(async () => {
  agency = await createAgency();
  requester = await createUser("requester", { agencyId: agency.id });
  teamId = await createTeam(REGION);
  agent = await createUser("agent", { teamId });
  otherAgent = await createUser("agent", { teamId });
  lead = await createUser("lead", { teamId });
  manager = await createUser("escalation_manager", { teamId });
});

afterAll(closeTestPools);

type TicketBody = {
  id: string;
  version: number;
  status: string;
  sla_due_at: string;
  sla_state: string;
};

async function create(
  options: { booking?: TestBooking; subject?: string; priority?: string } = {},
): Promise<TicketBody> {
  const booking = options.booking ?? (await createBooking(agency.id, REGION));
  const res = await request(app)
    .post("/api/v1/tickets")
    .set(bearer(requester))
    .set("Idempotency-Key", randomUUID())
    .send({
      tboh: booking.tboh,
      subject: options.subject ?? "Refund not received",
      body: "Please check.",
      priority: options.priority ?? "normal",
    });
  expect(res.status).toBe(201);
  return res.body;
}

async function assignTo(ticket: TicketBody, user: TestUser): Promise<TicketBody> {
  const res = await request(app)
    .post(`/api/v1/tickets/${ticket.id}/assign`)
    .set(bearer(lead))
    .set("If-Match", `"${ticket.version}"`)
    .send({ assignee_id: user.id });
  expect(res.status).toBe(200);
  return res.body;
}

function transition(user: TestUser, ticket: TicketBody, to: string) {
  return request(app)
    .post(`/api/v1/tickets/${ticket.id}/transitions`)
    .set(bearer(user))
    .set("If-Match", `"${ticket.version}"`)
    .send({ to });
}

function queue(user: TestUser, name: string, query: Record<string, string | number> = {}) {
  return request(app)
    .get(`/api/v1/queues/${name}`)
    .set(bearer(user))
    .query({ limit: 100, ...query });
}

async function idsIn(user: TestUser, name: string, query: Record<string, string | number> = {}) {
  const res = await queue(user, name, query);
  expect(res.status).toBe(200);
  return res.body.items.map((ticket: { id: string }) => ticket.id) as string[];
}

describe("queues", () => {
  it("triage holds live tickets that nobody owns", async () => {
    const unowned = await create();
    const owned = await assignTo(await create(), agent);

    const ids = await idsIn(lead, "triage");
    expect(ids).toContain(unowned.id);
    expect(ids).not.toContain(owned.id);
  });

  it("mine holds the caller's live tickets, including pending, but not resolved ones", async () => {
    const open = await assignTo(await create(), agent);
    const pending = (await transition(agent, await assignTo(await create(), agent), "pending"))
      .body;
    const resolved = (await transition(agent, await assignTo(await create(), agent), "resolved"))
      .body;
    const someoneElses = await assignTo(await create(), otherAgent);

    const ids = await idsIn(agent, "mine");
    expect(ids).toContain(open.id);
    expect(ids).toContain(pending.id);
    expect(ids).not.toContain(resolved.id);
    expect(ids).not.toContain(someoneElses.id);
  });

  it("region, team and intent queues filter on what they say", async () => {
    const refund = await assignTo(await create({ subject: "Refund not received" }), agent);
    const voucher = await create({ subject: "Voucher shows wrong dates" });

    expect(await idsIn(lead, "region", { region: REGION })).toEqual(
      expect.arrayContaining([refund.id, voucher.id]),
    );
    expect(await idsIn(lead, "region", { region: "EU" })).not.toContain(refund.id);

    // The team queue defaults to the caller's own team.
    expect(await idsIn(agent, "team")).toContain(refund.id);

    const refunds = await idsIn(lead, "intent", { intent: "refund" });
    expect(refunds).toContain(refund.id);
    expect(refunds).not.toContain(voucher.id);
  });

  it("escalations holds escalated tickets", async () => {
    const ticket = await assignTo(await create(), agent);
    const escalated = (await transition(agent, ticket, "escalated")).body;
    expect(escalated.status).toBe("escalated");

    const ids = await idsIn(manager, "escalations");
    expect(ids).toContain(ticket.id);
    expect(await idsIn(lead, "triage")).not.toContain(ticket.id);
  });

  it("linked holds tickets that share a case or have a link, and not lonely ones", async () => {
    const booking = await createBooking(agency.id, REGION);
    const first = await create({ booking });
    const second = await create({ booking, subject: "Any news on the refund?" });
    const alone = await create();
    const linkedA = await create();
    const linkedB = await create({ subject: "Voucher shows wrong dates" });
    const link = await request(app)
      .post(`/api/v1/tickets/${linkedA.id}/links`)
      .set(bearer(agent))
      .send({ ticket_id: linkedB.id });
    expect(link.status).toBe(204);

    const ids = await idsIn(lead, "linked");
    expect(ids).toEqual(expect.arrayContaining([first.id, second.id, linkedA.id, linkedB.id]));
    expect(ids).not.toContain(alone.id);
  });

  it("puts the soonest deadline first", async () => {
    const low = await create({ priority: "low" });
    const urgent = await create({ priority: "urgent" });

    const res = await queue(lead, "region", { region: REGION });
    const ids: string[] = res.body.items.map((ticket: { id: string }) => ticket.id);
    expect(ids.indexOf(urgent.id)).toBeLessThan(ids.indexOf(low.id));

    const deadlines = res.body.items.map((ticket: TicketBody) => ticket.sla_due_at);
    expect(deadlines).toEqual([...deadlines].sort());
  });

  it("can show only the tickets in trouble", async () => {
    const fine = await create();
    const late = await create();
    await ownerPool.query("UPDATE tickets SET sla_state = 'breached' WHERE id = $1", [late.id]);

    const ids = await idsIn(lead, "triage", { sla_state: "breached" });
    expect(ids).toContain(late.id);
    expect(ids).not.toContain(fine.id);
  });

  it("pages through a queue with no repeats and no gaps", async () => {
    const team = await createTeam(REGION);
    const pager = await createUser("agent", { teamId: team });
    const mine: TicketBody[] = [];
    for (let i = 0; i < 7; i++) mine.push(await assignTo(await create(), pager));

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: Record<string, string | number> = { limit: 3 };
      if (cursor) query.cursor = cursor;
      const res = await queue(pager, "mine", query);
      seen.push(...res.body.items.map((ticket: { id: string }) => ticket.id));
      cursor = res.body.next_cursor;
    } while (cursor);

    expect(seen.length).toBe(7);
    expect(new Set(seen)).toEqual(new Set(mine.map((ticket) => ticket.id)));
  });

  it("is for staff only", async () => {
    const res = await queue(requester, "triage");
    expect(res.status).toBe(403);
  });

  it("answers 404 for an unknown queue and 400 for a missing or bad parameter", async () => {
    expect((await queue(lead, "everything")).status).toBe(404);
    expect((await queue(lead, "region")).status).toBe(400);
    expect((await queue(lead, "region", { region: "MARS" })).status).toBe(400);
    expect((await queue(lead, "intent")).status).toBe(400);
    expect((await queue(lead, "triage", { cursor: "garbage" })).status).toBe(400);
  });
});

// Each queue must be answered from its partial index, already in deadline
// order, without reading the whole table or sorting. On a test table this
// small PostgreSQL might choose a full scan anyway, so full and bitmap scans
// are switched off for the check. What is left proves the index FITS the query.
describe("each queue uses its partial index", () => {
  const UUID = "00000000-0000-4000-8000-000000000000";
  const LIVE = "status IN ('new', 'open', 'pending', 'escalated')";

  const cases: [string, string, string][] = [
    ["triage", "assignee_id IS NULL AND status IN ('new', 'open')", "tickets_triage"],
    [
      "mine",
      `assignee_id = '${UUID}' AND status IN ('open', 'pending', 'escalated')`,
      "tickets_assignee_queue",
    ],
    ["region", `region_code = 'MEA' AND ${LIVE}`, "tickets_region_queue"],
    ["team", `team_id = '${UUID}' AND ${LIVE}`, "tickets_team_queue"],
    ["intent", `intent = 'refund' AND ${LIVE}`, "tickets_intent_queue"],
    ["escalations", "status = 'escalated'", "tickets_escalated_queue"],
  ];

  for (const [name, where, index] of cases) {
    it(`${name} -> ${index}`, async () => {
      const client = await ownerPool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL enable_seqscan = off");
        await client.query("SET LOCAL enable_bitmapscan = off");
        const plan = await client.query<{ "QUERY PLAN": string }>(
          `EXPLAIN SELECT id FROM tickets WHERE ${where} ORDER BY sla_due_at, id LIMIT 51`,
        );
        await client.query("ROLLBACK");
        const text = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
        expect(text).toContain(index);
        expect(text).not.toContain("Sort");
      } finally {
        client.release();
      }
    });
  }
});
