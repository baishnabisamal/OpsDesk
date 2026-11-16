import type { PoolClient } from "pg";
import { requirePermission } from "../core/auth.js";
import { conflict, notFound, unprocessable } from "../core/errors.js";
import * as ml from "../core/mlClient.js";
import { tx } from "../db/tx.js";
import type { Intent, Principal, TicketStatus } from "../domain/enums.js";
import {
  CANDIDATE_WINDOW_DAYS,
  MAX_CANDIDATES,
  orderPair,
  pickSimilar,
  type SimilarTicket,
} from "../domain/linkage.js";
import { addEvent, addOutbox, findTicket, type Ticket } from "./shared.js";

// Links join two tickets on DIFFERENT bookings that are about the same
// problem. Tickets on the same booking need no link: they share a case.

// ---------------------------------------------------------------------------
// Automatic links on create
// ---------------------------------------------------------------------------

// Step 1, BEFORE the create transaction: find recent tickets with the same
// intent on other bookings, and ask the ML service how alike their text is.
// It never throws: with the ML service down it returns no matches and the
// ticket is simply created without links.
export async function findSimilarTickets(
  principal: Principal,
  input: { tboh: string; intent: Intent; subject: string; body: string },
): Promise<SimilarTicket[]> {
  // A read-only transaction of its own, so no lock or connection is held
  // while we wait for the ML service. RLS limits a requester to their agency.
  const candidates = await tx(principal, async (db) => {
    const result = await db.query<{ id: string; subject: string; body: string }>(
      `SELECT t.id, t.subject, t.body
         FROM tickets t
         JOIN bookings b ON b.id = t.booking_id
        WHERE t.intent = $1
          AND t.status <> 'closed'
          AND t.created_at > now() - make_interval(days => $3)
          AND b.tboh <> $2
        ORDER BY t.created_at DESC
        LIMIT $4`,
      [input.intent, input.tboh, CANDIDATE_WINDOW_DAYS, MAX_CANDIDATES],
    );
    return result.rows;
  });
  if (candidates.length === 0) return [];

  const scores = await ml.similarity(
    ml.joinText(input.subject, input.body),
    candidates.map((ticket) => ({ id: ticket.id, text: ml.joinText(ticket.subject, ticket.body) })),
  );
  return scores ? pickSimilar(scores) : [];
}

// Step 2, INSIDE the create transaction: store the links found in step 1.
export async function addAutomaticLinks(db: PoolClient, ticket: Ticket, similar: SimilarTicket[]) {
  for (const match of similar) {
    const [a, b] = orderPair(ticket.id, match.id);
    // The other ticket was read a moment ago in a different transaction.
    // The WHERE re-checks it still exists and is in the same agency.
    const inserted = await db.query(
      `INSERT INTO ticket_links (ticket_a, ticket_b, agency_id, reason, score)
       SELECT $1, $2, $3, 'similar_text', $5
        WHERE EXISTS (SELECT 1 FROM tickets WHERE id = $4 AND agency_id = $3)
       ON CONFLICT DO NOTHING`,
      [a, b, ticket.agency_id, match.id, match.score],
    );
    if (inserted.rowCount === 0) continue;

    const data = { reason: "similar_text", score: match.score };
    await addEvent(db, ticket, null, "ticket_linked", { ticket_id: match.id, ...data });
    await addEvent(db, { id: match.id, agency_id: ticket.agency_id }, null, "ticket_linked", {
      ticket_id: ticket.id,
      ...data,
    });
    await addOutbox(db, ticket.id, "ticket.linked", { ticket_id: ticket.id, linked_id: match.id });
  }
}

// ---------------------------------------------------------------------------
// Manual link, unlink, list
// ---------------------------------------------------------------------------

export type LinkedTicket = {
  ticket_id: string;
  subject: string;
  status: TicketStatus;
  case_id: string;
  reason: "similar_text" | "manual";
  score: number | null;
  linked_at: Date;
};

export async function linkTickets(principal: Principal, ticketId: string, otherId: string) {
  return tx(principal, async (db) => {
    const ticket = await findTicket(db, ticketId); // 404 first
    requirePermission(principal, "ticket:link"); // then 403

    if (ticketId === otherId) {
      throw unprocessable("invalid_link", "A ticket cannot be linked to itself.");
    }
    const otherResult = await db.query<{ id: string; agency_id: string; case_id: string }>(
      "SELECT id, agency_id, case_id FROM tickets WHERE id = $1",
      [otherId],
    );
    const other = otherResult.rows[0];
    if (!other) {
      throw unprocessable("invalid_link", "The ticket to link to was not found.");
    }
    if (other.agency_id !== ticket.agency_id) {
      throw unprocessable("invalid_link", "Tickets of different agencies cannot be linked.");
    }
    if (other.case_id === ticket.case_id) {
      throw unprocessable("invalid_link", "These tickets are already in the same case.");
    }

    // The partial unique index allows one active link per pair. If two
    // people link the same pair at once, the second insert adds nothing.
    const [a, b] = orderPair(ticketId, otherId);
    const inserted = await db.query(
      `INSERT INTO ticket_links (ticket_a, ticket_b, agency_id, reason, created_by)
       VALUES ($1, $2, $3, 'manual', $4)
       ON CONFLICT (ticket_a, ticket_b) WHERE removed_at IS NULL DO NOTHING`,
      [a, b, ticket.agency_id, principal.userId],
    );
    if (inserted.rowCount === 0) {
      throw conflict("already_linked", "These tickets are already linked.");
    }

    const data = { reason: "manual" };
    await addEvent(db, ticket, principal.userId, "ticket_linked", { ticket_id: otherId, ...data });
    await addEvent(db, other, principal.userId, "ticket_linked", { ticket_id: ticketId, ...data });
    await addOutbox(db, ticketId, "ticket.linked", { ticket_id: ticketId, linked_id: otherId });
  });
}

export async function unlinkTickets(principal: Principal, ticketId: string, otherId: string) {
  return tx(principal, async (db) => {
    const ticket = await findTicket(db, ticketId);
    requirePermission(principal, "ticket:link");

    // Nothing is deleted. The row is marked removed and stays as history.
    // "AND removed_at IS NULL" means two people unlinking at once cannot
    // both succeed: the second update matches no row.
    const [a, b] = orderPair(ticketId, otherId);
    const removed = await db.query(
      `UPDATE ticket_links
          SET removed_at = now(), removed_by = $3
        WHERE ticket_a = $1 AND ticket_b = $2 AND removed_at IS NULL`,
      [a, b, principal.userId],
    );
    if (removed.rowCount === 0) throw notFound("These tickets are not linked.");

    await addEvent(db, ticket, principal.userId, "ticket_unlinked", { ticket_id: otherId });
    await addEvent(
      db,
      { id: otherId, agency_id: ticket.agency_id },
      principal.userId,
      "ticket_unlinked",
      { ticket_id: ticketId },
    );
    await addOutbox(db, ticketId, "ticket.unlinked", { ticket_id: ticketId, linked_id: otherId });
  });
}

export async function listLinks(principal: Principal, ticketId: string): Promise<LinkedTicket[]> {
  return tx(principal, async (db) => {
    await findTicket(db, ticketId);
    requirePermission(principal, "ticket:read");

    // The ticket can be on either side of the pair, so pick "the other one".
    const result = await db.query<LinkedTicket>(
      `SELECT t.id AS ticket_id, t.subject, t.status, t.case_id,
              l.reason, l.score, l.created_at AS linked_at
         FROM ticket_links l
         JOIN tickets t
           ON t.id = CASE WHEN l.ticket_a = $1 THEN l.ticket_b ELSE l.ticket_a END
        WHERE (l.ticket_a = $1 OR l.ticket_b = $1)
          AND l.removed_at IS NULL
        ORDER BY l.created_at, t.id`,
      [ticketId],
    );
    return result.rows;
  });
}
