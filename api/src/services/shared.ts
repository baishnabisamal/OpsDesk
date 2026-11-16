import type { PoolClient } from "pg";
import { notFound } from "../core/errors.js";
import type { Intent, Priority, TicketStatus, Visibility } from "../domain/enums.js";
import type { IntentSource } from "../domain/intentRules.js";
import type { SlaState } from "../domain/sla.js";

// Things every ticket service needs: the ticket row shape, and the helpers
// that write a timeline event and an outbox row.

// The shape of a ticket as the API returns it. It is the table row without
// search_vector, which is only for the database.
export type Ticket = {
  id: string;
  agency_id: string;
  booking_id: string;
  case_id: string;
  requester_id: string;
  subject: string;
  body: string;
  intent: Intent;
  intent_source: IntentSource;
  intent_confidence: number | null;
  model_version: string | null;
  needs_review: boolean;
  priority: Priority;
  status: TicketStatus;
  assignee_id: string | null;
  team_id: string | null;
  check_in_at: Date;
  lcd_at: Date;
  region_code: string;
  sla_due_at: Date;
  sla_at_risk_at: Date;
  sla_state: SlaState;
  sla_paused_at: Date | null;
  sla_paused_total: number; // seconds
  created_at: Date;
  updated_at: Date;
  resolved_at: Date | null;
  closed_at: Date | null;
  version: number;
};

export const TICKET_COLUMNS = `id, agency_id, booking_id, case_id, requester_id, subject, body, intent,
  intent_source, intent_confidence, model_version, needs_review, priority, status, assignee_id, team_id, check_in_at, lcd_at, region_code,
  sla_due_at, sla_at_risk_at, sla_state, sla_paused_at, sla_paused_total, created_at, updated_at, resolved_at, closed_at, version`;

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
