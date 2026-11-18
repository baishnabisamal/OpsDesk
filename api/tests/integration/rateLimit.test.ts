import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { errorHandler } from "../../src/core/errors.js";
import { createLimiterRedis, createRateLimiter, type RateRule } from "../../src/core/rateLimit.js";
import { closeTestPools } from "./helpers.js";

// The app under test runs with huge limits (see globalSetup), so these tests
// build small apps of their own around the same limiter, with tiny buckets.

const redis = createLimiterRedis();
const deadRedis = createLimiterRedis("127.0.0.1", 9); // nothing listens on port 9

// The limiter's client refuses commands until it is connected (and the
// limiter then lets requests through). Wait for it, so tests measure the
// limiter and not the connection.
beforeAll(async () => {
  if (redis.status !== "ready") await new Promise((resolve) => redis.once("ready", resolve));
});

afterAll(async () => {
  redis.disconnect();
  deadRedis.disconnect();
  await closeTestPools();
});

function smallApp(rules: RateRule[], client = redis) {
  const app = express();
  app.use(createRateLimiter(client, rules));
  app.get("/ping", (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

// A rule with its own bucket per test, so tests never share tokens.
function rule(capacity: number, perSecond: number): RateRule {
  const bucket = randomUUID();
  return { name: "test", capacity, perSecond, key: () => bucket };
}

describe("token bucket rate limiting", () => {
  it("allows a burst up to the capacity, then answers 429 with Retry-After", async () => {
    const app = smallApp([rule(3, 0.5)]);

    for (let i = 0; i < 3; i++) {
      const ok = await request(app).get("/ping");
      expect(ok.status).toBe(200);
      expect(ok.headers["ratelimit-remaining"]).toBe(String(2 - i));
    }

    const limited = await request(app).get("/ping");
    expect(limited.status).toBe(429);
    expect(limited.headers["content-type"]).toContain("application/problem+json");
    expect(limited.body.code).toBe("rate_limited");
    // One token every 2 s at 0.5 per second.
    expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(Number(limited.headers["retry-after"])).toBeLessThanOrEqual(2);
  });

  it("refills over time", async () => {
    const app = smallApp([rule(1, 20)]); // a token every 50 ms
    expect((await request(app).get("/ping")).status).toBe(200);
    expect((await request(app).get("/ping")).status).toBe(429);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect((await request(app).get("/ping")).status).toBe(200);
  });

  it("50 requests at the same moment: exactly the capacity get through", async () => {
    const app = smallApp([rule(5, 0.01)]);
    const results = await Promise.all(Array.from({ length: 50 }, () => request(app).get("/ping")));
    const statuses = results.map((res) => res.status);
    expect(statuses.filter((status) => status === 200).length).toBe(5);
    expect(statuses.filter((status) => status === 429).length).toBe(45);
  });

  it("separate buckets do not share tokens", async () => {
    const tight = rule(1, 0.01);
    const app = smallApp([{ ...tight, key: (req) => String(req.query.who) }]);
    expect(
      (
        await request(app)
          .get("/ping")
          .query({ who: `a-${randomUUID()}` })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .get("/ping")
          .query({ who: `b-${randomUUID()}` })
      ).status,
    ).toBe(200);
  });

  it("a rule whose key is null does not apply", async () => {
    const app = smallApp([{ name: "never", capacity: 1, perSecond: 0.01, key: () => null }]);
    for (let i = 0; i < 3; i++) expect((await request(app).get("/ping")).status).toBe(200);
  });

  it("fails open: with Redis unreachable, requests are allowed", async () => {
    const app = smallApp([rule(1, 0.01)], deadRedis);
    const startedAt = Date.now();
    for (let i = 0; i < 3; i++) expect((await request(app).get("/ping")).status).toBe(200);
    // And quickly: the limiter does not wait around for Redis.
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });
});

describe("the real app", () => {
  it("is limited on every /api/v1 route and sends the limit headers", async () => {
    const app = createApp();
    // The app's own limiter connection starts with the first request; give
    // it a moment to connect, then check.
    await request(app).get("/api/v1/tickets");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "nobody@test.example", password: "x" });
    expect(res.status).toBe(401);
    expect(res.headers["ratelimit-limit"]).toBeDefined();
  });

  it("does not limit the health checks", async () => {
    const res = await request(createApp()).get("/healthz");
    expect(res.headers["ratelimit-limit"]).toBeUndefined();
  });
});
