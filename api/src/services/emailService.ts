import { createHash } from "node:crypto";
import nodemailer, { type Transporter } from "nodemailer";
import { config } from "../core/config.js";
import { tx } from "../db/tx.js";
import { SYSTEM_PRINCIPAL } from "../domain/enums.js";

// Sends outbound side messages by email, one email per participant.
//
// Delivery from the stream is AT-LEAST-ONCE: the same event can arrive twice
// (the relay re-published it, or a worker died before acknowledging it). The
// email_deliveries table turns that into "each person gets the email once":
//
//   1. CLAIM the (message, recipient) row in one statement. Only one worker
//      can win the claim; a row already marked 'sent' is never claimed.
//   2. SEND, with no transaction open (architecture rule 4).
//   3. MARK the row 'sent'.
//
// The one gap no system can close: the worker dies after the mail server
// accepted the email but before step 3. The row stays 'sending'; once its
// lease runs out, a retry sends again. It sends with the SAME Message-ID,
// which mail clients use to recognise a repeat. At-least-once is chosen on
// purpose: an email sent twice is better than an email never sent.

const LEASE_SECONDS = 60;

export function createMailTransport(): Transporter {
  const { smtpAuth } = config.mail;
  return nodemailer.createTransport({
    host: config.mail.smtpHost,
    port: config.mail.smtpPort,
    secure: config.mail.smtpSecure,
    // With a login, refuse to continue without TLS, so the password and the
    // emails (which carry sign-in links) never cross the internet in plain text.
    requireTLS: smtpAuth !== null && !config.mail.smtpSecure,
    ...(smtpAuth ? { auth: smtpAuth } : {}),
    connectionTimeout: 5000,
  });
}

// The Message-ID is worked out from the message and the recipient, so every
// attempt for the same pair uses the same one.
export function messageIdFor(sideMessageId: string, recipient: string): string {
  const hash = createHash("sha256").update(recipient).digest("hex").slice(0, 12);
  return `<sm-${sideMessageId}-${hash}@opsdesk.local>`;
}

// Replies go to an address that names the thread, so the inbound webhook
// knows where a reply belongs without trusting anything else in the email.
export function replyAddressFor(conversationId: string): string {
  return `reply+${conversationId}@${config.mail.inboundDomain}`;
}

type MessageToSend = {
  side_message_id: string;
  side_conversation_id: string;
  direction: "outbound" | "inbound";
  body: string;
  subject: string;
  author_name: string | null;
  recipients: string[];
};

export type DeliveryOptions = {
  // For tests: behave like a worker that is killed right after the mail
  // server accepted the email, before it could record that.
  crashAfterSend?: boolean;
};

// sent        emails sent in this call
// skipped     already sent earlier: nothing to do
// inProgress  another worker holds a fresh lease, or one died while holding
//             it. NOT done: the caller must try again later, or the email
//             could be lost.
export type DeliveryResult = { sent: number; skipped: number; inProgress: number };

export async function deliverSideMessage(
  transport: Transporter,
  sideMessageId: string,
  options: DeliveryOptions = {},
): Promise<DeliveryResult> {
  const result: DeliveryResult = { sent: 0, skipped: 0, inProgress: 0 };

  const message = await tx(SYSTEM_PRINCIPAL, async (db) => {
    const found = await db.query<MessageToSend>(
      `SELECT m.id AS side_message_id, m.side_conversation_id, m.direction, m.body,
              c.subject, u.full_name AS author_name,
              ARRAY(SELECT p.email FROM side_participants p
                     WHERE p.side_conversation_id = c.id ORDER BY p.email) AS recipients
         FROM side_messages m
         JOIN side_conversations c ON c.id = m.side_conversation_id
         LEFT JOIN users u ON u.id = m.author_id
        WHERE m.id = $1`,
      [sideMessageId],
    );
    return found.rows[0];
  });
  // Inbound messages came FROM the supplier; there is nothing to send.
  if (!message || message.direction !== "outbound") return result;

  for (const recipient of message.recipients) {
    const messageId = messageIdFor(sideMessageId, recipient);

    // 1. Claim. Either a new row is inserted, or an existing row that is not
    //    sent and whose lease ran out (a worker died) is taken over. If
    //    another worker holds a fresh lease, or it is already sent, nothing
    //    is returned and we skip this recipient.
    const claim = await tx(SYSTEM_PRINCIPAL, async (db) => {
      const row = await db.query(
        `INSERT INTO email_deliveries (side_message_id, recipient, message_id, claimed_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (side_message_id, recipient) DO UPDATE
           SET attempts = email_deliveries.attempts + 1, claimed_at = now()
         WHERE email_deliveries.status = 'sending'
           AND (email_deliveries.claimed_at IS NULL
                OR email_deliveries.claimed_at < now() - make_interval(secs => $4))
         RETURNING id`,
        [sideMessageId, recipient, messageId, LEASE_SECONDS],
      );
      if (row.rowCount === 1) return "claimed";
      // Not claimed: find out why.
      const existing = await db.query<{ status: string }>(
        "SELECT status FROM email_deliveries WHERE side_message_id = $1 AND recipient = $2",
        [sideMessageId, recipient],
      );
      return existing.rows[0]?.status === "sent" ? "already_sent" : "in_progress";
    });
    if (claim === "already_sent") {
      result.skipped += 1;
      continue;
    }
    if (claim === "in_progress") {
      result.inProgress += 1;
      continue;
    }

    // 2. Send, no transaction open.
    try {
      await transport.sendMail({
        from: config.mail.from,
        to: recipient,
        replyTo: replyAddressFor(message.side_conversation_id),
        subject: `[OpsDesk] ${message.subject}`,
        text: message.author_name ? `${message.body}\n\n${message.author_name}` : message.body,
        messageId,
      });
    } catch (err) {
      // Release the lease so the next try does not have to wait for it.
      await tx(SYSTEM_PRINCIPAL, async (db) => {
        await db.query(
          "UPDATE email_deliveries SET claimed_at = NULL, last_error = $3 WHERE side_message_id = $1 AND recipient = $2",
          [sideMessageId, recipient, (err as Error).message.slice(0, 500)],
        );
      });
      throw err;
    }

    if (options.crashAfterSend) {
      throw new Error("simulated crash after sending");
    }

    // 3. Mark it sent.
    await tx(SYSTEM_PRINCIPAL, async (db) => {
      await db.query(
        `UPDATE email_deliveries SET status = 'sent', sent_at = now(), last_error = NULL
          WHERE side_message_id = $1 AND recipient = $2`,
        [sideMessageId, recipient],
      );
    });
    result.sent += 1;
  }
  return result;
}
