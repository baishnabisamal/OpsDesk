import type { PoolClient } from "pg";
import { requirePermission } from "../core/auth.js";
import { conflict, notFound } from "../core/errors.js";
import { tx } from "../db/tx.js";
import type { Principal } from "../domain/enums.js";
import { TICKET_COLUMNS, type Ticket } from "./shared.js";

// A case groups every ticket about one booking, so three contacts about the
// same booking are seen together instead of by three different agents.

// ---------------------------------------------------------------------------
// Find or create the open case of a booking (hazard 6)
// ---------------------------------------------------------------------------

// Two tickets can arrive at the same moment for a booking that has no case
// yet. "Look for a case, and create one if there is none" has a gap: both
// requests look, both find nothing, both create. So the database decides:
//
//   1. INSERT ... ON CONFLICT DO NOTHING. The partial unique index allows one
//      open case per booking. If another transaction is inserting the same
//      case right now, this statement WAITS for it, then inserts nothing.
//   2. Read the open case back, and lock it (FOR UPDATE) until this
//      transaction ends. The lock stops the case being closed while a new
//      ticket is being added to it.
//
// Between 1 and 2 the case could be closed by someone closing its last
// ticket. Then step 2 finds nothing and we simply try again.
export async function findOrCreateOpenCase(
  db: PoolClient,
  booking: { id: string; agency_id: string },
): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await db.query(
      `INSERT INTO cases (booking_id, agency_id) VALUES ($1, $2)
       ON CONFLICT (booking_id) WHERE status = 'open' DO NOTHING`,
      [booking.id, booking.agency_id],
    );
    const found = await db.query<{ id: string }>(
      "SELECT id FROM cases WHERE booking_id = $1 AND status = 'open' FOR UPDATE",
      [booking.id],
    );
    if (found.rows[0]) return found.rows[0].id;
  }
  throw conflict("case_busy", "The case for this booking is changing. Please try again.");
}

// Called when a ticket is closed: if that was the last ticket still not
// closed, the case closes too. A later ticket on the booking starts a new case.
export async function closeCaseIfFinished(db: PoolClient, caseId: string) {
  // Lock first. If a create is adding a ticket to this case right now, we
  // wait here until it commits, and the next statement then sees its ticket.
  await db.query("SELECT id FROM cases WHERE id = $1 FOR UPDATE", [caseId]);
  await db.query(
    `UPDATE cases
        SET status = 'closed', closed_at = now()
      WHERE id = $1
        AND status = 'open'
        AND NOT EXISTS (SELECT 1 FROM tickets WHERE case_id = $1 AND status <> 'closed')`,
    [caseId],
  );
}

// ---------------------------------------------------------------------------
// Case view
// ---------------------------------------------------------------------------

export type CaseView = {
  id: string;
  status: "open" | "closed";
  created_at: Date;
  closed_at: Date | null;
  booking: {
    id: string;
    tboh: string;
    hotel_name: string;
    check_in_date: string; // a calendar date, "2027-06-10", not an instant
    lcd_at: Date;
  };
  tickets: Ticket[];
};

export async function getCase(principal: Principal, caseId: string): Promise<CaseView> {
  requirePermission(principal, "case:read");

  return tx(principal, async (db) => {
    // RLS hides other agencies' cases, so hidden and missing are both 404.
    const result = await db.query(
      `SELECT c.id, c.status, c.created_at, c.closed_at,
              b.id AS booking_id, b.tboh, b.hotel_name,
              b.check_in_date::text AS check_in_date, b.lcd_at
         FROM cases c
         JOIN bookings b ON b.id = c.booking_id
        WHERE c.id = $1`,
      [caseId],
    );
    const row = result.rows[0];
    if (!row) throw notFound("Case not found.");

    const tickets = await db.query<Ticket>(
      `SELECT ${TICKET_COLUMNS} FROM tickets WHERE case_id = $1 ORDER BY created_at, id LIMIT 500`,
      [caseId],
    );

    return {
      id: row.id,
      status: row.status,
      created_at: row.created_at,
      closed_at: row.closed_at,
      booking: {
        id: row.booking_id,
        tboh: row.tboh,
        hotel_name: row.hotel_name,
        check_in_date: row.check_in_date,
        lcd_at: row.lcd_at,
      },
      tickets: tickets.rows,
    };
  });
}
