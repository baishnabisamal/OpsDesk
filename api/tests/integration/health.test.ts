import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";

const app = createApp();

describe("health checks", () => {
  it("GET /healthz says the process is alive", async () => {
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("GET /readyz reports PostgreSQL and Redis", async () => {
    await request(app).get("/readyz"); // the first call opens the Redis connection
    await new Promise((resolve) => setTimeout(resolve, 300));
    const res = await request(app).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ready", checks: { postgres: "ok", redis: "ok" } });
  });

  it("every response carries a request id", async () => {
    const res = await request(app).get("/healthz");
    expect(res.headers["x-request-id"]).toMatch(/^req_[0-9a-f]{8}$/);
  });
});

describe("error format", () => {
  it("an unknown route returns problem+json with a stable code", async () => {
    const res = await request(app).get("/no-such-route");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(res.body).toMatchObject({
      type: "https://opsdesk.dev/problems/not-found",
      title: "Not found",
      status: 404,
      code: "not_found",
    });
    expect(res.body.request_id).toBe(res.headers["x-request-id"]);
  });

  it("a broken JSON body returns 400, not 500", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .set("Content-Type", "application/json")
      .send("{not json");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("bad_request");
  });
});
