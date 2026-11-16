import type { PoolClient } from "pg";
import { requirePermission } from "../core/auth.js";
import { conflict, forbidden, unprocessable } from "../core/errors.js";
import { tx } from "../db/tx.js";
import type { Intent, Principal, TicketStatus } from "../domain/enums.js";
import { canTransition, isKnownTransition, transitionEffects } from "../domain/stateMachine.js";
import type { UpdateTicketInput } from "../schemas/tickets.js";
import { addEvent, addOutbox, findTicket, TICKET_COLUMNS, type Ticket } from "./ticketService.js";

// Changes to an existing ticket: edit, status transition, assign.
//
// All three follow the same steps, in the same order:
//   1. read the ticket          (404 if RLS hides it or it does not exist)
//   2. check the role           (403)
//   3. check the version        (409 if someone else changed it first)
//   4. UPDATE ... WHERE version = the version we were given
//   5. write the timeline event and the outbox row
//
// Step 4 is optimistic locking (hazards 2 and 3 in README section 9). No lock
// is held while a person looks at the ticket. Instead every UPDATE repeats the
// version in its WHERE clause; if another request got in first, the version
// has moved on, zero rows match, and this request gets a 409.

function versionConflict() {
  return conflict(
    "version_conflict",
    "The ticket was changed by someone else. Reload and try again.",
  );
}

// ---------------------------------------------------------------------------
// Edit fields
// ---------------------------------------------------------------------------

export async function updateTicket(
  principal: Principal,
  ticketId: string,
  expectedVersion: number,
  input: UpdateTicketInput,
): Promise<Ticket> {
  return tx(principal, async (db) => {
    const before = await findTicket(db, ticketId);
    requirePermission(principal, "ticket:edit");
    if (before.version !== expectedVersion) throw versionConflict();

    // COALESCE keeps the old value for every field that was not sent.
    const result = await db.query<Ticket>(
      `UPDATE tickets
          SET subject = COALESCE($3, subject),
              priority = COALESCE($4, priority),
              version = version + 1,
              updated_at = now()
        WHERE id = $1 AND version = $2
        RETURNING ${TICKET_COLUMNS}`,
      [ticketId, expectedVersion, input.subject ?? null, input.priority ?? null],
    );
    const after = result.rows[0];
    if (!after) throw versionConflict();

    // Record what changed, old value and new value, for the timeline.
    const changes: Record<string, { from: string; to: string }> = {};
    for (const field of ["subject", "priority"] as const) {
      if (before[field] !== after[field]) {
        changes[field] = { from: before[field], to: after[field] };
      }
    }

    await addEvent(db, after, principal.userId, "ticket_updated", { changes });
    await addOutbox(db, after.id, "ticket.updated", {
      ticket_id: after.id,
      version: after.version,
    });
    return after;
  });
}

// ---------------------------------------------------------------------------
// Change status
// ---------------------------------------------------------------------------

// The single place a status is changed (architecture rule 5). It is called by
// the transitions endpoint and by the message service (a requester's reply
// reopens a ticket), and background jobs will call it too.
// It must run inside the caller's transaction.
export async function changeStatus(
  db: PoolClient,
  principal: Principal,
  ticket: Ticket,
  to: TicketStatus,
): Promise<Ticket> {
  const from = ticket.status;

  if (!isKnownTransition(from, to)) {
    throw conflict("invalid_transition", `A ticket cannot go from ${from} to ${to}.`);
  }
  if (!canTransition(from, to, principal.role)) {
    throw forbidden(`Your role may not move a ticket from ${from} to ${to}.`);
  }

  const effects = transitionEffects(from, to);
  const result = await db.query<Ticket>(
    `UPDATE tickets
        SET status = $3,
            resolved_at = CASE $4 WHEN 'set' THEN now() WHEN 'clear' THEN NULL ELSE resolved_at END,
            closed_at = CASE WHEN $5 THEN now() ELSE closed_at END,
            version = version + 1,
            updated_at = now()
      WHERE id = $1 AND version = $2
      RETURNING ${TICKET_COLUMNS}`,
    [ticket.id, ticket.version, to, effects.resolvedAt ?? "keep", effects.closedAt === "set"],
  );
  const after = result.rows[0];
  if (!after) throw versionConflict();

  await addEvent(db, after, principal.userId, "status_changed", { from, to });
  await addOutbox(db, after.id, "ticket.status_changed", { ticket_id: after.id, from, to });
  return after;
}

export async function transitionTicket(
  principal: Principal,
  ticketId: string,
  expectedVersion: number,
  to: TicketStatus,
): Promise<Ticket> {
  return tx(principal, async (db) => {
    const ticket = await findTicket(db, ticketId);
    requirePermission(principal, "ticket:transition");
    if (ticket.version !== expectedVersion) throw versionConflict();

    // new -> open means "someone took it", so it only happens through assign.
    if (ticket.status === "new") {
      throw conflict("invalid_transition", "A new ticket is opened by assigning it to someone.");
    }

    return changeStatus(db, principal, ticket, to);
  });
}

// ---------------------------------------------------------------------------
// Assign
// ---------------------------------------------------------------------------

export async function assignTicket(
  principal: Principal,
  ticketId: string,
  expectedVersion: number,
  assigneeId: string,
): Promise<Ticket> {
  return tx(principal, async (db) => {
    const before = await findTicket(db, ticketId);

    // Taking a free ticket yourself is allowed for all staff. Anything else
    // (giving it to someone, taking it from someone) needs a lead.
    const takingFreeTicket = assigneeId === principal.userId && before.assignee_id === null;
    requirePermission(principal, takingFreeTicket ? "ticket:assign_self" : "ticket:assign_other");

    if (before.version !== expectedVersion) throw versionConflict();

    if (before.status === "resolved" || before.status === "closed") {
      throw conflict("ticket_not_assignable", `A ${before.status} ticket cannot be assigned.`);
    }
    if (before.assignee_id === assigneeId) {
      throw conflict("already_assigned", "The ticket is already assigned to this user.");
    }

    // The assignee must be an active member of staff.
    const assigneeResult = await db.query<{ team_id: string | null }>(
      "SELECT team_id FROM users WHERE id = $1 AND is_active AND role <> 'requester'",
      [assigneeId],
    );
    const assignee = assigneeResult.rows[0];
    if (!assignee) {
      throw unprocessable("invalid_assignee", "The assignee must be an active staff member.");
    }

    // Assigning a new ticket also opens it, through the transition table.
    const opens = before.status === "new";
    if (opens && !canTransition("new", "open", principal.role)) {
      throw forbidden();
    }

    const result = await db.query<Ticket>(
      `UPDATE tickets
          SET assignee_id = $3,
              team_id = $4,
              status = $5,
              version = version + 1,
              updated_at = now()
        WHERE id = $1 AND version = $2
        RETURNING ${TICKET_COLUMNS}`,
      [ticketId, expectedVersion, assigneeId, assignee.team_id, opens ? "open" : before.status],
    );
    const after = result.rows[0];
    if (!after) throw versionConflict();

    await addEvent(db, after, principal.userId, "ticket_assigned", {
      from: before.assignee_id,
      to: assigneeId,
    });
    if (opens) {
      await addEvent(db, after, principal.userId, "status_changed", { from: "new", to: "open" });
    }
    await addOutbox(db, after.id, "ticket.assigned", {
      ticket_id: after.id,
      assignee_id: assigneeId,
    });
    return after;
  });
}

// ---------------------------------------------------------------------------
// Override the intent
// ---------------------------------------------------------------------------

// A person corrects (or confirms) the intent that a rule or the model chose.
// Every override is stored in intent_overrides with what it replaced. Those
// rows are the labels a future model is trained on: the human in the loop.
export async function overrideIntent(
  principal: Principal,
  ticketId: string,
  expectedVersion: number,
  intent: Intent,
): Promise<Ticket> {
  return tx(principal, async (db) => {
    const before = await findTicket(db, ticketId);
    requirePermission(principal, "ticket:override_intent");
    if (before.version !== expectedVersion) throw versionConflict();

    // A person has now decided, so the source becomes 'manual', the model's
    // confidence and version are cleared, and the review flag is dropped.
    const result = await db.query<Ticket>(
      `UPDATE tickets
          SET intent = $3,
              intent_source = 'manual',
              intent_confidence = NULL,
              model_version = NULL,
              needs_review = false,
              version = version + 1,
              updated_at = now()
        WHERE id = $1 AND version = $2
        RETURNING ${TICKET_COLUMNS}`,
      [ticketId, expectedVersion, intent],
    );
    const after = result.rows[0];
    if (!after) throw versionConflict();

    await db.query(
      `INSERT INTO intent_overrides
         (ticket_id, agency_id, from_intent, to_intent, from_source, model_version, overridden_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        after.id,
        after.agency_id,
        before.intent,
        intent,
        before.intent_source,
        before.model_version,
        principal.userId,
      ],
    );

    await addEvent(db, after, principal.userId, "intent_overridden", {
      from: before.intent,
      to: intent,
      from_source: before.intent_source,
    });
    await addOutbox(db, after.id, "ticket.intent_overridden", {
      ticket_id: after.id,
      from: before.intent,
      to: intent,
    });
    return after;
  });
}
