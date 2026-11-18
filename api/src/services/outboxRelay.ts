import type { Redis } from "ioredis";
import { EVENTS_STREAM, STREAM_MAX_LENGTH } from "../core/redis.js";
import { logger } from "../core/logger.js";
import { tx } from "../db/tx.js";
import { SYSTEM_PRINCIPAL } from "../domain/enums.js";

// The outbox relay: copies events from the outbox table into the Redis
// Stream, where the email worker and the WebSocket gateway read them.
//
// Why an outbox at all? A state change and the event announcing it must not
// get out of step. "Commit, then publish" loses the event if the process dies
// between the two lines. "Publish, then commit" announces a change that may
// still roll back. Writing the event into the outbox in the SAME transaction
// as the change, and publishing it afterwards from here, removes both
// failures (README 10.4).

const LEASE_SECONDS = 30;

type OutboxRow = {
  id: string; // bigint arrives from pg as a string
  ticket_id: string;
  agency_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: Date;
};

// One pass: claim a batch, publish it, mark it. Returns how many events were
// published.
export async function relayOnce(redis: Redis, batchSize = 100): Promise<number> {
  // Phase 1, a short transaction: claim up to `batchSize` rows by giving them
  // a lease. FOR UPDATE SKIP LOCKED (hazard 10): two relays running at once
  // each take different rows and never wait for each other. Rows whose lease
  // ran out (a relay died) are claimable again.
  const rows = await tx(SYSTEM_PRINCIPAL, async (db) => {
    const result = await db.query<OutboxRow>(
      `WITH next AS (
         SELECT id FROM outbox
          WHERE published_at IS NULL
            AND (claimed_until IS NULL OR claimed_until < now())
          ORDER BY id
          LIMIT $1
            FOR UPDATE SKIP LOCKED
       )
       UPDATE outbox o
          SET claimed_until = now() + make_interval(secs => $2)
         FROM next
        WHERE o.id = next.id
       RETURNING o.id, o.ticket_id, o.event_type, o.payload, o.created_at,
                 (SELECT t.agency_id FROM tickets t WHERE t.id = o.ticket_id) AS agency_id`,
      [batchSize, LEASE_SECONDS],
    );
    return result.rows;
  });
  if (rows.length === 0) return 0;

  // RETURNING does not promise an order, so put the events back in the order
  // they were written.
  rows.sort((a, b) => Number(a.id) - Number(b.id));

  // Phase 2, NO transaction open (architecture rule 4): publish to Redis.
  // A pipeline sends all the commands in one round trip.
  const pipeline = redis.pipeline();
  for (const row of rows) {
    pipeline.xadd(
      EVENTS_STREAM,
      "MAXLEN",
      "~",
      STREAM_MAX_LENGTH,
      "*", // let Redis choose the entry id
      "event_id",
      row.id,
      "type",
      row.event_type,
      "ticket_id",
      row.ticket_id,
      "agency_id",
      row.agency_id,
      "payload",
      JSON.stringify(row.payload),
      "created_at",
      row.created_at.toISOString(),
    );
  }
  const results = (await pipeline.exec()) ?? [];
  const failed = results.find(([error]) => error !== null);
  if (failed) {
    // Do not mark anything. The leases run out and the rows are published
    // again; consumers drop the ones they already have.
    throw failed[0];
  }

  // Phase 3, a short transaction: mark the batch as published.
  await tx(SYSTEM_PRINCIPAL, async (db) => {
    await db.query(
      "UPDATE outbox SET published_at = now(), claimed_until = NULL WHERE id = ANY($1::bigint[])",
      [rows.map((row) => row.id)],
    );
  });
  return rows.length;
}

// Runs the relay for ever: straight away again while there is a backlog, and
// every `intervalMs` when the outbox is empty. Returns a function that stops it.
export function startRelay(redis: Redis, options: { intervalMs?: number } = {}) {
  const intervalMs = options.intervalMs ?? 200;
  let running = true;
  let failures = 0;

  const loop = async () => {
    while (running) {
      let published = 0;
      try {
        published = await relayOnce(redis);
        failures = 0;
      } catch (err) {
        failures += 1;
        logger.warn({ err, failures }, "outbox relay pass failed");
      }
      if (published === 0) {
        // Idle, or failing: wait. After failures, wait longer (up to 10 s).
        const pause = failures === 0 ? intervalMs : Math.min(10_000, intervalMs * 2 ** failures);
        await new Promise((resolve) => setTimeout(resolve, pause));
      }
    }
  };
  const done = loop();

  return async function stop() {
    running = false;
    await done;
  };
}

// Age of the oldest unpublished event, in seconds: the "outbox lag" from
// README section 16. If it keeps growing, realtime and email are behind.
export async function outboxLagSeconds(): Promise<number> {
  return tx(SYSTEM_PRINCIPAL, async (db) => {
    const result = await db.query<{ lag: number | null }>(
      `SELECT extract(epoch FROM now() - min(created_at))::float AS lag
         FROM outbox WHERE published_at IS NULL`,
    );
    return result.rows[0]!.lag ?? 0;
  });
}
