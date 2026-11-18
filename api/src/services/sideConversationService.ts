import type { PoolClient } from "pg";
import { requirePermission } from "../core/auth.js";
import { conflict, notFound } from "../core/errors.js";
import { tx } from "../db/tx.js";
import type { Principal } from "../domain/enums.js";
import { addEvent, addOutbox, findTicket } from "./shared.js";

// Side conversations: email threads with people outside OpsDesk (hotels,
// suppliers), attached to a ticket and visible to staff only.
//
// Ownership is separate from assignment. The recipients are stored on the
// conversation when it starts, so they do not change when the ticket moves
// to another agent or team. That is what lets a supplier's reply still reach
// the right thread after two transfers.

export type Participant = { email: string; name: string | null };

export type SideMessage = {
  id: string;
  side_conversation_id: string;
  direction: "outbound" | "inbound";
  author_id: string | null;
  from_email: string | null;
  body: string;
  created_at: Date;
};

export type SideConversation = {
  id: string;
  ticket_id: string;
  subject: string;
  status: "open" | "closed";
  created_by: string;
  created_at: Date;
  participants: Participant[];
  messages: SideMessage[];
};

const MESSAGE_COLUMNS =
  "id, side_conversation_id, direction, author_id, from_email, body, created_at";

// Writes one message, its timeline event and its outbox row. The email
// worker picks up the outbox event for outbound messages and sends them.
export async function insertSideMessage(
  db: PoolClient,
  conversation: { id: string; ticket_id: string; agency_id: string },
  message: {
    direction: "outbound" | "inbound";
    authorId: string | null;
    fromEmail: string | null;
    body: string;
  },
): Promise<SideMessage> {
  const inserted = await db.query<SideMessage>(
    `INSERT INTO side_messages (side_conversation_id, ticket_id, direction, author_id, from_email, body)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${MESSAGE_COLUMNS}`,
    [
      conversation.id,
      conversation.ticket_id,
      message.direction,
      message.authorId,
      message.fromEmail,
      message.body,
    ],
  );
  const saved = inserted.rows[0]!;

  const ticket = { id: conversation.ticket_id, agency_id: conversation.agency_id };
  await addEvent(
    db,
    ticket,
    message.authorId,
    "side_message_added",
    {
      side_conversation_id: conversation.id,
      side_message_id: saved.id,
      direction: message.direction,
    },
    "internal",
  );
  await addOutbox(db, conversation.ticket_id, "side_message.created", {
    ticket_id: conversation.ticket_id,
    side_conversation_id: conversation.id,
    side_message_id: saved.id,
    direction: message.direction,
  });
  return saved;
}

async function loadConversation(db: PoolClient, conversationId: string): Promise<SideConversation> {
  const result = await db.query<Omit<SideConversation, "participants" | "messages">>(
    `SELECT id, ticket_id, subject, status, created_by, created_at
       FROM side_conversations WHERE id = $1`,
    [conversationId],
  );
  const conversation = result.rows[0];
  if (!conversation) throw notFound("Side conversation not found.");

  const participants = await db.query<Participant>(
    "SELECT email, name FROM side_participants WHERE side_conversation_id = $1 ORDER BY email",
    [conversationId],
  );
  const messages = await db.query<SideMessage>(
    `SELECT ${MESSAGE_COLUMNS} FROM side_messages
      WHERE side_conversation_id = $1 ORDER BY created_at, id`,
    [conversationId],
  );
  return { ...conversation, participants: participants.rows, messages: messages.rows };
}

// ---------------------------------------------------------------------------
// Start a conversation
// ---------------------------------------------------------------------------

export async function startSideConversation(
  principal: Principal,
  ticketId: string,
  input: { subject: string; participants: Participant[]; body: string },
): Promise<SideConversation> {
  return tx(principal, async (db) => {
    const ticket = await findTicket(db, ticketId); // 404 first
    requirePermission(principal, "side_conversation:write"); // then 403
    if (ticket.status === "closed") {
      throw conflict("ticket_closed", "A closed ticket cannot start a side conversation.");
    }

    const created = await db.query<{ id: string }>(
      `INSERT INTO side_conversations (ticket_id, agency_id, subject, created_by)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [ticket.id, ticket.agency_id, input.subject, principal.userId],
    );
    const conversationId = created.rows[0]!.id;

    // The same address twice (in any letter case) is one participant.
    for (const participant of input.participants) {
      await db.query(
        `INSERT INTO side_participants (side_conversation_id, email, name)
         VALUES ($1, lower($2), $3) ON CONFLICT DO NOTHING`,
        [conversationId, participant.email, participant.name],
      );
    }

    await addEvent(
      db,
      ticket,
      principal.userId,
      "side_conversation_started",
      { side_conversation_id: conversationId, participants: input.participants.length },
      "internal",
    );

    const conversation = { id: conversationId, ticket_id: ticket.id, agency_id: ticket.agency_id };
    await insertSideMessage(db, conversation, {
      direction: "outbound",
      authorId: principal.userId,
      fromEmail: null,
      body: input.body,
    });

    return loadConversation(db, conversationId);
  });
}

// ---------------------------------------------------------------------------
// Reply, read, list
// ---------------------------------------------------------------------------

export async function addSideMessage(
  principal: Principal,
  conversationId: string,
  body: string,
): Promise<SideMessage> {
  return tx(principal, async (db) => {
    // Requesters cannot see side conversations at all (RLS), so for them
    // this is a 404, the same as an id that does not exist.
    const found = await db.query<{
      id: string;
      ticket_id: string;
      agency_id: string;
      status: string;
    }>("SELECT id, ticket_id, agency_id, status FROM side_conversations WHERE id = $1", [
      conversationId,
    ]);
    const conversation = found.rows[0];
    if (!conversation) throw notFound("Side conversation not found.");
    requirePermission(principal, "side_conversation:write");
    if (conversation.status === "closed") {
      throw conflict("side_conversation_closed", "This side conversation is closed.");
    }

    return insertSideMessage(db, conversation, {
      direction: "outbound",
      authorId: principal.userId,
      fromEmail: null,
      body,
    });
  });
}

export async function getSideConversation(
  principal: Principal,
  conversationId: string,
): Promise<SideConversation> {
  return tx(principal, async (db) => {
    // Load first: RLS hides the thread from requesters, so they get the same
    // 404 as for an id that does not exist. Then the role check.
    const conversation = await loadConversation(db, conversationId);
    requirePermission(principal, "side_conversation:read");
    return conversation;
  });
}

export async function listSideConversations(
  principal: Principal,
  ticketId: string,
): Promise<Omit<SideConversation, "messages">[]> {
  return tx(principal, async (db) => {
    await findTicket(db, ticketId); // 404 first
    requirePermission(principal, "side_conversation:read");

    const result = await db.query<Omit<SideConversation, "messages">>(
      `SELECT c.id, c.ticket_id, c.subject, c.status, c.created_by, c.created_at,
              COALESCE((SELECT json_agg(json_build_object('email', p.email, 'name', p.name)
                                        ORDER BY p.email)
                          FROM side_participants p
                         WHERE p.side_conversation_id = c.id), '[]') AS participants
         FROM side_conversations c
        WHERE c.ticket_id = $1
        ORDER BY c.created_at, c.id`,
      [ticketId],
    );
    return result.rows;
  });
}
