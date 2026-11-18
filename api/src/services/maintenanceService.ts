import { config } from "../core/config.js";
import { logger } from "../core/logger.js";
import { tx } from "../db/tx.js";
import { SYSTEM_PRINCIPAL } from "../domain/enums.js";
import { findLoadDrift, type LoadDrift } from "./loadService.js";
import { TICKET_COLUMNS, type Ticket } from "./shared.js";
import { changeStatus } from "./ticketWorkflowService.js";

// Housekeeping jobs. Each one is safe to run twice (idempotent): running it
// again finds nothing left to do.

// Closes tickets that were resolved and then left alone for the configured
// time. It uses changeStatus, the same function a person's request uses, as
// the system actor. So the state machine decides whether the move is
// allowed, the case is closed with its last ticket, and the timeline shows
// that the system did it.
//
// One ticket per transaction: a failure on one ticket does not undo the
// others, and no lock is held for long.
export async function autoCloseResolved(limit = 500): Promise<{ closed: number }> {
  let closed = 0;

  while (closed < limit) {
    const didClose = await tx(SYSTEM_PRINCIPAL, async (db) => {
      // SKIP LOCKED: if a person is acting on this ticket right now (say,
      // reopening it), leave it for the next run instead of waiting.
      const next = await db.query<Ticket>(
        `SELECT ${TICKET_COLUMNS}
           FROM tickets
          WHERE status = 'resolved'
            AND resolved_at < now() - make_interval(hours => $1)
          ORDER BY resolved_at
          LIMIT 1
            FOR UPDATE SKIP LOCKED`,
        [config.autoCloseAfterHours],
      );
      const ticket = next.rows[0];
      if (!ticket) return false;

      await changeStatus(db, SYSTEM_PRINCIPAL, ticket, "closed");
      return true;
    });

    if (!didClose) break;
    closed += 1;
  }
  return { closed };
}

// Makes sure the monthly partitions for the next three months exist
// (hazard 15). The work is done by a database function; see migration 007
// for why the app role cannot simply run CREATE TABLE, and why the function
// never waits for a lock.
//
// When the function cannot get its locks straight away (a request is using
// the table), it fails with error 55P03 "lock not available". This loop then
// waits a moment and tries again, in a new transaction. The partitions are
// needed months from now, so giving up for today is fine too: the job runs
// again tomorrow.
const LOCK_NOT_AVAILABLE = "55P03";

export async function ensurePartitions(monthsAhead = 3): Promise<{ created: number }> {
  let created = 0;
  // One transaction per table, so a transaction never holds both tables' locks.
  for (const parent of ["ticket_events", "messages"]) {
    for (let attempt = 1; ; attempt++) {
      try {
        created += await tx(SYSTEM_PRINCIPAL, async (db) => {
          const result = await db.query<{ created: number }>(
            "SELECT create_month_partitions($1, $2) AS created",
            [parent, monthsAhead],
          );
          return result.rows[0]!.created;
        });
        break;
      } catch (err) {
        const busy = (err as { code?: string }).code === LOCK_NOT_AVAILABLE;
        if (!busy || attempt === 20) throw err;
        // A short pause, a little random, so retries do not line up with the traffic.
        await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 100));
      }
    }
  }
  return { created };
}

// Removes retry keys older than 24 hours.
export async function purgeIdempotencyKeys(): Promise<{ removed: number }> {
  return tx(SYSTEM_PRINCIPAL, async (db) => {
    const result = await db.query<{ removed: number }>(
      "SELECT purge_idempotency_keys() AS removed",
    );
    return { removed: result.rows[0]!.removed };
  });
}

// Recounts every agent's live tickets and compares with the stored counter.
// It only REPORTS. A difference means a concurrency bug somewhere; quietly
// fixing the number would hide the bug.
export async function reconcileLoad(): Promise<{ drift: LoadDrift[] }> {
  const drift = await tx(SYSTEM_PRINCIPAL, (db) => findLoadDrift(db));
  if (drift.length > 0) {
    logger.error({ drift }, "agent load counters do not match a recount");
  }
  return { drift };
}
