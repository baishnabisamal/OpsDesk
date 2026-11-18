import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { io as connect, type Socket } from "socket.io-client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createRedis } from "../../src/core/redis.js";
import { createGateway, type TicketEventMessage } from "../../src/realtime/gateway.js";
import { startRelay } from "../../src/services/outboxRelay.js";
import {
  bearer,
  closeTestPools,
  createAgencyWithRequester,
  createUser,
  type TestBooking,
  type TestUser,
} from "./helpers.js";

// The whole path, for real: API request -> outbox row -> relay -> Redis
// Stream -> gateway -> Socket.IO -> client.

const app = createApp();

let httpServer: Server;
let gateway: ReturnType<typeof createGateway>;
let stopRelay: () => Promise<void>;
let url: string;

let requesterA: TestUser;
let bookingA: TestBooking;
let requesterB: TestUser;
let agent: TestUser;

const sockets: Socket[] = [];

beforeAll(async () => {
  ({ requester: requesterA, booking: bookingA } = await createAgencyWithRequester());
  ({ requester: requesterB } = await createAgencyWithRequester());
  agent = await createUser("agent");

  httpServer = createServer();
  gateway = createGateway(httpServer, createRedis());
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

  stopRelay = startRelay(createRedis(), { intervalMs: 50 });
});

afterAll(async () => {
  for (const socket of sockets) socket.disconnect();
  await stopRelay();
  await gateway.close();
  await closeTestPools();
});

// A connected client that records every event it receives.
async function client(token: string | undefined) {
  const events: TicketEventMessage[] = [];
  const socket = connect(url, { auth: token ? { token } : {}, transports: ["websocket"] });
  sockets.push(socket);
  socket.on("ticket_event", (event: TicketEventMessage) => events.push(event));
  await new Promise<void>((resolve, reject) => {
    socket.on("connect", () => resolve());
    socket.on("connect_error", (err) => reject(err));
  });
  return { socket, events };
}

async function waitFor<T>(find: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = find();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function createTicket() {
  const res = await request(app)
    .post("/api/v1/tickets")
    .set(bearer(requesterA))
    .set("Idempotency-Key", randomUUID())
    .send({ tboh: bookingA.tboh, subject: "Refund not received", body: "Please check." });
  expect(res.status).toBe(201);
  return res.body as { id: string; version: number };
}

async function openTicket() {
  const ticket = await createTicket();
  const res = await request(app)
    .post(`/api/v1/tickets/${ticket.id}/assign`)
    .set(bearer(agent))
    .set("If-Match", `"${ticket.version}"`)
    .send({ assignee_id: agent.id });
  return res.body as { id: string; version: number };
}

describe("the WebSocket gateway", () => {
  it("refuses a connection without a valid token", async () => {
    await expect(client(undefined)).rejects.toThrow("unauthorized");
    await expect(client("not-a-real-token")).rejects.toThrow("unauthorized");
  });

  // Phase 4 gate: a state change reaches a connected client within 2 s.
  it("a status change reaches the agency's connected client within 2 seconds", async () => {
    const watcher = await client(requesterA.token);
    const ticket = await openTicket();

    const startedAt = Date.now();
    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/transitions`)
      .set(bearer(agent))
      .set("If-Match", `"${ticket.version}"`)
      .send({ to: "pending" });
    expect(res.status).toBe(200);

    const event = await waitFor(() =>
      watcher.events.find(
        (e) =>
          e.ticket_id === ticket.id &&
          e.type === "ticket.status_changed" &&
          e.payload.to === "pending",
      ),
    );
    const elapsed = Date.now() - startedAt;

    expect(event).toMatchObject({ payload: { from: "open", to: "pending" } });
    expect(event.event_id).toMatch(/^\d+$/);
    expect(elapsed).toBeLessThan(2000);
    console.log(`status change reached the client in ${elapsed} ms`);
  });

  it("staff receive staff-only events; the agency does not", async () => {
    const staff = await client(agent.token);
    const agency = await client(requesterA.token);
    const ticket = await openTicket(); // the assignment is a staff-only event

    await waitFor(() =>
      staff.events.find((e) => e.ticket_id === ticket.id && e.type === "ticket.assigned"),
    );
    // The agency did receive the ticket's creation...
    await waitFor(() =>
      agency.events.find((e) => e.ticket_id === ticket.id && e.type === "ticket.created"),
    );
    // ...but not the assignment.
    expect(
      agency.events.some((e) => e.ticket_id === ticket.id && e.type === "ticket.assigned"),
    ).toBe(false);
  });

  it("an internal note is pushed to staff only; a public reply to both", async () => {
    const staff = await client(agent.token);
    const agency = await client(requesterA.token);
    const ticket = await openTicket();

    const note = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/messages`)
      .set(bearer(agent))
      .send({ body: "Hotel says no-show.", visibility: "internal" });
    const reply = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/messages`)
      .set(bearer(agent))
      .send({ body: "We are on it." });

    const messageEvent = (events: TicketEventMessage[], messageId: string) =>
      events.find((e) => e.type === "message.created" && e.payload.message_id === messageId);

    await waitFor(() => messageEvent(staff.events, note.body.id));
    await waitFor(() => messageEvent(staff.events, reply.body.id));
    await waitFor(() => messageEvent(agency.events, reply.body.id));
    // The public reply arrived after the note, so the note had its chance.
    expect(messageEvent(agency.events, note.body.id)).toBeUndefined();
  });

  it("an agency never receives another agency's events", async () => {
    const other = await client(requesterB.token);
    const mine = await client(requesterA.token);
    const ticket = await createTicket();

    await waitFor(() => mine.events.find((e) => e.ticket_id === ticket.id));
    await pause(200);
    expect(other.events.some((e) => e.ticket_id === ticket.id)).toBe(false);
  });

  it("a repeated event has the same event id and the same content, so a client can drop it", async () => {
    // Delivery is at-least-once: another test file (relay.test.ts) publishes
    // events twice on purpose, and this staff client receives those copies.
    const staff = await client(agent.token);
    await openTicket();
    await pause(500);

    const byId = new Map<string, TicketEventMessage[]>();
    for (const event of staff.events) {
      byId.set(event.event_id, [...(byId.get(event.event_id) ?? []), event]);
    }
    for (const copies of byId.values()) {
      // Every copy of an event id is the same event.
      for (const copy of copies) {
        expect({ type: copy.type, ticket: copy.ticket_id, payload: copy.payload }).toEqual({
          type: copies[0]!.type,
          ticket: copies[0]!.ticket_id,
          payload: copies[0]!.payload,
        });
      }
    }
    // What a client does: keep the first copy of each id.
    const seen = new Set<string>();
    const unique = staff.events.filter(
      (event) => !seen.has(event.event_id) && seen.add(event.event_id),
    );
    expect(unique.length).toBe(byId.size);
  });
});
