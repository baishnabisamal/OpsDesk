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
let agent3: TestUser;
let lead: TestUser;

beforeAll(async () => {
  ({ requester, booking } = await createAgencyWithRequester());
  const teamA = await createTeam("EU");
  const teamB = await createTeam("EU");
  agent = await createUser("agent", { teamId: teamA });
  agent2 = await createUser("agent", { teamId: teamB });
  agent3 = await createUser("agent", { teamId: teamA });
  lead = await createUser("lead", { teamId: teamA });
});

afterAll(closeTestPools);

type TicketBody = {
  id: string;
  version: number;
  assignee_id: string | null;
  team_id: string | null;
};

async function createTicket(): Promise<TicketBody> {
  const res = await request(app)
    .post("/api/v1/tickets")
    .set(bearer(requester))
    .set("Idempotency-Key", randomUUID())
    .send({
      tboh: booking.tboh,
      subject: "Booking not found at hotel",
      body: "Guest at reception.",
    });
  expect(res.status).toBe(201);
  return res.body;
}

async function assign(ticket: TicketBody, to: TestUser): Promise<TicketBody> {
  const res = await request(app)
    .post(`/api/v1/tickets/${ticket.id}/assign`)
    .set(bearer(lead))
    .set("If-Match", `"${ticket.version}"`)
    .send({ assignee_id: to.id });
  expect(res.status).toBe(200);
  return res.body;
}

const HOTEL = [
  { email: "Reservations@Hotel-Lindenhof.example", name: "Front desk" },
  { email: "duty.manager@hotel-lindenhof.example", name: null },
];

function start(user: TestUser, ticketId: string, body: object = {}) {
  return request(app)
    .post(`/api/v1/tickets/${ticketId}/side-conversations`)
    .set(bearer(user))
    .send({
      subject: "Guest TBOH booking missing",
      participants: HOTEL,
      body: "Please confirm you have this reservation.",
      ...body,
    });
}

function reply(user: TestUser, conversationId: string, body = "Any news?") {
  return request(app)
    .post(`/api/v1/side-conversations/${conversationId}/messages`)
    .set(bearer(user))
    .send({ body });
}

function get(user: TestUser, conversationId: string) {
  return request(app).get(`/api/v1/side-conversations/${conversationId}`).set(bearer(user));
}

describe("side conversations", () => {
  it("an agent starts a thread with the hotel; the first message is outbound", async () => {
    const ticket = await assign(await createTicket(), agent);
    const res = await start(agent, ticket.id);

    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/api/v1/side-conversations/${res.body.id}`);
    expect(res.body).toMatchObject({
      ticket_id: ticket.id,
      subject: "Guest TBOH booking missing",
      status: "open",
      created_by: agent.id,
      // Stored lower-cased, sorted by address.
      participants: [
        { email: "duty.manager@hotel-lindenhof.example", name: null },
        { email: "reservations@hotel-lindenhof.example", name: "Front desk" },
      ],
    });
    expect(res.body.messages).toMatchObject([
      { direction: "outbound", author_id: agent.id, from_email: null },
    ]);
  });

  it("writes internal timeline events and an outbox row for the email worker", async () => {
    const ticket = await createTicket();
    const res = await start(agent, ticket.id);

    const events = await ownerPool.query<{ type: string; visibility: string }>(
      `SELECT type, visibility FROM ticket_events
        WHERE ticket_id = $1 AND type LIKE 'side_%' ORDER BY type`,
      [ticket.id],
    );
    expect(events.rows).toEqual([
      { type: "side_conversation_started", visibility: "internal" },
      { type: "side_message_added", visibility: "internal" },
    ]);

    const outbox = await ownerPool.query<{ payload: Record<string, string> }>(
      "SELECT payload FROM outbox WHERE ticket_id = $1 AND event_type = 'side_message.created'",
      [ticket.id],
    );
    expect(outbox.rows[0]!.payload).toMatchObject({
      side_conversation_id: res.body.id,
      side_message_id: res.body.messages[0].id,
      direction: "outbound",
    });
  });

  it("the same address twice, in different letter case, is one participant", async () => {
    const ticket = await createTicket();
    const res = await start(agent, ticket.id, {
      participants: [{ email: "a@hotel.example" }, { email: "A@HOTEL.example" }],
    });
    expect(res.body.participants).toEqual([{ email: "a@hotel.example", name: null }]);
  });

  it("any staff member can reply, and replies are listed in order", async () => {
    const ticket = await createTicket();
    const conversation = (await start(agent, ticket.id)).body;

    expect((await reply(agent2, conversation.id, "second")).status).toBe(201);
    expect((await reply(agent, conversation.id, "third")).status).toBe(201);

    const res = await get(lead, conversation.id);
    expect(res.body.messages.map((m: { body: string }) => m.body)).toEqual([
      "Please confirm you have this reservation.",
      "second",
      "third",
    ]);
  });

  it("lists a ticket's side conversations with their participants", async () => {
    const ticket = await createTicket();
    await start(agent, ticket.id, { subject: "First thread" });
    await start(agent, ticket.id, {
      subject: "Second thread",
      participants: [{ email: "x@y.example" }],
    });

    const res = await request(app)
      .get(`/api/v1/tickets/${ticket.id}/side-conversations`)
      .set(bearer(agent));
    expect(res.status).toBe(200);
    expect(res.body.items).toMatchObject([
      { subject: "First thread", participants: expect.arrayContaining([expect.any(Object)]) },
      { subject: "Second thread", participants: [{ email: "x@y.example", name: null }] },
    ]);
  });

  // Phase 4 gate: recipients survive two transfers.
  it("recipients are unchanged after the ticket is transferred twice", async () => {
    const ticket = await assign(await createTicket(), agent);
    const conversation = (await start(agent, ticket.id)).body;
    const before = conversation.participants;

    // Transfer to another team, then to a third agent.
    const moved = await assign(ticket, agent2);
    expect(moved.team_id).not.toBe(ticket.team_id);
    const movedAgain = await assign(moved, agent3);
    expect(movedAgain.assignee_id).toBe(agent3.id);

    const after = await get(agent3, conversation.id);
    expect(after.body.participants).toEqual(before);

    // The new owner's reply goes into the same thread, to the same people.
    const res = await reply(agent3, conversation.id, "Following up after the transfer.");
    expect(res.status).toBe(201);
    const thread = await get(agent3, conversation.id);
    expect(thread.body.participants).toEqual(before);
    expect(thread.body.messages.length).toBe(2);
  });

  it("is invisible to requesters: 404 on read and reply, 403 on start", async () => {
    const ticket = await createTicket();
    const conversation = (await start(agent, ticket.id)).body;

    expect((await get(requester, conversation.id)).status).toBe(404);
    expect((await reply(requester, conversation.id)).status).toBe(404);
    expect((await start(requester, ticket.id)).status).toBe(403);
    const list = await request(app)
      .get(`/api/v1/tickets/${ticket.id}/side-conversations`)
      .set(bearer(requester));
    expect(list.status).toBe(403);

    // Nor does the requester's timeline mention the thread.
    const timeline = await request(app)
      .get(`/api/v1/tickets/${ticket.id}/timeline`)
      .set(bearer(requester));
    const types = timeline.body.items.map((event: { type: string }) => event.type);
    expect(types.some((type: string) => type.startsWith("side_"))).toBe(false);
  });

  it("rejects bad input", async () => {
    const ticket = await createTicket();
    expect((await start(agent, ticket.id, { participants: [] })).status).toBe(400);
    expect(
      (await start(agent, ticket.id, { participants: [{ email: "not-an-email" }] })).status,
    ).toBe(400);
    expect((await start(agent, ticket.id, { body: " " })).status).toBe(400);
    expect((await get(agent, randomUUID())).status).toBe(404);
    expect((await get(agent, "nope")).status).toBe(404);
  });

  it("the database refuses an inbound message without a sender, or with an author", async () => {
    const ticket = await createTicket();
    const conversation = (await start(agent, ticket.id)).body;

    await expect(
      ownerPool.query(
        `INSERT INTO side_messages (side_conversation_id, ticket_id, direction, author_id, body)
         VALUES ($1, $2, 'inbound', $3, 'x')`,
        [conversation.id, ticket.id, agent.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
