import { requirePermission } from "../core/auth.js";
import { badRequest } from "../core/errors.js";
import { decodeCursor, encodeCursor } from "../core/pagination.js";
import { tx } from "../db/tx.js";
import type { Intent, Principal } from "../domain/enums.js";
import type { SlaState } from "../domain/sla.js";
import { TICKET_COLUMNS, type Ticket } from "./shared.js";

// Queue views: the lists agents work from. Every queue is sorted by SLA
// deadline, soonest first, so the ticket at the top is always the one to do
// next.
//
// Each queue's WHERE clause matches one partial index from migration 006
// exactly. A partial index only contains the rows its WHERE allows (live
// tickets), so it stays small even when the table holds millions of closed
// tickets. For PostgreSQL to use it, the query must say at least what the
// index says, which is why the status lists below are copied from the
// migration word for word.

export const QUEUE_NAMES = [
  "triage",
  "mine",
  "region",
  "team",
  "intent",
  "escalations",
  "linked",
] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export type QueueQuery = {
  region?: string;
  team_id?: string;
  intent?: Intent;
  sla_state?: SlaState;
  limit: number;
  cursor?: string;
};

export type QueuePage = { items: Ticket[]; next_cursor: string | null };

// The part of the WHERE clause that defines each queue.
// $1 is the queue's own parameter (a user, region, team or intent), when it has one.
function queueCondition(name: QueueName, principal: Principal, query: QueueQuery) {
  switch (name) {
    case "triage":
      // Nobody owns these yet. Index: tickets_triage.
      return { sql: "assignee_id IS NULL AND status IN ('new', 'open')", param: null };

    case "mine":
      // Index: tickets_assignee_queue.
      return {
        sql: "assignee_id = $1 AND status IN ('open', 'pending', 'escalated')",
        param: principal.userId,
      };

    case "region":
      if (!query.region) throw badRequest("The region queue needs ?region=");
      // Index: tickets_region_queue.
      return {
        sql: "region_code = $1 AND status IN ('new', 'open', 'pending', 'escalated')",
        param: query.region,
      };

    case "team": {
      // Default: the caller's own team.
      const teamId = query.team_id ?? principal.teamId;
      if (!teamId) throw badRequest("The team queue needs ?team_id= (you are not in a team).");
      // Index: tickets_team_queue.
      return {
        sql: "team_id = $1 AND status IN ('new', 'open', 'pending', 'escalated')",
        param: teamId,
      };
    }

    case "intent":
      if (!query.intent) throw badRequest("The intent queue needs ?intent=");
      // Index: tickets_intent_queue.
      return {
        sql: "intent = $1 AND status IN ('new', 'open', 'pending', 'escalated')",
        param: query.intent,
      };

    case "escalations":
      // Index: tickets_escalated_queue.
      return { sql: "status = 'escalated'", param: null };

    case "linked":
      // Live tickets that are not alone: another live ticket shares their
      // case, or they have an active link. These are the ones to read
      // together before replying.
      return {
        sql: `status IN ('new', 'open', 'pending', 'escalated')
              AND (EXISTS (SELECT 1 FROM tickets other
                            WHERE other.case_id = tickets.case_id
                              AND other.id <> tickets.id
                              AND other.status IN ('new', 'open', 'pending', 'escalated'))
                   OR EXISTS (SELECT 1 FROM ticket_links l
                               WHERE l.removed_at IS NULL
                                 AND (l.ticket_a = tickets.id OR l.ticket_b = tickets.id)))`,
        param: null,
      };
  }
}

export async function getQueue(
  principal: Principal,
  name: QueueName,
  query: QueueQuery,
): Promise<QueuePage> {
  requirePermission(principal, "queue:read");

  const condition = queueCondition(name, principal, query);
  const conditions = [condition.sql];
  const params: unknown[] = [];
  const addParam = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  // The queue's own parameter is always $1, as written in queueCondition.
  if (condition.param !== null) addParam(condition.param);

  if (query.sla_state) conditions.push(`sla_state = ${addParam(query.sla_state)}`);
  if (query.cursor) {
    // Keyset paging on (sla_due_at, id), the same order as the index. The
    // cursor holds the last row's deadline as PostgreSQL text (microseconds).
    const cursor = decodeCursor(query.cursor);
    conditions.push(
      `(sla_due_at, id) > (${addParam(cursor.createdAt)}::timestamptz, ${addParam(cursor.id)}::uuid)`,
    );
  }
  const limit = addParam(query.limit + 1); // one extra row tells us if there is a next page

  const rows = await tx(principal, async (db) => {
    const result = await db.query<Ticket & { cursor_due_at: string }>(
      `SELECT ${TICKET_COLUMNS}, sla_due_at::text AS cursor_due_at
         FROM tickets
        WHERE ${conditions.join(" AND ")}
        ORDER BY sla_due_at, id
        LIMIT ${limit}`,
      params,
    );
    return result.rows;
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];

  return {
    items: page.map((row) => {
      const ticket: Ticket & { cursor_due_at?: string } = { ...row };
      delete ticket.cursor_due_at;
      return ticket;
    }),
    next_cursor:
      hasMore && last ? encodeCursor({ createdAt: last.cursor_due_at, id: last.id }) : null,
  };
}
