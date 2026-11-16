import type { PoolClient } from "pg";
import { requirePermission } from "../core/auth.js";
import { tx } from "../db/tx.js";
import type { Principal, TicketStatus } from "../domain/enums.js";

// Agent load: agent_presence.open_count says how many live tickets an agent
// holds. Routing reads it to keep agents under their limit, so it must
// always be right.
//
// Three rules keep it right:
//   1. It changes only here, and only in the same transaction as the ticket
//      change it counts. If the transaction rolls back, both roll back.
//   2. Every change is a single UPDATE on the presence row. PostgreSQL locks
//      that row for the UPDATE, so two transactions cannot both read "4" and
//      both write "5".
//   3. Lock order: a transaction always changes the TICKET row first and the
//      presence row second. If some code did it the other way round, two
//      transactions could each hold one row and wait for the other for ever
//      (a deadlock).

// A ticket counts towards its assignee's load in these statuses.
const LOAD_STATUSES: TicketStatus[] = ["open", "pending", "escalated"];

export function countsAsLoad(status: TicketStatus): boolean {
  return LOAD_STATUSES.includes(status);
}

// Tries to add one ticket to the agent's load.
// Returns false when the agent is at their limit. The check and the increment
// are ONE statement, so the limit cannot be passed by two requests at once
// (hazard 4). The CHECK constraint on the table is the backstop.
export async function takeLoad(db: PoolClient, userId: string): Promise<boolean> {
  const taken = await db.query(
    `UPDATE agent_presence
        SET open_count = open_count + 1, updated_at = now()
      WHERE user_id = $1 AND open_count < max_open`,
    [userId],
  );
  if (taken.rowCount === 1) return true;

  // Nothing updated: either the agent is full, or this user has no presence
  // row at all. Only agents have one; managers and leads are not capped.
  const row = await db.query("SELECT 1 FROM agent_presence WHERE user_id = $1", [userId]);
  return row.rowCount === 0;
}

export async function releaseLoad(db: PoolClient, userId: string) {
  await db.query(
    `UPDATE agent_presence
        SET open_count = open_count - 1, updated_at = now()
      WHERE user_id = $1`,
    [userId],
  );
}

// Moves one ticket's worth of load between two people, or just adds or
// removes it when one side is null.
// Hazard 16: when two presence rows change, they are always changed in the
// order of their user ids. Two transfers going in opposite directions
// (A to B and B to A) then ask for the rows in the same order and cannot
// deadlock.
export async function moveLoad(
  db: PoolClient,
  fromUserId: string | null,
  toUserId: string | null,
): Promise<boolean> {
  if (fromUserId === toUserId) return true;

  const steps: { userId: string; action: "release" | "take" }[] = [];
  if (fromUserId) steps.push({ userId: fromUserId, action: "release" });
  if (toUserId) steps.push({ userId: toUserId, action: "take" });
  steps.sort((a, b) => a.userId.localeCompare(b.userId));

  for (const step of steps) {
    if (step.action === "release") {
      await releaseLoad(db, step.userId);
    } else if (!(await takeLoad(db, step.userId))) {
      return false; // the new owner is full; the caller rolls back
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

export type Presence = {
  user_id: string;
  is_online: boolean;
  open_count: number;
  max_open: number;
};

// Going online or offline. The first time, the row is created.
export async function setOnline(
  db: PoolClient,
  userId: string,
  online: boolean,
): Promise<Presence> {
  const result = await db.query<Presence>(
    `INSERT INTO agent_presence (user_id, is_online)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET is_online = EXCLUDED.is_online, updated_at = now()
     RETURNING user_id, is_online, open_count, max_open`,
    [userId, online],
  );
  return result.rows[0]!;
}

export async function setPresence(principal: Principal, online: boolean): Promise<Presence> {
  requirePermission(principal, "presence:update");
  return tx(principal, (db) => setOnline(db, principal.userId!, online));
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export type LoadDrift = { user_id: string; stored: number; actual: number };

// Recounts every agent's live tickets and reports where the stored counter
// disagrees. It should always return nothing; any row is a concurrency bug.
export async function findLoadDrift(db: PoolClient): Promise<LoadDrift[]> {
  const result = await db.query<LoadDrift>(
    `SELECT p.user_id, p.open_count AS stored, count(t.id)::int AS actual
       FROM agent_presence p
       LEFT JOIN tickets t
         ON t.assignee_id = p.user_id AND t.status = ANY($1)
      GROUP BY p.user_id, p.open_count
     HAVING p.open_count <> count(t.id)`,
    [LOAD_STATUSES],
  );
  return result.rows;
}
