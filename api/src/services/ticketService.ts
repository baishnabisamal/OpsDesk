import { createHash } from "node:crypto";
import { requirePermission } from "../core/auth.js";
import { unprocessable } from "../core/errors.js";
import { decodeCursor, encodeCursor } from "../core/pagination.js";
import { asSystem, tx } from "../db/tx.js";
import * as ml from "../core/mlClient.js";
import type { Principal } from "../domain/enums.js";
import { classifyByRules, decideIntent } from "../domain/intentRules.js";
import { extractTboh } from "../domain/text.js";
import type { CreateTicketInput, ListTicketsQuery } from "../schemas/tickets.js";
import { findOrCreateOpenCase } from "./caseService.js";
import { addAutomaticLinks, findSimilarTickets } from "./linkService.js";
import { routeTicket } from "./routingService.js";
import { addEvent, addOutbox, findTicket, TICKET_COLUMNS, type Ticket } from "./shared.js";
import { computeSlaFor } from "./slaService.js";

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export type CreateResult = { ticket: Ticket; replayed: boolean };

// What create needs from the booking, read in one query.
type BookingForTicket = {
  id: string;
  agency_id: string;
  region_code: string;
  check_in_at: Date;
  lcd_at: Date;
  now: Date; // the transaction's time
};

export async function createTicket(
  principal: Principal,
  input: CreateTicketInput,
  idempotencyKey: string,
): Promise<CreateResult> {
  requirePermission(principal, "ticket:create");

  // A fingerprint of the body, to tell a real retry from a reused key.
  const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");

  // The booking reference: the tboh field, or one found in the text.
  const tboh = input.tboh ?? extractTboh(`${input.subject} ${input.body}`);
  if (!tboh) {
    throw unprocessable(
      "tboh_required",
      "Send the booking reference in `tboh`, or mention it in the subject or body.",
    );
  }

  // Work out the intent BEFORE the transaction opens (architecture rule 4:
  // no external call inside a transaction). Cheap keyword rules go first; the
  // ML service is asked only when no rule fires. ml.classify never throws and
  // never takes longer than its timeout: if the service is down it returns
  // null and the ticket is created as 'other', flagged for review.
  const rule = classifyByRules(input.subject, input.body);
  const prediction = rule ? null : await ml.classify(ml.joinText(input.subject, input.body));
  const decision = decideIntent(rule, prediction);

  // Also before the transaction: look for recent tickets on OTHER bookings
  // that say the same thing, to link them. Skipped when the ML service just
  // failed, because similarity needs it too.
  const similar =
    decision.source === "fallback"
      ? []
      : await findSimilarTickets(principal, {
          tboh,
          intent: decision.intent,
          subject: input.subject,
          body: input.body,
        });

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
    const bookingResult = await db.query<BookingForTicket>(
      `SELECT id, agency_id, region_code, lcd_at,
              (check_in_date + time '14:00') AT TIME ZONE hotel_time_zone AS check_in_at,
              now() AS now
         FROM bookings WHERE tboh = $1`,
      [tboh],
    );
    const booking = bookingResult.rows[0];
    if (!booking) {
      // Throwing rolls back the key claim too, so the client may retry.
      throw unprocessable("booking_not_found", "No booking with this TBOH was found.");
    }

    // Every ticket belongs to the open case of its booking (hazard 6).
    const caseId = await findOrCreateOpenCase(db, booking);

    // The SLA deadline, from the priority and the booking's own deadlines.
    // `booking.now` is the transaction's time, the same value the database
    // puts in created_at, so the deadline is measured from the right instant.
    const sla = await computeSlaFor(db, {
      regionCode: booking.region_code,
      priority: input.priority,
      createdAt: booking.now,
      checkInAt: booking.check_in_at,
      lcdAt: booking.lcd_at,
    });

    // Travel fields are copied from the booking. The check-in date becomes an
    // instant using the hotel's time zone and a 14:00 check-in time.
    const inserted = await db.query<Ticket>(
      `INSERT INTO tickets (agency_id, booking_id, case_id, requester_id, subject, body, priority,
                            intent, intent_source, intent_confidence, model_version, needs_review,
                            check_in_at, lcd_at, region_code, sla_due_at, sla_at_risk_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       RETURNING ${TICKET_COLUMNS}`,
      [
        booking.agency_id,
        booking.id,
        caseId,
        principal.userId,
        input.subject,
        input.body,
        input.priority,
        decision.intent,
        decision.source,
        decision.confidence,
        decision.modelVersion,
        decision.needsReview,
        booking.check_in_at,
        booking.lcd_at,
        booking.region_code,
        sla.dueAt,
        sla.atRiskAt,
      ],
    );
    const created = inserted.rows[0]!;

    await addEvent(db, created, principal.userId, "ticket_created", {
      priority: created.priority,
      intent: created.intent,
      intent_source: created.intent_source,
      case_id: created.case_id,
      sla_due_at: created.sla_due_at,
      sla_basis: sla.basis,
    });
    await addOutbox(db, created.id, "ticket.created", {
      ticket_id: created.id,
      case_id: created.case_id,
    });
    await addAutomaticLinks(db, created, similar);

    // Try to give the ticket to an agent straight away. If nobody can take
    // it, it stays 'new' in the triage queue and the retry job tries later.
    // Routing is the system's work, not the requester's: a requester's
    // identity cannot even see the agents (RLS). See asSystem in db/tx.ts.
    const ticket = await asSystem(db, principal, () => routeTicket(db, created, booking.now));

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

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export type TicketPage = { items: Ticket[]; next_cursor: string | null };

export async function listTickets(
  principal: Principal,
  query: ListTicketsQuery,
): Promise<TicketPage> {
  requirePermission(principal, "ticket:read");

  // Build the WHERE clause from the filters that were actually sent. Values
  // always go in `params` and are referred to as $1, $2...; nothing the
  // client sends is ever pasted into the SQL text.
  const conditions: string[] = [];
  const params: unknown[] = [];
  const addParam = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (query.status) conditions.push(`status = ${addParam(query.status)}`);
  if (query.priority) conditions.push(`priority = ${addParam(query.priority)}`);
  if (query.assignee_id) conditions.push(`assignee_id = ${addParam(query.assignee_id)}`);
  if (query.intent) conditions.push(`intent = ${addParam(query.intent)}`);
  if (query.needs_review) {
    conditions.push(`needs_review = ${addParam(query.needs_review === "true")}`);
  }
  if (query.q) {
    // websearch_to_tsquery understands plain words, "quoted phrases" and -minus.
    conditions.push(`search_vector @@ websearch_to_tsquery('english', ${addParam(query.q)})`);
  }
  if (query.cursor) {
    // Keyset: continue strictly after the last row of the previous page.
    // Comparing the pair (created_at, id) matches the ORDER BY below, and id
    // breaks ties between tickets created in the same instant.
    const cursor = decodeCursor(query.cursor);
    conditions.push(
      `(created_at, id) < (${addParam(cursor.createdAt)}::timestamptz, ${addParam(cursor.id)}::uuid)`,
    );
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  // Ask for one row more than the page size: if it comes back, there is a next page.
  const limit = addParam(query.limit + 1);

  // There is no agency filter here on purpose: Row-Level Security adds it for
  // requesters, and staff see every agency.
  const rows = await tx(principal, async (db) => {
    const result = await db.query<Ticket & { cursor_created_at: string }>(
      `SELECT ${TICKET_COLUMNS}, created_at::text AS cursor_created_at
         FROM tickets
         ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit}`,
      params,
    );
    return result.rows;
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor({ createdAt: last.cursor_created_at, id: last.id }) : null;

  // Drop the helper column before the rows leave the service.
  const items = page.map((row) => {
    const ticket: Ticket & { cursor_created_at?: string } = { ...row };
    delete ticket.cursor_created_at;
    return ticket;
  });

  return { items, next_cursor: nextCursor };
}
