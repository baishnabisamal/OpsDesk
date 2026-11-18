import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { config } from "../../src/core/config.js";
import {
  autoCloseResolved,
  ensurePartitions,
  purgeIdempotencyKeys,
  reconcileLoad,
} from "../../src/services/maintenanceService.js";
import { JOBS } from "../../src/workers/jobs.js";
import { startRunner } from "../../src/workers/runner.js";
import {
  appPool,
  bearer,
  closeTestPools,
  createAgencyWithRequester,
  createRoutableAgent,
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

beforeAll(async () => {
  ({ requester, booking } = await createAgencyWithRequester());
  agent = await createUser("agent");
});

afterAll(closeTestPools);

// Waits until `check` returns true, looking every 50 ms.
async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("waitFor: the condition did not become true in time");
}

async function deadLetters(queueName: string) {
  const result = await ownerPool.query<{ job_name: string; error: string; attempts: number }>(
    "SELECT job_name, error, attempts FROM dead_letter_jobs WHERE queue = $1",
    [queueName],
  );
  return result.rows;
}

describe("the job runner (BullMQ on a real Redis)", () => {
  it("runs a scheduled job again and again", async () => {
    let runs = 0;
    const runner = await startRunner({
      queueName: `test-${randomUUID()}`,
      redis: config.redis,
      jobs: {
        tick: {
          everyMs: 100,
          run: async () => {
            runs += 1;
            return { runs };
          },
        },
      },
    });
    try {
      await waitFor(() => runs >= 3);
    } finally {
      await runner.close();
    }
  });

  it("retries a failing job, then stores it as a dead letter", async () => {
    const queueName = `test-${randomUUID()}`;
    let attempts = 0;
    const runner = await startRunner({
      queueName,
      redis: config.redis,
      attempts: 3,
      backoffMs: 20,
      jobs: {
        broken: {
          everyMs: 60_000, // once is enough for this test
          run: async () => {
            attempts += 1;
            throw new Error("the supplier API is down");
          },
        },
      },
    });
    try {
      await waitFor(async () => (await deadLetters(queueName)).length > 0);
    } finally {
      await runner.close();
    }

    expect(attempts).toBe(3); // tried three times, not once and not forever
    expect(await deadLetters(queueName)).toEqual([
      { job_name: "broken", error: "the supplier API is down", attempts: 3 },
    ]);
  });

  it("a job that fails once and then works leaves no dead letter", async () => {
    const queueName = `test-${randomUUID()}`;
    let attempts = 0;
    let succeeded = false;
    const runner = await startRunner({
      queueName,
      redis: config.redis,
      attempts: 3,
      backoffMs: 20,
      jobs: {
        flaky: {
          everyMs: 60_000,
          run: async () => {
            attempts += 1;
            if (attempts === 1) throw new Error("first try fails");
            succeeded = true;
            return {};
          },
        },
      },
    });
    try {
      await waitFor(() => succeeded);
    } finally {
      await runner.close();
    }

    expect(attempts).toBe(2);
    expect(await deadLetters(queueName)).toEqual([]);
  });

  it("starting the runner twice does not schedule a job twice", async () => {
    const queueName = `test-${randomUUID()}`;
    const jobs = { tick: { everyMs: 60_000, run: async () => ({}) } };

    const first = await startRunner({ queueName, redis: config.redis, jobs });
    const second = await startRunner({ queueName, redis: config.redis, jobs });
    try {
      const schedulers = await first.queue.getJobSchedulers();
      expect(schedulers.length).toBe(1);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("every real job has an interval and a function", () => {
    expect(Object.keys(JOBS).sort()).toEqual([
      "archival",
      "auto-close",
      "idempotency-cleanup",
      "load-reconciliation",
      "partition-maintenance",
      "routing-retry",
      "sla-scan",
      "theme-rollup",
    ]);
    for (const job of Object.values(JOBS)) {
      expect(job.everyMs).toBeGreaterThan(0);
      expect(job.run).toBeTypeOf("function");
    }
  });
});

describe("auto-close", () => {
  // Creates a ticket and takes it to resolved.
  async function resolvedTicket() {
    const created = await request(app)
      .post("/api/v1/tickets")
      .set(bearer(requester))
      .set("Idempotency-Key", randomUUID())
      .send({ tboh: booking.tboh, subject: "Refund not received", body: "Please check." });
    const assigned = await request(app)
      .post(`/api/v1/tickets/${created.body.id}/assign`)
      .set(bearer(agent))
      .set("If-Match", '"1"')
      .send({ assignee_id: agent.id });
    const resolved = await request(app)
      .post(`/api/v1/tickets/${created.body.id}/transitions`)
      .set(bearer(agent))
      .set("If-Match", `"${assigned.body.version}"`)
      .send({ to: "resolved" });
    expect(resolved.body.status).toBe("resolved");
    return resolved.body as { id: string; case_id: string };
  }

  async function status(id: string) {
    const result = await ownerPool.query<{ status: string }>(
      "SELECT status FROM tickets WHERE id = $1",
      [id],
    );
    return result.rows[0]!.status;
  }

  it("closes a ticket that has been resolved and quiet for long enough", async () => {
    const old = await resolvedTicket();
    const recent = await resolvedTicket();
    // Pretend the first one was resolved four days ago (the limit is 72 hours).
    await ownerPool.query(
      "UPDATE tickets SET resolved_at = now() - interval '4 days' WHERE id = $1",
      [old.id],
    );

    const result = await autoCloseResolved();
    expect(result.closed).toBeGreaterThanOrEqual(1);
    expect(await status(old.id)).toBe("closed");
    expect(await status(recent.id)).toBe("resolved");

    // The timeline shows the system did it (actor is null).
    const events = await ownerPool.query<{ actor_id: string | null; data: object }>(
      `SELECT actor_id, data FROM ticket_events
        WHERE ticket_id = $1 AND type = 'status_changed' AND data->>'to' = 'closed'`,
      [old.id],
    );
    expect(events.rows).toEqual([{ actor_id: null, data: { from: "resolved", to: "closed" } }]);
  });

  it("running it again changes nothing (idempotent)", async () => {
    const old = await resolvedTicket();
    await ownerPool.query(
      "UPDATE tickets SET resolved_at = now() - interval '4 days' WHERE id = $1",
      [old.id],
    );

    await autoCloseResolved();
    await autoCloseResolved();

    const events = await ownerPool.query(
      `SELECT 1 FROM ticket_events
        WHERE ticket_id = $1 AND type = 'status_changed' AND data->>'to' = 'closed'`,
      [old.id],
    );
    expect(events.rowCount).toBe(1);
  });
});

describe("partition maintenance", () => {
  it("finds the next three months already there, and creates further ones on request", async () => {
    // Migration 001 made this month and the next three.
    expect(await ensurePartitions(3)).toEqual({ created: 0 });

    // Two more months, for two tables = four new partitions.
    expect(await ensurePartitions(5)).toEqual({ created: 4 });
    // Asking again creates nothing: the job is idempotent.
    expect(await ensurePartitions(5)).toEqual({ created: 0 });
  });

  it("the app role cannot create tables itself, only call the function", async () => {
    await expect(appPool.query("CREATE TABLE sneaky (id int)")).rejects.toMatchObject({
      code: "42501", // permission denied
    });
  });

  it("the function refuses a silly argument", async () => {
    await expect(ensurePartitions(500)).rejects.toThrow(/between 0 and 24/);
  });
});

describe("idempotency key cleanup", () => {
  it("removes keys older than 24 hours and keeps newer ones", async () => {
    const oldKey = `old-${randomUUID()}`;
    const newKey = `new-${randomUUID()}`;
    await ownerPool.query(
      `INSERT INTO idempotency_keys (user_id, key, request_hash, created_at)
       VALUES ($1, $2, 'x', now() - interval '25 hours'), ($1, $3, 'x', now() - interval '23 hours')`,
      [requester.id, oldKey, newKey],
    );

    const result = await purgeIdempotencyKeys();
    expect(result.removed).toBeGreaterThanOrEqual(1);

    const left = await ownerPool.query<{ key: string }>(
      "SELECT key FROM idempotency_keys WHERE key IN ($1, $2)",
      [oldKey, newKey],
    );
    expect(left.rows).toEqual([{ key: newKey }]);
  });

  it("the app role still cannot DELETE directly", async () => {
    await expect(appPool.query("DELETE FROM idempotency_keys")).rejects.toMatchObject({
      code: "42501",
    });
  });
});

describe("load reconciliation", () => {
  it("reports an agent whose stored counter is wrong", async () => {
    const teamId = await createTeam("EU");
    const tampered = await createRoutableAgent(teamId, { online: false });
    // Break the counter on purpose: the agent has no tickets at all.
    await ownerPool.query("UPDATE agent_presence SET open_count = 2 WHERE user_id = $1", [
      tampered.id,
    ]);

    const { drift } = await reconcileLoad();
    expect(drift).toContainEqual({ user_id: tampered.id, stored: 2, actual: 0 });

    // It reports, it does not repair.
    const row = await ownerPool.query<{ open_count: number }>(
      "SELECT open_count FROM agent_presence WHERE user_id = $1",
      [tampered.id],
    );
    expect(row.rows[0]!.open_count).toBe(2);

    await ownerPool.query("UPDATE agent_presence SET open_count = 0 WHERE user_id = $1", [
      tampered.id,
    ]);
  });
});
