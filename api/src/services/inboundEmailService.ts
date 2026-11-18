import { config } from "../core/config.js";
import { tx } from "../db/tx.js";
import { SYSTEM_PRINCIPAL } from "../domain/enums.js";
import { insertSideMessage } from "./sideConversationService.js";

// Places a supplier's reply into its side conversation.
//
// Where does a reply belong? Outgoing emails carry the reply address
// reply+<thread id>@<inbound domain>, so the thread is read from the address
// the reply was sent TO. Nothing else in the email (subject, quoted text) is
// trusted for that.
//
// A reply is accepted only if the thread exists, is open, and the sender is
// one of its participants. Anything else is kept in quarantine with the
// reason, for a person to look at. It is never silently dropped.

export type InboundEmail = {
  provider_message_id: string;
  from: string;
  to: string;
  subject: string;
  text: string;
};

export type InboundResult =
  | { status: "accepted"; side_message_id: string }
  | { status: "quarantined"; reason: string }
  | { status: "duplicate" };

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

// "Reply+<uuid>@Inbound.OpsDesk.local" -> "<uuid>", or null.
export function threadIdFromAddress(address: string): string | null {
  const pattern = new RegExp(`^reply\\+(${UUID})@(.+)$`, "i");
  const match = pattern.exec(address.trim());
  if (!match || match[2]!.toLowerCase() !== config.mail.inboundDomain.toLowerCase()) return null;
  return match[1]!.toLowerCase();
}

export async function receiveInboundEmail(email: InboundEmail): Promise<InboundResult> {
  const from = email.from.trim().toLowerCase();

  return tx(SYSTEM_PRINCIPAL, async (db) => {
    // 1. Where does it belong, and may it go there?
    const threadId = threadIdFromAddress(email.to);
    let reason: string | null = null;
    let thread: { id: string; ticket_id: string; agency_id: string } | undefined;

    if (!threadId) {
      reason = "not a reply address";
    } else {
      const found = await db.query<{
        id: string;
        ticket_id: string;
        agency_id: string;
        status: string;
      }>("SELECT id, ticket_id, agency_id, status FROM side_conversations WHERE id = $1", [
        threadId,
      ]);
      const conversation = found.rows[0];
      if (!conversation) {
        reason = "unknown side conversation";
      } else if (conversation.status !== "open") {
        reason = "side conversation is closed";
      } else {
        const participant = await db.query(
          "SELECT 1 FROM side_participants WHERE side_conversation_id = $1 AND email = $2",
          [conversation.id, from],
        );
        if (participant.rowCount === 0) reason = "sender is not a participant";
        else thread = conversation;
      }
    }

    // 2. Record it, once. If the provider already posted this email, the
    //    UNIQUE on provider_message_id stops a second row. A duplicate posted
    //    at the very same moment WAITS here for the first transaction, then
    //    inserts nothing.
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO inbound_emails
         (provider_message_id, from_email, to_email, subject, body, status,
          quarantine_reason, side_conversation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (provider_message_id) DO NOTHING
       RETURNING id`,
      [
        email.provider_message_id,
        from,
        email.to.trim().toLowerCase(),
        email.subject,
        email.text,
        thread ? "accepted" : "quarantined",
        reason,
        thread?.id ?? null,
      ],
    );
    const inboundId = inserted.rows[0]?.id;
    if (!inboundId) return { status: "duplicate" };
    if (!thread) return { status: "quarantined", reason: reason! };

    // 3. Add it to the thread (with its timeline event and outbox row), and
    //    link the inbound record to the message.
    const message = await insertSideMessage(db, thread, {
      direction: "inbound",
      authorId: null,
      fromEmail: from,
      body: email.text,
    });
    await db.query("UPDATE inbound_emails SET side_message_id = $2 WHERE id = $1", [
      inboundId,
      message.id,
    ]);
    return { status: "accepted", side_message_id: message.id };
  });
}
