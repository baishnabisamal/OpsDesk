import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { mlBreaker } from "../../src/core/mlClient.js";
import { FakeMl } from "./fakeMl.js";
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
const fakeMl = new FakeMl();

let requester: TestUser;
let booking: TestBooking;
let agent: TestUser;

beforeAll(async () => {
  ({ requester, booking } = await createAgencyWithRequester());
  agent = await createUser("agent");
  await fakeMl.start();
});

beforeEach(() => {
  fakeMl.reset();
  mlBreaker.reset();
});

afterAll(async () => {
  await fakeMl.stop();
  await closeTestPools();
});

// Text that no keyword rule matches, so the model is asked.
const UNCLEAR = { subject: "Help needed", body: "Something looks off on the statement." };

function create(body: object) {
  return request(app)
    .post("/api/v1/tickets")
    .set(bearer(requester))
    .set("Idempotency-Key", randomUUID())
    .send({ tboh: booking.tboh, ...body });
}

function answerClassify(intent: string, confidence: number) {
  fakeMl.handler = (path) =>
    path === "/classify" ? { intent, confidence, model_version: "fake-model-1" } : { scores: [] };
}

describe("intent on create", () => {
  it("a keyword rule decides and the model is not called", async () => {
    answerClassify("payment", 0.99);
    const res = await create({ subject: "Refund not received", body: "It has been 10 days." });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      intent: "refund",
      intent_source: "rule",
      intent_confidence: null,
      model_version: null,
      needs_review: false,
    });
    expect(fakeMl.callsTo("/classify").length).toBe(0);
  });

  it("when no rule matches, the model decides", async () => {
    answerClassify("payment", 0.91);
    const res = await create(UNCLEAR);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      intent: "payment",
      intent_source: "model",
      model_version: "fake-model-1",
      needs_review: false,
    });
    expect(res.body.intent_confidence).toBeCloseTo(0.91, 2);
  });

  it("sends the subject and body, and the shared secret", async () => {
    answerClassify("payment", 0.91);
    await create(UNCLEAR);

    // The fake answers 401 without the secret, so one recorded call proves it was sent.
    const calls = fakeMl.callsTo("/classify");
    expect(calls.length).toBe(1);
    expect(calls[0]!.body).toEqual({ text: `${UNCLEAR.subject}\n${UNCLEAR.body}` });
  });

  it("an unsure model's answer is kept but flagged for review", async () => {
    answerClassify("voucher", 0.41);
    const res = await create(UNCLEAR);

    expect(res.body).toMatchObject({
      intent: "voucher",
      intent_source: "model",
      needs_review: true,
    });
  });

  it("the timeline records where the intent came from", async () => {
    answerClassify("payment", 0.91);
    const res = await create(UNCLEAR);

    const events = await ownerPool.query<{ data: object }>(
      "SELECT data FROM ticket_events WHERE ticket_id = $1 AND type = 'ticket_created'",
      [res.body.id],
    );
    expect(events.rows[0]!.data).toMatchObject({ intent: "payment", intent_source: "model" });
  });

  it("the client cannot choose the intent", async () => {
    const res = await create({ ...UNCLEAR, intent: "refund" });
    expect(res.status).toBe(400);
  });
});

// Phase 2 gate: create still works with the ML service stopped.
describe("when the ML service fails", () => {
  const FALLBACK = {
    intent: "other",
    intent_source: "fallback",
    intent_confidence: null,
    model_version: null,
    needs_review: true,
  };

  it("stopped: the ticket is created as 'other', flagged, and fast", async () => {
    await fakeMl.stop();
    try {
      const startedAt = Date.now();
      const res = await create(UNCLEAR);
      const elapsed = Date.now() - startedAt;

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject(FALLBACK);
      expect(elapsed).toBeLessThan(300); // the create latency budget
    } finally {
      await fakeMl.start();
    }
  });

  it("slow: the call is abandoned at the timeout and the ticket is still created", async () => {
    answerClassify("payment", 0.99);
    fakeMl.delayMs = 2000;

    const startedAt = Date.now();
    const res = await create(UNCLEAR);
    const elapsed = Date.now() - startedAt;

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject(FALLBACK);
    // The timeout is 150 ms. Without it this would take over 2000 ms.
    expect(elapsed).toBeLessThan(600);
  });

  it("an error status falls back", async () => {
    fakeMl.status = 503;
    const res = await create(UNCLEAR);
    expect(res.body).toMatchObject(FALLBACK);
  });

  it("an answer in the wrong shape falls back", async () => {
    fakeMl.handler = () => ({ intent: "world_domination", confidence: 7 });
    const res = await create(UNCLEAR);
    expect(res.body).toMatchObject(FALLBACK);
  });

  it("rules still work while the ML service is down", async () => {
    fakeMl.status = 503;
    const res = await create({ subject: "Voucher shows wrong dates", body: "Please fix." });
    expect(res.body).toMatchObject({
      intent: "voucher",
      intent_source: "rule",
      needs_review: false,
    });
  });

  it("after 5 failures the circuit breaker stops calling the service", async () => {
    fakeMl.status = 503;

    for (let i = 0; i < 8; i++) {
      const res = await create(UNCLEAR);
      expect(res.status).toBe(201);
    }

    // 8 tickets were created, but only the first 5 reached the service.
    expect(fakeMl.callsTo("/classify").length).toBe(5);
    expect(mlBreaker.state).toBe("open");
  });

  it("with the breaker open, create does not wait for the timeout", async () => {
    fakeMl.delayMs = 2000;
    for (let i = 0; i < 5; i++) mlBreaker.recordFailure();

    const res = await create(UNCLEAR);

    expect(res.status).toBe(201);
    // The proof is that NO request reached the ML service: with the breaker
    // open the client fails at once, so there was nothing to wait for. (An
    // earlier version also checked the elapsed time against 140 ms, which
    // failed under full-suite load for reasons that had nothing to do with ML.)
    expect(fakeMl.calls.length).toBe(0);
  });
});

describe("the review queue", () => {
  it("lists tickets flagged for review", async () => {
    answerClassify("voucher", 0.3);
    const flagged = await create(UNCLEAR);
    const clear = await create({ subject: "Refund not received", body: "Please check." });

    const res = await request(app)
      .get("/api/v1/tickets")
      .set(bearer(requester))
      .query({ needs_review: "true", limit: 100 });

    const ids = res.body.items.map((ticket: { id: string }) => ticket.id);
    expect(ids).toContain(flagged.body.id);
    expect(ids).not.toContain(clear.body.id);
  });

  it("filters by intent", async () => {
    const res = await request(app)
      .get("/api/v1/tickets")
      .set(bearer(requester))
      .query({ intent: "refund", limit: 100 });
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items.every((ticket: { intent: string }) => ticket.intent === "refund")).toBe(
      true,
    );
  });
});

describe("PUT /tickets/:id/intent", () => {
  function override(user: TestUser, id: string, version: number, intent: string) {
    return request(app)
      .put(`/api/v1/tickets/${id}/intent`)
      .set(bearer(user))
      .set("If-Match", `"${version}"`)
      .send({ intent });
  }

  it("an agent corrects a model prediction, and the correction is logged", async () => {
    answerClassify("voucher", 0.41);
    const ticket = await create(UNCLEAR);

    const res = await override(agent, ticket.body.id, 1, "payment");
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBe('"2"');
    expect(res.body).toMatchObject({
      intent: "payment",
      intent_source: "manual",
      intent_confidence: null,
      model_version: null,
      needs_review: false,
      version: 2,
    });

    // The log keeps what was replaced, including which model was wrong.
    const log = await ownerPool.query(
      `SELECT from_intent, to_intent, from_source, model_version, overridden_by
         FROM intent_overrides WHERE ticket_id = $1`,
      [ticket.body.id],
    );
    expect(log.rows).toEqual([
      {
        from_intent: "voucher",
        to_intent: "payment",
        from_source: "model",
        model_version: "fake-model-1",
        overridden_by: agent.id,
      },
    ]);
  });

  it("writes a timeline event and an outbox row", async () => {
    const ticket = await create({ subject: "Refund not received", body: "Please check." });
    await override(agent, ticket.body.id, 1, "payment");

    const events = await ownerPool.query<{ data: object }>(
      "SELECT data FROM ticket_events WHERE ticket_id = $1 AND type = 'intent_overridden'",
      [ticket.body.id],
    );
    expect(events.rows).toEqual([{ data: { from: "refund", to: "payment", from_source: "rule" } }]);

    const outbox = await ownerPool.query(
      "SELECT 1 FROM outbox WHERE ticket_id = $1 AND event_type = 'ticket.intent_overridden'",
      [ticket.body.id],
    );
    expect(outbox.rowCount).toBe(1);
  });

  it("confirming the same intent clears the review flag and is logged too", async () => {
    answerClassify("voucher", 0.41);
    const ticket = await create(UNCLEAR);

    const res = await override(agent, ticket.body.id, 1, "voucher");
    expect(res.body).toMatchObject({
      intent: "voucher",
      intent_source: "manual",
      needs_review: false,
    });

    const log = await ownerPool.query("SELECT 1 FROM intent_overrides WHERE ticket_id = $1", [
      ticket.body.id,
    ]);
    expect(log.rowCount).toBe(1);
  });

  it("a requester cannot override", async () => {
    const ticket = await create({ subject: "Refund not received", body: "Please check." });
    const res = await override(requester, ticket.body.id, 1, "payment");
    expect(res.status).toBe(403);
  });

  it("needs If-Match, rejects a stale version and an unknown intent", async () => {
    const ticket = await create({ subject: "Refund not received", body: "Please check." });
    const id = ticket.body.id;

    const missing = await request(app)
      .put(`/api/v1/tickets/${id}/intent`)
      .set(bearer(agent))
      .send({ intent: "payment" });
    expect(missing.status).toBe(428);

    expect((await override(agent, id, 7, "payment")).status).toBe(409);
    expect((await override(agent, id, 1, "nonsense")).status).toBe(400);
  });

  it("two agents overriding at once: one wins, one override is logged", async () => {
    const ticket = await create({ subject: "Refund not received", body: "Please check." });
    const agent2 = await createUser("agent");

    const results = await Promise.all([
      override(agent, ticket.body.id, 1, "payment"),
      override(agent2, ticket.body.id, 1, "voucher"),
    ]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);

    const log = await ownerPool.query("SELECT 1 FROM intent_overrides WHERE ticket_id = $1", [
      ticket.body.id,
    ]);
    expect(log.rowCount).toBe(1);
  });
});

describe("TBOH from the text", () => {
  function createWithoutTboh(body: object) {
    return request(app)
      .post("/api/v1/tickets")
      .set(bearer(requester))
      .set("Idempotency-Key", randomUUID())
      .send(body);
  }

  it("finds the booking reference in the body when tboh is left out", async () => {
    const res = await createWithoutTboh({
      subject: "Refund not received",
      body: `Our reference is ${booking.tboh.toLowerCase()}, please check.`,
    });
    expect(res.status).toBe(201);
    expect(res.body.booking_id).toBe(booking.id);
  });

  it("returns 422 when there is no reference anywhere", async () => {
    const res = await createWithoutTboh({ subject: "Refund not received", body: "Please check." });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("tboh_required");
  });
});
