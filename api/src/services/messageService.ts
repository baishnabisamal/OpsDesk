import { requirePermission } from "../core/auth.js";
import { conflict, notFound } from "../core/errors.js";
import { tx } from "../db/tx.js";
import type { Principal, Visibility } from "../domain/enums.js";
import { addEvent, addOutbox, findTicket, TICKET_COLUMNS, type Ticket } from "./shared.js";
import { changeStatus } from "./ticketWorkflowService.js";

// Messages are what people wrote: public replies and internal notes.
// The timeline is the list of facts about what changed.
// Both are append-only: the app role can INSERT but has no UPDATE or DELETE.

export type Message = {
  id: string;
  ticket_id: string;
  author_id: string;
  author_name: string;
  visibility: Visibility;
  body: string;
  created_at: Date;
};

export type TimelineEvent = {
  id: string;
  ticket_id: string;
  actor_id: string | null; // null = the system
  type: string;
  visibility: Visibility;
  data: object;
  created_at: Date;
};

export async function addMessage(
  principal: Principal,
  ticketId: string,
  input: { body: string; visibility: Visibility },
): Promise<Message> {
  return tx(principal, async (db) => {
    // First a plain read: 404 if the ticket is hidden, then the role check.
    await findTicket(db, ticketId);
    requirePermission(
      principal,
      input.visibility === "internal" ? "message:write_internal" : "message:write_public",
    );

    // Hazard 13: a requester replies while an agent closes the ticket.
    // FOR UPDATE locks the ticket row until this transaction ends, so the
    // status we read here cannot change underneath us. The lock is held for a
    // few milliseconds, never while a person is thinking.
    const locked = await db.query<Ticket>(
      `SELECT ${TICKET_COLUMNS} FROM tickets WHERE id = $1 FOR UPDATE`,
      [ticketId],
    );
    const ticket = locked.rows[0];
    if (!ticket) throw notFound("Ticket not found.");

    if (ticket.status === "closed") {
      throw conflict(
        "ticket_closed",
        "A closed ticket cannot take new messages. Raise a new ticket.",
      );
    }

    const inserted = await db.query<Omit<Message, "author_name">>(
      `INSERT INTO messages (ticket_id, agency_id, author_id, visibility, body)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, ticket_id, author_id, visibility, body, created_at`,
      [ticket.id, ticket.agency_id, principal.userId, input.visibility, input.body],
    );
    const message = inserted.rows[0]!;

    // The event has the same visibility as the message, so a requester's
    // timeline does not even reveal that an internal note was written.
    await addEvent(
      db,
      ticket,
      principal.userId,
      "message_added",
      { message_id: message.id },
      input.visibility,
    );
    await addOutbox(db, ticket.id, "message.created", {
      ticket_id: ticket.id,
      message_id: message.id,
      visibility: input.visibility,
    });

    // The reopen rule: a requester's reply on a ticket that was waiting for
    // them, or that was resolved, puts it back to open. It goes through the
    // same changeStatus function as every other status change.
    const waiting = ticket.status === "pending" || ticket.status === "resolved";
    if (principal.role === "requester" && waiting) {
      await changeStatus(db, principal, ticket, "open");
    }

    const author = await db.query<{ full_name: string }>(
      "SELECT full_name FROM users WHERE id = $1",
      [principal.userId],
    );
    return { ...message, author_name: author.rows[0]?.full_name ?? "" };
  });
}

// There is no "WHERE visibility = 'public'" below. Row-Level Security hides
// internal rows from requesters in the database, so this query cannot leak
// them even if someone edits it later.

export async function listMessages(principal: Principal, ticketId: string): Promise<Message[]> {
  return tx(principal, async (db) => {
    await findTicket(db, ticketId);
    requirePermission(principal, "message:read");

    const result = await db.query<Message>(
      `SELECT m.id, m.ticket_id, m.author_id, u.full_name AS author_name,
              m.visibility, m.body, m.created_at
         FROM messages m
         JOIN users u ON u.id = m.author_id
        WHERE m.ticket_id = $1
        ORDER BY m.created_at, m.id
        LIMIT 500`,
      [ticketId],
    );
    return result.rows;
  });
}

export async function listTimeline(
  principal: Principal,
  ticketId: string,
): Promise<TimelineEvent[]> {
  return tx(principal, async (db) => {
    await findTicket(db, ticketId);
    requirePermission(principal, "timeline:read");

    const result = await db.query<TimelineEvent>(
      `SELECT id, ticket_id, actor_id, type, visibility, data, created_at
         FROM ticket_events
        WHERE ticket_id = $1
        ORDER BY created_at, id
        LIMIT 500`,
      [ticketId],
    );
    return result.rows;
  });
}
