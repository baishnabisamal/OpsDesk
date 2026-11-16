import type { PoolClient } from "pg";
import { tx } from "../db/tx.js";
import { SYSTEM_PRINCIPAL, type Intent } from "../domain/enums.js";
import { planRouting, type AgentSnapshot, type Shift } from "../domain/routing.js";
import { canTransition } from "../domain/stateMachine.js";
import { addEvent, addOutbox, TICKET_COLUMNS, type Ticket } from "./shared.js";

// Routing: give an unassigned ticket to the best agent who can take it.
// The rules (who is eligible, who scores highest) are pure functions in
// domain/routing.ts. This file reads the agents, makes the choice stick in
// the database, and records why.

// Step 1: the shortlist. Every agent in a team of the ticket's region, with
// presence, skills and shifts. This is only a SNAPSHOT: by the time we act
// on it another transaction may have given the same agent a ticket.
async function loadAgents(db: PoolClient, regionCode: string) {
  const result = await db.query<{
    user_id: string;
    full_name: string;
    team_id: string;
    is_online: boolean;
    open_count: number;
    max_open: number;
    skills: Intent[];
    shifts: Shift[];
  }>(
    `SELECT u.id AS user_id, u.full_name, u.team_id,
            p.is_online, p.open_count, p.max_open,
            ARRAY(SELECT s.intent FROM agent_skills s WHERE s.user_id = u.id) AS skills,
            COALESCE((SELECT json_agg(json_build_object(
                               'weekday', sh.weekday,
                               'startMinute', sh.start_minute,
                               'endMinute', sh.end_minute))
                        FROM agent_shifts sh WHERE sh.user_id = u.id), '[]') AS shifts
       FROM users u
       JOIN teams tm ON tm.id = u.team_id
       JOIN agent_presence p ON p.user_id = u.id
      WHERE tm.region_code = $1 AND u.role = 'agent' AND u.is_active`,
    [regionCode],
  );
  return result.rows;
}

// Step 3: claim one place in an agent's load.
//
// FOR UPDATE locks the presence row, and the limit is checked AGAIN on the
// locked row, because the shortlist may be out of date (hazard 4).
//
// SKIP LOCKED means: if another transaction holds this agent's row right
// now, do not wait for it, just report "not available" so the caller tries
// the next agent. Waiting would be dangerous here: two creates could each
// hold one agent's row and wait for the other's (a deadlock).
async function claimAgent(db: PoolClient, userId: string): Promise<boolean> {
  const locked = await db.query(
    `SELECT 1 FROM agent_presence
      WHERE user_id = $1 AND is_online AND open_count < max_open
        FOR UPDATE SKIP LOCKED`,
    [userId],
  );
  if (locked.rowCount === 0) return false;

  await db.query(
    "UPDATE agent_presence SET open_count = open_count + 1, updated_at = now() WHERE user_id = $1",
    [userId],
  );
  return true;
}

// Routes one ticket inside the caller's transaction. The ticket must be
// unassigned, and the caller must already hold it (it was just inserted, or
// it is locked), so nobody else can assign it at the same time.
// Returns the ticket as it is afterwards: assigned and open, or unchanged.
export async function routeTicket(
  db: PoolClient,
  ticket: Ticket,
  now: Date,
  options: { recordNoCandidate: boolean } = { recordNoCandidate: true },
): Promise<Ticket> {
  const regionResult = await db.query<{ time_zone: string }>(
    "SELECT time_zone FROM regions WHERE code = $1",
    [ticket.region_code],
  );
  const agents = await loadAgents(db, ticket.region_code);
  const teamOf = new Map(agents.map((agent) => [agent.user_id, agent.team_id]));

  // Step 2: filter, then rank (pure).
  const snapshots: AgentSnapshot[] = agents.map((agent) => ({
    userId: agent.user_id,
    name: agent.full_name,
    isOnline: agent.is_online,
    openCount: agent.open_count,
    maxOpen: agent.max_open,
    skills: agent.skills,
    shifts: agent.shifts,
  }));
  const plan = planRouting(snapshots, ticket, now, regionResult.rows[0]!.time_zone);

  // Step 3: best candidate first, take the first one that can be claimed.
  let chosenId: string | null = null;
  for (const candidate of plan.ranked) {
    if (await claimAgent(db, candidate.userId)) {
      chosenId = candidate.userId;
      break;
    }
  }

  // Step 4: record the decision and its reasons. The retry job skips the
  // "nobody available" record, or it would add a row every few minutes for
  // every waiting ticket.
  if (chosenId || options.recordNoCandidate) {
    await db.query(
      `INSERT INTO routing_decisions (ticket_id, agency_id, outcome, chosen_id, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        ticket.id,
        ticket.agency_id,
        chosenId ? "assigned" : "no_candidate",
        chosenId,
        JSON.stringify({ ranked: plan.ranked, rejected: plan.rejected }),
      ],
    );
  }

  if (!chosenId) return ticket; // stays in triage; the retry job tries again later

  // A new ticket becomes open when it gets an owner. The system actor makes
  // that move through the same transition table as a person would.
  const opens = ticket.status === "new";
  if (opens && !canTransition("new", "open", "system")) return ticket;

  const updated = await db.query<Ticket>(
    `UPDATE tickets
        SET assignee_id = $2, team_id = $3, status = 'open',
            version = version + 1, updated_at = now()
      WHERE id = $1
      RETURNING ${TICKET_COLUMNS}`,
    [ticket.id, chosenId, teamOf.get(chosenId)],
  );
  const after = updated.rows[0]!;

  await addEvent(db, after, null, "ticket_assigned", { from: null, to: chosenId, by: "routing" });
  if (opens) {
    await addEvent(db, after, null, "status_changed", { from: "new", to: "open" });
  }
  await addOutbox(db, after.id, "ticket.assigned", { ticket_id: after.id, assignee_id: chosenId });
  return after;
}

// ---------------------------------------------------------------------------
// The retry job: route tickets that are waiting in triage
// ---------------------------------------------------------------------------

// Triage = live tickets with no owner. A ticket lands there when nobody could
// take it at create time (everyone offline, off shift or full).
//
// Each ticket is routed in its own short transaction. FOR UPDATE SKIP LOCKED
// (hazard 5) lets two workers run this at once: each locks a different
// ticket, and neither waits for the other.
export async function retryRouting(
  options: { regionCode?: string; limit?: number; now?: Date } = {},
): Promise<{ examined: number; assigned: number }> {
  const limit = options.limit ?? 200;
  let examined = 0;
  let assigned = 0;
  const seen: string[] = [];

  while (examined < limit) {
    const outcome = await tx(SYSTEM_PRINCIPAL, async (db) => {
      const next = await db.query<Ticket>(
        `SELECT ${TICKET_COLUMNS}
           FROM tickets
          WHERE assignee_id IS NULL
            AND status IN ('new', 'open')
            AND ($1::text IS NULL OR region_code = $1)
            AND id <> ALL($2::uuid[])
          ORDER BY sla_due_at, id
          LIMIT 1
            FOR UPDATE SKIP LOCKED`,
        [options.regionCode ?? null, seen],
      );
      const ticket = next.rows[0];
      if (!ticket) return "none";

      seen.push(ticket.id); // do not pick it again in this run
      const after = await routeTicket(db, ticket, options.now ?? new Date(), {
        recordNoCandidate: false,
      });
      return after.assignee_id ? "assigned" : "waiting";
    });

    if (outcome === "none") break;
    examined += 1;
    if (outcome === "assigned") assigned += 1;
  }
  return { examined, assigned };
}
