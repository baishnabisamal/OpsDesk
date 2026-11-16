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

beforeAll(async () => {
  ({ requester, booking } = await createAgencyWithRequester());
  agent = await createUser("agent");
});

afterAll(closeTestPools);

type TicketBody = { id: string; version: number; status: string };

// A ticket the agent has taken: status open.
async function openTicket(): Promise<TicketBody> {
  const created = await request(app)
    .post("/api/v1/tickets")
    .set(bearer(requester))
    .set("Idempotency-Key", randomUUID())
    .send({ tboh: booking.tboh, subject: "Refund not received", body: "It has been 10 days." });
  const assigned = await request(app)
    .post(`/api/v1/tickets/${created.body.id}/assign`)
    .set(bearer(agent))
    .set("If-Match", '"1"')
    .send({ assignee_id: agent.id });
  expect(assigned.status).toBe(200);
  return assigned.body;
}

function post(user: TestUser, ticketId: string, body: object) {
  return request(app).post(`/api/v1/tickets/${ticketId}/messages`).set(bearer(user)).send(body);
}

function getMessages(user: TestUser, ticketId: string) {
  return request(app).get(`/api/v1/tickets/${ticketId}/messages`).set(bearer(user));
}

function getTimeline(user: TestUser, ticketId: string) {
  return request(app).get(`/api/v1/tickets/${ticketId}/timeline`).set(bearer(user));
}

function getTicket(user: TestUser, ticketId: string) {
  return request(app).get(`/api/v1/tickets/${ticketId}`).set(bearer(user));
}

function transition(user: TestUser, ticketId: string, version: number, to: string) {
  return request(app)
    .post(`/api/v1/tickets/${ticketId}/transitions`)
    .set(bearer(user))
    .set("If-Match", `"${version}"`)
    .send({ to });
}

describe("messages", () => {
  it("a public reply is stored and returned with its author", async () => {
    const ticket = await openTicket();
    const res = await post(agent, ticket.id, { body: "We are checking with the hotel." });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      ticket_id: ticket.id,
      author_id: agent.id,
      author_name: "Test agent",
      visibility: "public",
      body: "We are checking with the hotel.",
    });
  });

  it("lists messages oldest first", async () => {
    const ticket = await openTicket();
    await post(agent, ticket.id, { body: "first" });
    await post(requester, ticket.id, { body: "second" });
    await post(agent, ticket.id, { body: "third" });

    const res = await getMessages(agent, ticket.id);
    expect(res.body.items.map((m: { body: string }) => m.body)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("writes a timeline event and an outbox row with the message", async () => {
    const ticket = await openTicket();
    const message = await post(agent, ticket.id, { body: "hello" });

    const events = await ownerPool.query(
      `SELECT 1 FROM ticket_events
        WHERE ticket_id = $1 AND type = 'message_added' AND data->>'message_id' = $2`,
      [ticket.id, message.body.id],
    );
    const outbox = await ownerPool.query(
      "SELECT 1 FROM outbox WHERE ticket_id = $1 AND event_type = 'message.created'",
      [ticket.id],
    );
    expect(events.rowCount).toBe(1);
    expect(outbox.rowCount).toBe(1);
  });

  it("rejects an empty body and unknown fields", async () => {
    const ticket = await openTicket();
    expect((await post(agent, ticket.id, { body: "  " })).status).toBe(400);
    expect((await post(agent, ticket.id, { body: "x", author_id: requester.id })).status).toBe(400);
  });

  it("a closed ticket takes no more messages", async () => {
    const ticket = await openTicket();
    const resolved = await transition(agent, ticket.id, ticket.version, "resolved");
    await transition(agent, ticket.id, resolved.body.version, "closed");

    const res = await post(requester, ticket.id, { body: "One more thing" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ticket_closed");
  });
});

// Phase 1 gate: internal notes are invisible to requesters.
describe("internal notes", () => {
  it("staff can write and read an internal note", async () => {
    const ticket = await openTicket();
    const res = await post(agent, ticket.id, {
      body: "Hotel says no-show.",
      visibility: "internal",
    });
    expect(res.status).toBe(201);

    const list = await getMessages(agent, ticket.id);
    expect(list.body.items.map((m: { visibility: string }) => m.visibility)).toEqual(["internal"]);
  });

  it("a requester cannot write an internal note", async () => {
    const ticket = await openTicket();
    const res = await post(requester, ticket.id, { body: "sneaky", visibility: "internal" });
    expect(res.status).toBe(403);
  });

  it("a requester sees public replies but not internal notes", async () => {
    const ticket = await openTicket();
    await post(agent, ticket.id, { body: "PUBLIC reply" });
    await post(agent, ticket.id, { body: "SECRET note", visibility: "internal" });

    const res = await getMessages(requester, ticket.id);
    expect(res.status).toBe(200);
    expect(res.body.items.map((m: { body: string }) => m.body)).toEqual(["PUBLIC reply"]);
    expect(JSON.stringify(res.body)).not.toContain("SECRET");
  });

  it("the requester's timeline does not show that a note was written", async () => {
    const ticket = await openTicket();
    await post(agent, ticket.id, { body: "PUBLIC reply" });
    await post(agent, ticket.id, { body: "SECRET note", visibility: "internal" });

    const staffView = await getTimeline(agent, ticket.id);
    const requesterView = await getTimeline(requester, ticket.id);

    const added = (items: { type: string }[]) => items.filter((e) => e.type === "message_added");
    expect(added(staffView.body.items).length).toBe(2);
    expect(added(requesterView.body.items).length).toBe(1);
    expect(
      requesterView.body.items.every((e: { visibility: string }) => e.visibility === "public"),
    ).toBe(true);
  });
});

describe("reopen on reply", () => {
  it("a requester's reply moves a pending ticket back to open", async () => {
    const ticket = await openTicket();
    await transition(agent, ticket.id, ticket.version, "pending");

    const reply = await post(requester, ticket.id, { body: "Here is the document you asked for." });
    expect(reply.status).toBe(201);

    const now = await getTicket(agent, ticket.id);
    expect(now.body.status).toBe("open");
  });

  it("a requester's reply reopens a resolved ticket and clears resolved_at", async () => {
    const ticket = await openTicket();
    await transition(agent, ticket.id, ticket.version, "resolved");

    await post(requester, ticket.id, { body: "This is not fixed." });

    const now = await getTicket(agent, ticket.id);
    expect(now.body).toMatchObject({ status: "open", resolved_at: null });
  });

  it("an agent's reply does not change the status", async () => {
    const ticket = await openTicket();
    await transition(agent, ticket.id, ticket.version, "pending");

    await post(agent, ticket.id, { body: "Still waiting for your document." });

    const now = await getTicket(agent, ticket.id);
    expect(now.body.status).toBe("pending");
  });

  // Hazard 13 in README section 9.
  it("a reply racing with a close never lands on a closed ticket unseen", async () => {
    const ticket = await openTicket();
    const resolved = await transition(agent, ticket.id, ticket.version, "resolved");

    const [reply, close] = await Promise.all([
      post(requester, ticket.id, { body: "Wait, still broken!" }),
      transition(agent, ticket.id, resolved.body.version, "closed"),
    ]);

    const now = await getTicket(agent, ticket.id);
    const messages = await getMessages(agent, ticket.id);

    if (reply.status === 201) {
      // The reply got in: the ticket is open again and the close was refused.
      expect(close.status).toBe(409);
      expect(now.body.status).toBe("open");
      expect(messages.body.items.length).toBe(1);
    } else {
      // The close got in first: the reply was refused, loudly, with a 409.
      expect(close.status).toBe(200);
      expect(reply.status).toBe(409);
      expect(now.body.status).toBe("closed");
      expect(messages.body.items.length).toBe(0);
    }
  });
});

describe("timeline", () => {
  it("lists what happened to the ticket in order", async () => {
    const ticket = await openTicket();
    await transition(agent, ticket.id, ticket.version, "pending");

    const res = await getTimeline(requester, ticket.id);
    expect(res.status).toBe(200);
    const types = res.body.items.map((e: { type: string }) => e.type);
    expect(types[0]).toBe("ticket_created");
    expect(types).toContain("ticket_assigned");
    expect(types[types.length - 1]).toBe("status_changed");
  });
});
