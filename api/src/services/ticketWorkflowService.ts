import type { PoolClient } from "pg";
import { requirePermission } from "../core/auth.js";
import { conflict, forbidden, unprocessable } from "../core/errors.js";
import { asSystem, tx } from "../db/tx.js";
import type { Intent, Principal, TicketStatus } from "../domain/enums.js";
import { canTransition, isKnownTransition, transitionEffects } from "../domain/stateMachine.js";
import type { UpdateTicketInput } from "../schemas/tickets.js";
import { closeCaseIfFinished } from "./caseService.js";
import { countsAsLoad, moveLoad } from "./loadService.js";
import { addEvent, addOutbox, findTicket, TICKET_COLUMNS, type Ticket } from "./shared.js";
import { computeSlaFor } from "./slaService.js";

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

    // A different priority means a different deadline. It is worked out again
    // from the ticket's creation time, then moved later by however long the
    // clock has been paused so far.
    let dueAt: Date | null = null;
    let atRiskAt: Date | null = null;
    if (input.priority && input.priority !== before.priority) {
      const sla = await computeSlaFor(db, {
        regionCode: before.region_code,
        priority: input.priority,
        createdAt: before.created_at,
        checkInAt: before.check_in_at,
        lcdAt: before.lcd_at,
      });
      const pausedMs = before.sla_paused_total * 1000;
      dueAt = new Date(sla.dueAt.getTime() + pausedMs);
      atRiskAt = new Date(sla.atRiskAt.getTime() + pausedMs);
    }

    // COALESCE keeps the old value for every field that was not sent.
    // A breached ticket stays breached; otherwise the state starts again and
    // the SLA scanner will raise it when the new deadline comes close.
    const result = await db.query<Ticket>(
      `UPDATE tickets
          SET subject = COALESCE($3, subject),
              priority = COALESCE($4, priority),
              sla_due_at = COALESCE($5, sla_due_at),
              sla_at_risk_at = COALESCE($6, sla_at_risk_at),
              sla_state = CASE WHEN $5::timestamptz IS NOT NULL AND sla_state <> 'breached'
                               THEN 'on_track' ELSE sla_state END,
              version = version + 1,
              updated_at = now()
        WHERE id = $1 AND version = $2
        RETURNING ${TICKET_COLUMNS}`,
      [ticketId, expectedVersion, input.subject ?? null, input.priority ?? null, dueAt, atRiskAt],
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

  // Who owns the ticket afterwards.
  //   escalating      -> an escalation manager of the region takes it
  //   de-escalating   -> nobody: it goes back to triage and is routed again
  //   everything else -> the owner stays
  let assigneeId = ticket.assignee_id;
  if (to === "escalated") assigneeId = await pickEscalationManager(db, ticket.region_code);
  if (from === "escalated" && to === "open") assigneeId = null;

  // One UPDATE applies every side effect of the move:
  //   resolved_at / closed_at   as the transition table says
  //   the SLA clock             entering pending pauses it. Leaving pending
  //                             resumes it: the deadline moves later by
  //                             exactly the time spent waiting.
  // The right-hand sides read the OLD row, so "sla_paused_at IS NOT NULL"
  // means "this ticket is leaving pending".
  const effects = transitionEffects(from, to);
  const result = await db.query<Ticket>(
    `UPDATE tickets
        SET status = $3,
            assignee_id = $6,
            resolved_at = CASE $4 WHEN 'set' THEN now() WHEN 'clear' THEN NULL ELSE resolved_at END,
            closed_at = CASE WHEN $5 THEN now() ELSE closed_at END,
            sla_paused_at = CASE WHEN $3 = 'pending' THEN now() END,
            sla_due_at = sla_due_at + COALESCE(now() - sla_paused_at, interval '0'),
            sla_at_risk_at = sla_at_risk_at + COALESCE(now() - sla_paused_at, interval '0'),
            sla_paused_total = sla_paused_total
              + COALESCE(extract(epoch FROM now() - sla_paused_at)::int, 0),
            sla_state = CASE WHEN sla_paused_at IS NOT NULL AND sla_state = 'at_risk'
                             THEN 'on_track' ELSE sla_state END,
            version = version + 1,
            updated_at = now()
      WHERE id = $1 AND version = $2
      RETURNING ${TICKET_COLUMNS}`,
    [
      ticket.id,
      ticket.version,
      to,
      effects.resolvedAt ?? "keep",
      effects.closedAt === "set",
      assigneeId,
    ],
  );
  let after = result.rows[0];
  if (!after) throw versionConflict();

  // Agent load. The ticket row was changed first, the presence rows second:
  // always that order (see loadService.ts).
  // Resolving releases the agent; reopening takes a place again.
  const loadBefore = countsAsLoad(from) ? ticket.assignee_id : null;
  const loadAfter = countsAsLoad(to) ? assigneeId : null;
  // The counters are updated as the system: when a requester reopens a
  // ticket, their own identity cannot see the agent tables (RLS).
  const hadRoom = await asSystem(db, principal, () => moveLoad(db, loadBefore, loadAfter));
  if (!hadRoom) {
    // The owner is at their limit (a reopened ticket whose agent filled up in
    // the meantime). The ticket goes to triage instead of breaking the limit.
    assigneeId = null;
    const unassigned = await db.query<Ticket>(
      `UPDATE tickets SET assignee_id = NULL WHERE id = $1 RETURNING ${TICKET_COLUMNS}`,
      [ticket.id],
    );
    after = unassigned.rows[0]!;
  }

  // Closing the last open ticket of a case closes the case too.
  if (to === "closed") {
    await closeCaseIfFinished(db, after.case_id);
  }

  await addEvent(db, after, principal.userId, "status_changed", { from, to });
  if (assigneeId !== ticket.assignee_id) {
    await addEvent(db, after, principal.userId, "ticket_assigned", {
      from: ticket.assignee_id,
      to: assigneeId,
      by: to === "escalated" ? "escalation" : "status_change",
    });
  }
  await addOutbox(db, after.id, "ticket.status_changed", { ticket_id: after.id, from, to });
  return after;
}

// The escalation manager of the ticket's region who holds the fewest
// escalated tickets. Null when the region has none; the ticket then waits,
// unowned, in the escalations queue.
async function pickEscalationManager(db: PoolClient, regionCode: string): Promise<string | null> {
  const result = await db.query<{ id: string }>(
    `SELECT u.id
       FROM users u
       JOIN teams tm ON tm.id = u.team_id
      WHERE tm.region_code = $1 AND u.role = 'escalation_manager' AND u.is_active
      ORDER BY (SELECT count(*) FROM tickets t
                 WHERE t.assignee_id = u.id AND t.status = 'escalated'), u.id
      LIMIT 1`,
    [regionCode],
  );
  return result.rows[0]?.id ?? null;
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

    // Move the load from the old owner to the new one (hazard 16). If the new
    // owner is at their limit, throwing rolls back the ticket change as well.
    const loadBefore = countsAsLoad(before.status) ? before.assignee_id : null;
    if (!(await moveLoad(db, loadBefore, assigneeId))) {
      throw conflict(
        "agent_at_capacity",
        "This agent already has as many tickets as they can hold.",
      );
    }

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
