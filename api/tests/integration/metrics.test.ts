import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { bearer, closeTestPools, createAgencyWithRequester, type TestUser } from "./helpers.js";

const app = createApp();
let requester: TestUser;
let ticketId: string;

beforeAll(async () => {
  const setup = await createAgencyWithRequester();
  requester = setup.requester;
  const created = await request(app)
    .post("/api/v1/tickets")
    .set(bearer(requester))
    .set("Idempotency-Key", randomUUID())
    .send({ tboh: setup.booking.tboh, subject: "Refund not received", body: "Please check." });
  ticketId = created.body.id;
});

afterAll(closeTestPools);

async function metrics(): Promise<string> {
  const res = await request(app).get("/metrics");
  expect(res.status).toBe(200);
  expect(res.headers["content-type"]).toContain("text/plain");
  return res.text;
}

describe("GET /metrics", () => {
  it("counts requests by route PATTERN, not by URL", async () => {
    await request(app).get(`/api/v1/tickets/${ticketId}`).set(bearer(requester));
    const text = await metrics();

    expect(text).toMatch(
      /http_requests_total\{method="GET",route="\/api\/v1\/tickets\/:id",status="200"\} \d+/,
    );
    // The ticket id itself never appears as a label.
    expect(text).not.toContain(ticketId);
  });

  it("puts unknown paths under one label, so random URLs cannot add series", async () => {
    await request(app).get(`/no/such/${randomUUID()}`);
    const text = await metrics();
    expect(text).toMatch(/http_requests_total\{method="GET",route="unmatched",status="404"\}/);
  });

  it("records durations as a histogram, so p95 can be computed", async () => {
    const text = await metrics();
    expect(text).toContain("http_request_duration_seconds_bucket");
    expect(text).toMatch(
      /http_request_duration_seconds_bucket\{le="0\.3",method="POST",route="\/api\/v1\/tickets\/"\}/,
    );
  });

  it("reports the outbox, queues, load drift and the database pool", async () => {
    const text = await metrics();
    for (const name of [
      "outbox_unpublished_events",
      "outbox_lag_seconds",
      "tickets_in_triage",
      "tickets_sla_breached",
      "agent_load_drift",
      'db_pool_connections{state="total"}',
    ]) {
      expect(text).toContain(name);
    }
  });

  it("includes the standard process metrics", async () => {
    const text = await metrics();
    expect(text).toContain("process_cpu_seconds_total");
    expect(text).toContain("nodejs_eventloop_lag_seconds");
  });
});
