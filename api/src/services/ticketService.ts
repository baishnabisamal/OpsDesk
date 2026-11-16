import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { requirePermission } from "../core/auth.js";
import { notFound, unprocessable } from "../core/errors.js";
import { tx } from "../db/tx.js";
import type { Intent, Principal, Priority, TicketStatus, Visibility } from "../domain/enums.js";
import type { CreateTicketInput } from "../schemas/tickets.js";

// The shape of a ticket as the API returns it. It is the table row without
// search_vector, which is only for the database.
export type Ticket = {
  id: string;
  agency_id: string;
  booking_id: string;
  requester_id: string;
  subject: string;
  body: string;
  intent: Intent;
  priority: Priority;
  status: TicketStatus;
  assignee_id: string | null;
  team_id: string | null;
  check_in_at: Date;
  lcd_at: Date;
  region_code: string;
  created_at: Date;
  updated_at: Date;
  resolved_at: Date | null;
  closed_at: Date | null;
  version: number;
};

export const TICKET_COLUMNS = `id, agency_id, booking_id, requester_id, subject, body, intent,
  priority, status, assignee_id, team_id, check_in_at, lcd_at, region_code,
  created_at, updated_at, resolved_at, closed_at, version`;

// ---------------------------------------------------------------------------
// Helpers shared by every state change
// ---------------------------------------------------------------------------

// Rule 3: every state change writes the change, a timeline event and an
// outbox row in one transaction. These two functions are the second and third.

export async function addEvent(
  db: PoolClient,
  ticket: { id: string; agency_id: string },
  actorId: string | null,
  type: string,
  data: object,
  visibility: Visibility = "public",
) {
  await db.query(
    `INSERT INTO ticket_events (ticket_id, agency_id, actor_id, type, visibility, data)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [ticket.id, ticket.agency_id, actorId, type, visibility, JSON.stringify(data)],
  );
}

export async function addOutbox(
  db: PoolClient,
  ticketId: string,
  eventType: string,
  payload: object,
) {
  await db.query("INSERT INTO outbox (ticket_id, event_type, payload) VALUES ($1, $2, $3)", [
    ticketId,
    eventType,
    JSON.stringify(payload),
  ]);
}

// Reads a ticket inside the caller's transaction. Row-Level Security hides
// other agencies' tickets, so "hidden" and "does not exist" both end up here
// as 404 and an id cannot be probed.
export async function findTicket(db: PoolClient, ticketId: string): Promise<Ticket> {
  const result = await db.query<Ticket>(`SELECT ${TICKET_COLUMNS} FROM tickets WHERE id = $1`, [
    ticketId,
  ]);
  const ticket = result.rows[0];
  if (!ticket) throw notFound("Ticket not found.");
  return ticket;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export type CreateResult = { ticket: Ticket; replayed: boolean };

export async function createTicket(
  principal: Principal,
  input: CreateTicketInput,
  idempotencyKey: string,
): Promise<CreateResult> {
  requirePermission(principal, "ticket:create");

  // A fingerprint of the body, to tell a real retry from a reused key.
  const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");

  return tx(principal, async (db) => {
    // Hazard 1: claim the key. The primary key (user_id, key) lets only one
    // transaction insert it. A retry arriving at the same moment WAITS on
    // this statement until the first transaction commits, then inserts nothing.
    const claim = await db.query(
      `INSERT INTO idempotency_keys (user_id, key, request_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, key) DO NOTHING`,
      [principal.userId, idempotencyKey, requestHash],
    );

    if (claim.rowCount === 0) {
      // The key was used before: replay the saved response.
      const saved = await db.query<{ request_hash: string; response_body: Ticket }>(
        "SELECT request_hash, response_body FROM idempotency_keys WHERE user_id = $1 AND key = $2",
        [principal.userId, idempotencyKey],
      );
      const row = saved.rows[0]!;
      if (row.request_hash !== requestHash) {
        throw unprocessable(
          "idempotency_key_reused",
          "This Idempotency-Key was already used with a different request body.",
        );
      }
      return { ticket: row.response_body, replayed: true };
    }

    // The booking supplies the agency and the travel dates. RLS means a
    // requester can only find bookings of their own agency.
    const bookingResult = await db.query<{ id: string }>(
      "SELECT id FROM bookings WHERE tboh = $1",
      [input.tboh],
    );
    const booking = bookingResult.rows[0];
    if (!booking) {
      // Throwing rolls back the key claim too, so the client may retry.
      throw unprocessable("booking_not_found", "No booking with this TBOH was found.");
    }

    // Travel fields are copied from the booking in SQL. The check-in date
    // becomes an instant using the hotel's time zone and a 14:00 check-in time.
    const inserted = await db.query<Ticket>(
      `INSERT INTO tickets (agency_id, booking_id, requester_id, subject, body, intent, priority,
                            check_in_at, lcd_at, region_code)
       SELECT b.agency_id, b.id, $2, $3, $4, $5, $6,
              (b.check_in_date + time '14:00') AT TIME ZONE b.hotel_time_zone,
              b.lcd_at, b.region_code
         FROM bookings b
        WHERE b.id = $1
       RETURNING ${TICKET_COLUMNS}`,
      [booking.id, principal.userId, input.subject, input.body, input.intent, input.priority],
    );
    const ticket = inserted.rows[0]!;

    await addEvent(db, ticket, principal.userId, "ticket_created", {
      priority: ticket.priority,
      intent: ticket.intent,
    });
    await addOutbox(db, ticket.id, "ticket.created", { ticket_id: ticket.id });

    // Save the response on the key, in the same transaction as the ticket.
    await db.query(
      `UPDATE idempotency_keys SET status_code = 201, response_body = $3
        WHERE user_id = $1 AND key = $2`,
      [principal.userId, idempotencyKey, JSON.stringify(ticket)],
    );

    return { ticket, replayed: false };
  });
}

// ---------------------------------------------------------------------------
// Read one
// ---------------------------------------------------------------------------

export async function getTicket(principal: Principal, ticketId: string): Promise<Ticket> {
  requirePermission(principal, "ticket:read");
  return tx(principal, (db) => findTicket(db, ticketId));
}
