import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appPool,
  closeTestPools,
  createAgencyWithRequester,
  createBooking,
  createUser,
  ownerPool,
  type TestAgency,
  type TestBooking,
  type TestUser,
} from "./helpers.js";

// These tests skip the API and talk to PostgreSQL directly. They prove the
// database itself refuses bad data and hides other agencies' rows, even if
// the application code had a bug.

let agencyA: TestAgency;
let requesterA: TestUser;
let bookingA: TestBooking;
let agencyB: TestAgency;
let requesterB: TestUser;
let bookingB: TestBooking;
let agent: TestUser;
let ticketA: string;
let ticketB: string;

async function insertTicket(agencyId: string, bookingId: string, requesterId: string) {
  // Every ticket needs the open case of its booking.
  await ownerPool.query(
    `INSERT INTO cases (booking_id, agency_id)
     SELECT id, agency_id FROM bookings WHERE id = $1
     ON CONFLICT (booking_id) WHERE status = 'open' DO NOTHING`,
    [bookingId],
  );
  const result = await ownerPool.query<{ id: string }>(
    `INSERT INTO tickets (agency_id, booking_id, case_id, requester_id, subject, body,
                          intent_source, check_in_at, lcd_at, region_code)
     VALUES ($1, $2, (SELECT id FROM cases WHERE booking_id = $2 AND status = 'open'),
             $3, 'Subject', 'Body', 'manual', now(), now(), 'EU')
     RETURNING id`,
    [agencyId, bookingId, requesterId],
  );
  return result.rows[0]!.id;
}

beforeAll(async () => {
  ({
    agency: agencyA,
    requester: requesterA,
    booking: bookingA,
  } = await createAgencyWithRequester());
  ({
    agency: agencyB,
    requester: requesterB,
    booking: bookingB,
  } = await createAgencyWithRequester());
  agent = await createUser("agent");

  ticketA = await insertTicket(agencyA.id, bookingA.id, requesterA.id);
  ticketB = await insertTicket(agencyB.id, bookingB.id, requesterB.id);

  await ownerPool.query(
    `INSERT INTO messages (ticket_id, agency_id, author_id, visibility, body)
     VALUES ($1, $2, $3, 'public', 'public reply'), ($1, $2, $3, 'internal', 'internal note')`,
    [ticketA, agencyA.id, agent.id],
  );
  await ownerPool.query(
    `INSERT INTO ticket_events (ticket_id, agency_id, actor_id, type, visibility)
     VALUES ($1, $2, $3, 'ticket_created', 'public'), ($1, $2, $3, 'message_added', 'internal')`,
    [ticketA, agencyA.id, agent.id],
  );
});

afterAll(closeTestPools);

// Runs `fn` as the app role inside a transaction with the given identity,
// the same way tx() does, then rolls back so the test leaves nothing behind.
async function asApp<T>(
  identity: { role: string; userId?: string; agencyId?: string } | null,
  fn: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    if (identity) {
      await client.query(
        `SELECT set_config('app.role', $1, true), set_config('app.user_id', $2, true),
                set_config('app.agency_id', $3, true)`,
        [identity.role, identity.userId ?? "", identity.agencyId ?? ""],
      );
    }
    return await fn(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

const asRequesterA = () => ({ role: "requester", userId: requesterA.id, agencyId: agencyA.id });
const asAgent = () => ({ role: "agent", userId: agent.id });

async function countRows(db: PoolClient, sql: string, params: unknown[] = []): Promise<number> {
  const result = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params);
  return result.rows[0]!.n;
}

// Expects the query to fail with the given PostgreSQL error code.
async function expectDbError(run: () => Promise<unknown>, code: string) {
  await expect(run()).rejects.toMatchObject({ code });
}

const PERMISSION_DENIED = "42501"; // also used for "violates row-level security policy"
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

describe("Row-Level Security", () => {
  it("with no identity set, the app role sees nothing (fails closed)", async () => {
    await asApp(null, async (db) => {
      expect(await countRows(db, "tickets")).toBe(0);
      expect(await countRows(db, "bookings")).toBe(0);
      expect(await countRows(db, "messages")).toBe(0);
      expect(await countRows(db, "ticket_events")).toBe(0);
      expect(await countRows(db, "users")).toBe(0);
      expect(await countRows(db, "agencies")).toBe(0);
    });
  });

  it("a requester sees only their own agency's rows", async () => {
    await asApp(asRequesterA(), async (db) => {
      expect(await countRows(db, "tickets WHERE id = $1", [ticketA])).toBe(1);
      expect(await countRows(db, "tickets WHERE id = $1", [ticketB])).toBe(0);
      expect(await countRows(db, "bookings WHERE id = $1", [bookingB.id])).toBe(0);
      expect(await countRows(db, "agencies")).toBe(1);
      expect(await countRows(db, "users WHERE id = $1", [requesterB.id])).toBe(0);
    });
  });

  it("staff see every agency", async () => {
    await asApp(asAgent(), async (db) => {
      expect(await countRows(db, "tickets WHERE id IN ($1, $2)", [ticketA, ticketB])).toBe(2);
    });
  });

  it("internal notes and internal events are hidden from requesters by the database", async () => {
    await asApp(asRequesterA(), async (db) => {
      expect(await countRows(db, "messages WHERE ticket_id = $1", [ticketA])).toBe(1);
      expect(await countRows(db, "messages WHERE visibility = 'internal'")).toBe(0);
      expect(await countRows(db, "ticket_events WHERE ticket_id = $1", [ticketA])).toBe(1);
    });
    await asApp(asAgent(), async (db) => {
      expect(await countRows(db, "messages WHERE ticket_id = $1", [ticketA])).toBe(2);
    });
  });

  it("a requester cannot insert an internal note, even with direct SQL", async () => {
    await asApp(asRequesterA(), async (db) => {
      await expectDbError(
        () =>
          db.query(
            `INSERT INTO messages (ticket_id, agency_id, author_id, visibility, body)
             VALUES ($1, $2, $3, 'internal', 'sneaky')`,
            [ticketA, agencyA.id, requesterA.id],
          ),
        PERMISSION_DENIED,
      );
    });
  });

  it("a requester cannot write into another agency", async () => {
    await asApp(asRequesterA(), async (db) => {
      await expectDbError(
        () =>
          db.query(
            `INSERT INTO messages (ticket_id, agency_id, author_id, visibility, body)
             VALUES ($1, $2, $3, 'public', 'hello B')`,
            [ticketB, agencyB.id, requesterA.id],
          ),
        PERMISSION_DENIED,
      );
    });
    await asApp(asRequesterA(), async (db) => {
      // An UPDATE on a hidden row is not an error: it simply matches nothing.
      const result = await db.query("UPDATE tickets SET subject = 'hacked' WHERE id = $1", [
        ticketB,
      ]);
      expect(result.rowCount).toBe(0);
    });
  });

  // Hazard 14 in README section 9.
  it("identity does not stay on a pooled connection after the transaction", async () => {
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.role', 'agent', true), set_config('app.user_id', $1, true)",
        [agent.id],
      );
      const during = await client.query("SELECT count(*)::int AS n FROM tickets");
      expect(during.rows[0].n).toBeGreaterThan(0);
      await client.query("COMMIT");

      // Same connection, next "request", nobody set an identity.
      const after = await client.query("SELECT count(*)::int AS n FROM tickets");
      expect(after.rows[0].n).toBe(0);
    } finally {
      client.release();
    }
  });

  it("the app role is not a superuser and cannot bypass RLS", async () => {
    const result = await ownerPool.query(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'opsdesk_app'",
    );
    expect(result.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});

// Phase 1 gate: timeline rows cannot be changed.
describe("append-only data and no deletes", () => {
  it.each(["ticket_events", "messages"])("the app role cannot UPDATE %s", async (table) => {
    await asApp(asAgent(), async (db) => {
      await expectDbError(
        () => db.query(`UPDATE ${table} SET visibility = 'public' WHERE ticket_id = $1`, [ticketA]),
        PERMISSION_DENIED,
      );
    });
  });

  it.each([
    "ticket_events",
    "messages",
    "tickets",
    "bookings",
    "users",
    "agencies",
    "outbox",
    "idempotency_keys",
    "refresh_tokens",
    "cases",
    "ticket_links",
    "intent_overrides",
  ])("the app role cannot DELETE from %s", async (table) => {
    await asApp(asAgent(), async (db) => {
      await expectDbError(() => db.query(`DELETE FROM ${table}`), PERMISSION_DENIED);
    });
  });

  it("the app role cannot read the outbox or change users", async () => {
    await asApp(asAgent(), async (db) => {
      await expectDbError(() => db.query("SELECT * FROM outbox"), PERMISSION_DENIED);
    });
    await asApp(asAgent(), async (db) => {
      await expectDbError(() => db.query("UPDATE users SET role = 'lead'"), PERMISSION_DENIED);
    });
  });
});

describe("constraints hold even for the owner role", () => {
  const insertUser = (role: string, agencyId: string | null, email = `${randomUUID()}@x.example`) =>
    ownerPool.query(
      "INSERT INTO users (email, password_hash, full_name, role, agency_id) VALUES ($1, 'x', 'X', $2, $3)",
      [email, role, agencyId],
    );

  it("a requester must have an agency and staff must not", async () => {
    await expectDbError(() => insertUser("requester", null), CHECK_VIOLATION);
    await expectDbError(() => insertUser("agent", agencyA.id), CHECK_VIOLATION);
  });

  it("an unknown role is refused", async () => {
    await expectDbError(() => insertUser("admin", null), CHECK_VIOLATION);
  });

  it("emails are unique ignoring case", async () => {
    await expectDbError(
      () => insertUser("agent", null, agent.email.toUpperCase()),
      UNIQUE_VIOLATION,
    );
  });

  it("a ticket's agency must be its booking's agency", async () => {
    await expectDbError(
      () => insertTicket(agencyA.id, bookingB.id, requesterA.id),
      FOREIGN_KEY_VIOLATION,
    );
  });

  it("a message's agency must be its ticket's agency", async () => {
    await expectDbError(
      () =>
        ownerPool.query(
          `INSERT INTO messages (ticket_id, agency_id, author_id, visibility, body)
           VALUES ($1, $2, $3, 'public', 'wrong agency')`,
          [ticketA, agencyB.id, agent.id],
        ),
      FOREIGN_KEY_VIOLATION,
    );
  });

  it("a new ticket cannot have an assignee", async () => {
    await expectDbError(
      () =>
        ownerPool.query("UPDATE tickets SET assignee_id = $2 WHERE id = $1", [ticketA, agent.id]),
      CHECK_VIOLATION,
    );
  });

  it("resolved_at must match the status", async () => {
    await expectDbError(
      () => ownerPool.query("UPDATE tickets SET status = 'resolved' WHERE id = $1", [ticketA]),
      CHECK_VIOLATION,
    );
    await expectDbError(
      () => ownerPool.query("UPDATE tickets SET resolved_at = now() WHERE id = $1", [ticketA]),
      CHECK_VIOLATION,
    );
  });

  it("an unknown status or priority is refused", async () => {
    await expectDbError(
      () => ownerPool.query("UPDATE tickets SET status = 'deleted' WHERE id = $1", [ticketA]),
      CHECK_VIOLATION,
    );
    await expectDbError(
      () => ownerPool.query("UPDATE tickets SET priority = 'mega' WHERE id = $1", [ticketA]),
      CHECK_VIOLATION,
    );
  });

  it("free cancellation cannot end after the check-in day", async () => {
    await expectDbError(
      () =>
        ownerPool.query("UPDATE bookings SET lcd_at = '2027-06-12 00:00:00+00' WHERE id = $1", [
          bookingA.id,
        ]),
      CHECK_VIOLATION,
    );
  });

  it("a TBOH is unique", async () => {
    const another = await createBooking(agencyA.id);
    await expectDbError(
      () =>
        ownerPool.query("UPDATE bookings SET tboh = $2 WHERE id = $1", [another.id, bookingA.tboh]),
      UNIQUE_VIOLATION,
    );
  });

  it("a ticket that has events cannot be deleted", async () => {
    await expectDbError(
      () => ownerPool.query("DELETE FROM tickets WHERE id = $1", [ticketA]),
      FOREIGN_KEY_VIOLATION,
    );
  });

  // Hazard 15 in README section 9.
  it("an event dated outside the created months lands in the default partition", async () => {
    const result = await ownerPool.query<{ partition: string }>(
      `INSERT INTO ticket_events (ticket_id, agency_id, type, created_at)
       VALUES ($1, $2, 'ticket_updated', '2031-01-01 00:00:01+00')
       RETURNING tableoid::regclass::text AS partition`,
      [ticketB, agencyB.id],
    );
    expect(result.rows[0]!.partition).toBe("ticket_events_default");
  });

  it("an event dated now lands in this month's partition", async () => {
    const result = await ownerPool.query<{ partition: string; expected: string }>(
      `INSERT INTO ticket_events (ticket_id, agency_id, type)
       VALUES ($1, $2, 'ticket_updated')
       RETURNING tableoid::regclass::text AS partition,
                 'ticket_events_' || to_char(now() AT TIME ZONE 'UTC', 'YYYY_MM') AS expected`,
      [ticketB, agencyB.id],
    );
    expect(result.rows[0]!.partition).toBe(result.rows[0]!.expected);
  });
});
