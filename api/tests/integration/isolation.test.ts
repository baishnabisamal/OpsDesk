import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { ticketsRouter } from "../../src/routes/tickets.js";
import {
  bearer,
  closeTestPools,
  createAgencyWithRequester,
  createUser,
  type TestUser,
} from "./helpers.js";

// Phase 1 gate: Agency A gets 404 on Agency B's ids on every route.
//
// Agency B owns a real ticket. A requester from Agency A calls every route
// that takes a ticket id. Each must answer 404, exactly as it does for an id
// that does not exist, so A cannot even learn that the ticket is there.

const app = createApp();

let requesterA: TestUser;
let requesterB: TestUser;
let agent: TestUser;
let ticketOfB: string;

beforeAll(async () => {
  const a = await createAgencyWithRequester();
  const b = await createAgencyWithRequester();
  requesterA = a.requester;
  requesterB = b.requester;
  agent = await createUser("agent");

  const created = await request(app)
    .post("/api/v1/tickets")
    .set(bearer(requesterB))
    .set("Idempotency-Key", randomUUID())
    .send({ tboh: b.booking.tboh, subject: "Private to agency B", body: "Agency B only." });
  expect(created.status).toBe(201);
  ticketOfB = created.body.id;

  // Give the ticket some content worth hiding.
  await request(app)
    .post(`/api/v1/tickets/${ticketOfB}/messages`)
    .set(bearer(requesterB))
    .send({ body: "A reply from agency B" });
});

afterAll(closeTestPools);

// A valid request body for every route that takes a ticket id. The bodies are
// valid on purpose: an invalid one would get a 400 before the id is looked at.
const ROUTE_BODIES: Record<string, object | null> = {
  "GET /:id": null,
  "PATCH /:id": { priority: "high" },
  "POST /:id/transitions": { to: "closed" },
  "POST /:id/assign": { assignee_id: randomUUID() },
  "PUT /:id/intent": { intent: "refund" },
  "POST /:id/messages": { body: "hello" },
  "GET /:id/messages": null,
  "GET /:id/timeline": null,
  "POST /:id/escalate": null,
  "POST /:id/de-escalate": null,
  "GET /:id/archived-timeline": null,
  "GET /:id/side-conversations": null,
  "POST /:id/side-conversations": {
    subject: "Hello",
    participants: [{ email: "res@hotel.example" }],
    body: "Hi",
  },
  "GET /:id/links": null,
  "POST /:id/links": { ticket_id: randomUUID() },
  "DELETE /:id/links/:linkedId": null,
};

// Reads the real list of routes out of the Express router, so a route added
// later cannot be forgotten: it shows up here automatically.
function routesWithTicketId(): string[] {
  const found: string[] = [];
  for (const layer of ticketsRouter.stack) {
    const route = layer.route as { path: string; methods: Record<string, boolean> } | undefined;
    if (!route || !route.path.includes(":id")) continue;
    for (const method of Object.keys(route.methods)) {
      found.push(`${method.toUpperCase()} ${route.path}`);
    }
  }
  return found.sort();
}

function call(user: TestUser, routeKey: string, ticketId: string) {
  const [method, path] = routeKey.split(" ") as [string, string];
  const url = `/api/v1/tickets${path.replace(":id", ticketId).replace(":linkedId", randomUUID())}`;
  const httpMethod = method.toLowerCase() as "get" | "post" | "patch" | "put" | "delete";
  const agent = request(app);
  const req = agent[httpMethod](url).set(bearer(user)).set("If-Match", '"1"');
  const body = ROUTE_BODIES[routeKey];
  return body ? req.send(body) : req;
}

describe("tenant isolation sweep", () => {
  it("the sweep covers every route that takes a ticket id", () => {
    expect(routesWithTicketId()).toEqual(Object.keys(ROUTE_BODIES).sort());
  });

  for (const routeKey of Object.keys(ROUTE_BODIES)) {
    it(`${routeKey}: agency A gets 404 for agency B's ticket`, async () => {
      const hidden = await call(requesterA, routeKey, ticketOfB);
      const missing = await call(requesterA, routeKey, randomUUID());

      expect(hidden.status).toBe(404);
      expect(hidden.body.code).toBe("not_found");
      // Same answer as for an id that does not exist at all.
      expect(missing.status).toBe(404);
      expect(hidden.body.detail).toBe(missing.body.detail);
      expect(JSON.stringify(hidden.body)).not.toContain("agency B");
    });
  }

  it("GET /cases/:id: agency A gets 404 for agency B's case", async () => {
    const ticket = await call(requesterB, "GET /:id", ticketOfB);
    const caseId = ticket.body.case_id as string;

    const hidden = await request(app).get(`/api/v1/cases/${caseId}`).set(bearer(requesterA));
    const missing = await request(app).get(`/api/v1/cases/${randomUUID()}`).set(bearer(requesterA));
    const owner = await request(app).get(`/api/v1/cases/${caseId}`).set(bearer(requesterB));

    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual({ ...missing.body, request_id: hidden.body.request_id });
    expect(owner.status).toBe(200);
  });

  it("the owner of the ticket and staff can still reach it", async () => {
    const owner = await call(requesterB, "GET /:id", ticketOfB);
    const staff = await call(agent, "GET /:id/messages", ticketOfB);
    expect(owner.status).toBe(200);
    expect(staff.status).toBe(200);
    expect(staff.body.items.length).toBe(1);
  });

  it("agency B's ticket was not changed by the sweep", async () => {
    const res = await call(requesterB, "GET /:id", ticketOfB);
    expect(res.body).toMatchObject({ status: "new", version: 1, priority: "normal" });

    const messages = await call(requesterB, "GET /:id/messages", ticketOfB);
    expect(messages.body.items.length).toBe(1);
  });

  it("agency A's list and search never include agency B's ticket", async () => {
    const res = await request(app)
      .get("/api/v1/tickets")
      .set(bearer(requesterA))
      .query({ q: "private", limit: 100 });
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });
});
