import { randomUUID } from "node:crypto";
import pg from "pg";
import { signAccessToken } from "../../src/core/auth.js";
import { config } from "../../src/core/config.js";
import type { Role } from "../../src/domain/enums.js";
import { hashPassword } from "../../src/services/authService.js";

// Helpers for integration tests.
//
// Test data is inserted with the OWNER role, which bypasses RLS, the same way
// a seed script would. The requests under test then go through the real app,
// which uses the restricted app role.
//
// Every helper makes rows with random names, so test files never clash even
// though they share one database.

export const ownerPool = new pg.Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.owner.user,
  password: config.db.owner.password,
  max: 3,
});

// A second pool that logs in as the app role, for tests that talk to the
// database directly to prove what the app role can and cannot do.
export const appPool = new pg.Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.app.user,
  password: config.db.app.password,
  max: 3,
});

export const TEST_PASSWORD = "correct-horse-battery";

// Hashing is slow on purpose, so hash the test password once and reuse it.
let passwordHash: Promise<string> | undefined;

function shortId() {
  return randomUUID().slice(0, 8);
}

export type TestAgency = { id: string; slug: string };

export async function createAgency(): Promise<TestAgency> {
  const slug = `agency-${shortId()}`;
  const result = await ownerPool.query<{ id: string }>(
    "INSERT INTO agencies (slug, name) VALUES ($1, $2) RETURNING id",
    [slug, `Agency ${slug}`],
  );
  return { id: result.rows[0]!.id, slug };
}

export async function createTeam(regionCode = "EU"): Promise<string> {
  const result = await ownerPool.query<{ id: string }>(
    "INSERT INTO teams (name, region_code) VALUES ($1, $2) RETURNING id",
    [`team-${shortId()}`, regionCode],
  );
  return result.rows[0]!.id;
}

export type TestUser = {
  id: string;
  email: string;
  role: Role;
  agencyId: string | null;
  teamId: string | null;
  token: string; // a valid access token, so tests can skip the login call
};

export async function createUser(
  role: Role,
  options: { agencyId?: string; teamId?: string } = {},
): Promise<TestUser> {
  passwordHash ??= hashPassword(TEST_PASSWORD);
  const email = `${role}-${shortId()}@test.example`;
  const agencyId = options.agencyId ?? null;
  const teamId = options.teamId ?? null;

  const result = await ownerPool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role, agency_id, team_id, email_verified_at)
     VALUES ($1, $2, $3, $4, $5, $6, now()) RETURNING id`,
    [email, await passwordHash, `Test ${role}`, role, agencyId, teamId],
  );
  const id = result.rows[0]!.id;
  return {
    id,
    email,
    role,
    agencyId,
    teamId,
    token: signAccessToken({ id, role, agencyId, teamId }),
  };
}

export type TestBooking = { id: string; tboh: string };

// Region isolation between test files: every file that does not test routing
// uses EU, where no test ever puts an agent online. Each routing-style file
// uses a region of its own (APAC, AMER, MEA), so tickets created by one file
// are never routed to another file's agents.
export async function createBooking(agencyId: string, regionCode = "EU"): Promise<TestBooking> {
  const supplier = await ownerPool.query<{ id: string }>(
    "INSERT INTO suppliers (code, name) VALUES ($1, 'Test Supplier') RETURNING id",
    [`SUP-${shortId()}`],
  );
  const tboh = `TBOH-${shortId().toUpperCase()}`;
  const result = await ownerPool.query<{ id: string }>(
    `INSERT INTO bookings (tboh, agency_id, supplier_id, region_code, hotel_name,
                           check_in_date, hotel_time_zone, lcd_at, amount, currency)
     VALUES ($1, $2, $3, $4, 'Hotel Test', '2027-06-10', 'Europe/Berlin',
             '2027-06-01 12:00:00+00', 450.00, 'EUR')
     RETURNING id`,
    [tboh, agencyId, supplier.rows[0]!.id, regionCode],
  );
  return { id: result.rows[0]!.id, tboh };
}

// The usual cast: one agency with a requester and a booking.
export async function createAgencyWithRequester() {
  const agency = await createAgency();
  const requester = await createUser("requester", { agencyId: agency.id });
  const booking = await createBooking(agency.id);
  return { agency, requester, booking };
}

// An agent that routing can pick: in a team, with a presence row, on shift
// at every hour of every day, and optionally with skills.
export async function createRoutableAgent(
  teamId: string,
  options: { maxOpen?: number; online?: boolean; skills?: string[] } = {},
): Promise<TestUser> {
  const agent = await createUser("agent", { teamId });
  await ownerPool.query(
    "INSERT INTO agent_presence (user_id, is_online, max_open) VALUES ($1, $2, $3)",
    [agent.id, options.online ?? true, options.maxOpen ?? 5],
  );
  await ownerPool.query(
    `INSERT INTO agent_shifts (user_id, weekday, start_minute, end_minute)
     SELECT $1, day, 0, 1440 FROM generate_series(1, 7) AS day`,
    [agent.id],
  );
  for (const intent of options.skills ?? []) {
    await ownerPool.query("INSERT INTO agent_skills (user_id, intent) VALUES ($1, $2)", [
      agent.id,
      intent,
    ]);
  }
  return agent;
}

export function bearer(user: TestUser) {
  return { Authorization: `Bearer ${user.token}` };
}

export async function closeTestPools() {
  await ownerPool.end();
  await appPool.end();
}
