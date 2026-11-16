import argon2 from "argon2";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../scripts/migrate.js";
import { seed, SEED_PASSWORD } from "../../scripts/seed.js";
import { config } from "../../src/core/config.js";
import { closeTestPools, ownerPool } from "./helpers.js";

// The seed fills every region with demo agents and tickets. In the shared
// test database that would disturb other test files (a routing test could
// pick a demo agent). So this file makes a second, empty database in the
// same PostgreSQL container, migrates it, and seeds that one.
const SEED_DB = "opsdesk_seed_test";

let seedPool: pg.Pool;

beforeAll(async () => {
  await ownerPool.query(`CREATE DATABASE ${SEED_DB}`);
  await migrate(() => {}, SEED_DB);
  seedPool = new pg.Pool({
    host: config.db.host,
    port: config.db.port,
    database: SEED_DB,
    user: config.db.owner.user,
    password: config.db.owner.password,
    max: 2,
  });
});

afterAll(async () => {
  await seedPool.end();
  await closeTestPools();
});

// A fingerprint of everything the seed wrote: row counts plus a checksum of
// the ticket ids, statuses, cases and timestamps.
async function fingerprint() {
  const result = await seedPool.query(`
    SELECT
      (SELECT count(*)::int FROM agencies) AS agencies,
      (SELECT count(*)::int FROM users WHERE role <> 'requester') AS staff,
      (SELECT count(*)::int FROM users WHERE role = 'requester') AS requesters,
      (SELECT count(*)::int FROM bookings) AS bookings,
      (SELECT count(*)::int FROM tickets) AS tickets,
      (SELECT count(*)::int FROM cases) AS cases,
      (SELECT count(*)::int FROM messages) AS messages,
      (SELECT count(*)::int FROM ticket_events) AS events,
      (SELECT count(*)::int FROM agent_presence) AS presence,
      (SELECT count(*)::int FROM agent_shifts) AS shifts,
      (SELECT count(*)::int FROM agent_skills) AS skills,
      (SELECT md5(string_agg(
                id::text || status || case_id::text || created_at::text || sla_due_at::text,
                ',' ORDER BY id))
         FROM tickets) AS ticket_checksum
  `);
  return result.rows[0];
}

describe("seed", () => {
  it("creates the expected data, and running it again changes nothing", async () => {
    await seed(() => {}, SEED_DB);
    const first = await fingerprint();

    expect(first).toMatchObject({
      agencies: 5,
      staff: 20,
      requesters: 10,
      bookings: 40,
      tickets: 80,
      presence: 12, // one per agent
      shifts: 60, // 12 agents x 5 weekdays
    });
    expect(first.messages).toBeGreaterThan(0);
    expect(first.events).toBeGreaterThanOrEqual(80);
    expect(first.cases).toBeGreaterThan(0);

    await seed(() => {}, SEED_DB);
    const second = await fingerprint();
    expect(second).toEqual(first);
  });

  it("seeded users have the demo password", async () => {
    const result = await seedPool.query<{ password_hash: string; role: string }>(
      "SELECT password_hash, role FROM users WHERE email = 'agent1.eu@opsdesk.test'",
    );
    expect(result.rows[0]!.role).toBe("agent");
    expect(await argon2.verify(result.rows[0]!.password_hash, SEED_PASSWORD)).toBe(true);
  });

  it("every seeded agent's load counter equals a count of their live tickets", async () => {
    const drift = await seedPool.query(`
      SELECT p.user_id
        FROM agent_presence p
        LEFT JOIN tickets t
          ON t.assignee_id = p.user_id AND t.status IN ('open', 'pending', 'escalated')
       GROUP BY p.user_id, p.open_count
      HAVING p.open_count <> count(t.id)`);
    expect(drift.rows).toEqual([]);
  });

  it("a case is closed exactly when all its tickets are closed", async () => {
    const wrong = await seedPool.query(`
      SELECT c.id
        FROM cases c
       WHERE (c.status = 'closed') <>
             NOT EXISTS (SELECT 1 FROM tickets t WHERE t.case_id = c.id AND t.status <> 'closed')`);
    expect(wrong.rows).toEqual([]);
  });

  it("agents start offline, so demo tickets are not routed until someone logs in", async () => {
    const online = await seedPool.query("SELECT 1 FROM agent_presence WHERE is_online");
    expect(online.rowCount).toBe(0);
  });
});
