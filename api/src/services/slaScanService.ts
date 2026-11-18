import { tx } from "../db/tx.js";
import { SYSTEM_PRINCIPAL } from "../domain/enums.js";
import { isWorse, slaState } from "../domain/sla.js";
import { addEvent, addOutbox, TICKET_COLUMNS, type Ticket } from "./shared.js";
import { changeStatus } from "./ticketWorkflowService.js";

// The SLA scanner. Runs every minute and looks for tickets whose clock is
// running (status new or open) and that have reached their at-risk moment or
// their deadline.
//
//   at-risk moment reached -> sla_state becomes 'at_risk'
//   deadline reached       -> sla_state becomes 'breached', and an open
//                             ticket is escalated
//
// The escalation goes through changeStatus, the same function a person's
// request uses, as the system actor. The same rules apply and the timeline
// shows the system did it.
//
// Each ticket is handled in its own short transaction.

export type ScanResult = { atRisk: number; breached: number; escalated: number };

export async function scanSla(limit = 500): Promise<ScanResult> {
  const result: ScanResult = { atRisk: 0, breached: 0, escalated: 0 };
  const seen: string[] = [];

  for (let handled = 0; handled < limit; handled++) {
    const outcome = await tx(SYSTEM_PRINCIPAL, async (db) => {
      // Pick the next due ticket and lock it.
      //
      // FOR UPDATE SKIP LOCKED does two jobs here:
      //   Hazard 8: two scanners running at once each lock a DIFFERENT
      //     ticket. And since the conditions are part of this same
      //     statement, they are checked on the locked row: a ticket the
      //     other scanner just marked breached no longer matches.
      //   Hazard 7: if an agent is resolving this ticket right now, their
      //     transaction holds the row, so the scanner skips it instead of
      //     escalating a ticket that is being resolved.
      const next = await db.query<Ticket & { now: Date }>(
        `SELECT ${TICKET_COLUMNS}, now() AS now
           FROM tickets
          WHERE status IN ('new', 'open')
            AND sla_state <> 'breached'
            AND (sla_due_at <= now() OR (sla_state = 'on_track' AND sla_at_risk_at <= now()))
            AND id <> ALL($1::uuid[])
          ORDER BY sla_due_at
          LIMIT 1
            FOR UPDATE SKIP LOCKED`,
        [seen],
      );
      const ticket = next.rows[0];
      if (!ticket) return "none";
      seen.push(ticket.id);

      // The state is decided by the pure function, using the database's clock.
      const state = slaState(ticket.now, ticket.sla_at_risk_at, ticket.sla_due_at);
      if (!isWorse(state, ticket.sla_state)) return "unchanged";

      // The version goes up: an agent holding the old version gets a 409 and
      // reloads, so they see the new state before they act.
      const updated = await db.query<Ticket>(
        `UPDATE tickets
            SET sla_state = $2, version = version + 1, updated_at = now()
          WHERE id = $1
          RETURNING ${TICKET_COLUMNS}`,
        [ticket.id, state],
      );
      const flagged = updated.rows[0]!;

      await addEvent(db, flagged, null, "sla_state_changed", {
        from: ticket.sla_state,
        to: state,
        sla_due_at: flagged.sla_due_at,
      });
      await addOutbox(db, flagged.id, `ticket.sla_${state}`, { ticket_id: flagged.id });

      // A breached ticket that someone is working on is escalated. A breached
      // ticket still in triage (status new) has no owner to take it from; the
      // transition table has no new -> escalated, so it is only flagged and
      // shows at the top of the triage queue.
      if (state === "breached" && flagged.status === "open") {
        await changeStatus(db, SYSTEM_PRINCIPAL, flagged, "escalated");
        return "escalated";
      }
      return state;
    });

    if (outcome === "none") break;
    if (outcome === "at_risk") result.atRisk += 1;
    if (outcome === "breached" || outcome === "escalated") result.breached += 1;
    if (outcome === "escalated") result.escalated += 1;
  }
  return result;
}
