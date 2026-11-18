import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { createGunzip, createGzip } from "node:zlib";
import { requirePermission } from "../core/auth.js";
import { AppError } from "../core/errors.js";
import { logger } from "../core/logger.js";
import { openObject, putObject } from "../core/objectStore.js";
import { tx } from "../db/tx.js";
import { SYSTEM_PRINCIPAL, isStaff, type Principal } from "../domain/enums.js";
import { findTicket } from "./shared.js";

// Archival: moves old monthly partitions out of PostgreSQL into compressed
// files, and reads a ticket's history back from them.
//
// The order is what makes it safe (README section 15):
//   1. check the month may go     (old enough; every ticket in it is closed)
//   2. write the file             (counting rows and hashing them as it goes)
//   3. read the file back         (same count? same hash?)
//   4. record the manifest
//   5. drop the partition         (a database function re-counts under a lock)
// If anything fails before 5, the partition is untouched and the next run
// starts again. Data is never removed before its copy is verified.

type Table = "ticket_events" | "messages";
const BATCH_SIZE = 1000;

type Partition = { table: Table; name: string; rangeStart: string; rangeEnd: string };

export type ArchiveSummary = {
  archived: { partition: string; rows: number }[];
  skipped: { partition: string; reason: string }[];
};

// Monthly partitions old enough to archive. They are named <table>_YYYY_MM,
// so the month is read from the name; the default partition is never a
// candidate.
async function candidatePartitions(retentionMonths: number): Promise<Partition[]> {
  return tx(SYSTEM_PRINCIPAL, async (db) => {
    const result = await db.query<{
      table: Table;
      name: string;
      range_start: string;
      range_end: string;
    }>(
      `WITH parts AS (
         SELECT p.relname AS table, c.relname AS name,
                to_date(substring(c.relname from '(\\d{4}_\\d{2})$'), 'YYYY_MM') AS month
           FROM pg_inherits i
           JOIN pg_class c ON c.oid = i.inhrelid
           JOIN pg_class p ON p.oid = i.inhparent
          WHERE p.relname IN ('ticket_events', 'messages')
            AND c.relname ~ '_\\d{4}_\\d{2}$'
       )
       SELECT "table", name,
              (month::timestamp AT TIME ZONE 'UTC')::text AS range_start,
              ((month + interval '1 month')::timestamp AT TIME ZONE 'UTC')::text AS range_end
         FROM parts
        WHERE month + interval '1 month'
              <= date_trunc('month', now() AT TIME ZONE 'UTC') - make_interval(months => $1)
        ORDER BY month, "table"`,
      [retentionMonths],
    );
    return result.rows.map((row) => ({
      table: row.table,
      name: row.name,
      rangeStart: row.range_start,
      rangeEnd: row.range_end,
    }));
  });
}

// Step 1. A month may go only if every ticket with rows in it is closed:
// otherwise part of a live ticket's history would disappear from the API.
async function blockingReason(partition: Partition): Promise<string | null> {
  return tx(SYSTEM_PRINCIPAL, async (db) => {
    const open = await db.query(
      `SELECT 1 FROM ${partition.table} x
         JOIN tickets t ON t.id = x.ticket_id
        WHERE x.created_at >= $1 AND x.created_at < $2 AND t.status <> 'closed'
        LIMIT 1`,
      [partition.rangeStart, partition.rangeEnd],
    );
    return open.rowCount ? "has rows of tickets that are not closed" : null;
  });
}

// The partition's rows as JSON lines, read in batches through the parent
// table (the range makes PostgreSQL read only this one partition).
async function* partitionLines(partition: Partition): AsyncGenerator<string> {
  let cursor: { createdAt: string; id: string } | null = null;
  for (;;) {
    const rows = await tx(SYSTEM_PRINCIPAL, async (db) => {
      const result = await db.query<
        Record<string, unknown> & { cursor_created_at: string; id: string }
      >(
        `SELECT *, created_at::text AS cursor_created_at
           FROM ${partition.table}
          WHERE created_at >= $1 AND created_at < $2
            AND ($3::timestamptz IS NULL OR (created_at, id) > ($3::timestamptz, $4::uuid))
          ORDER BY created_at, id
          LIMIT $5`,
        [
          partition.rangeStart,
          partition.rangeEnd,
          cursor?.createdAt ?? null,
          cursor?.id ?? null,
          BATCH_SIZE,
        ],
      );
      return result.rows;
    });
    for (const row of rows) {
      const { cursor_created_at: _skip, ...data } = row;
      void _skip;
      yield `${JSON.stringify(data)}\n`;
    }
    if (rows.length < BATCH_SIZE) return;
    const last = rows[rows.length - 1]!;
    cursor = { createdAt: last.cursor_created_at, id: last.id };
  }
}

// Reads an archive file and returns its line count and hash, calling
// `onLine` for each line. Used to verify a fresh file, and by the lookup.
export async function readArchive(
  objectKey: string,
  onLine: (line: string) => void = () => {},
): Promise<{ rows: number; sha256: string }> {
  const hash = createHash("sha256");
  let rows = 0;
  const lines = createInterface({
    input: openObject(objectKey).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    hash.update(`${line}\n`);
    rows += 1;
    onLine(line);
  }
  return { rows, sha256: hash.digest("hex") };
}

export async function archivePartition(partition: Partition, dropAttempts = 20): Promise<number> {
  const objectKey = `${partition.table}/${partition.name}.ndjson.gz`;

  // Step 2: write, counting and hashing every line on the way past.
  const hash = createHash("sha256");
  let rows = 0;
  async function* counted() {
    for await (const line of partitionLines(partition)) {
      hash.update(line);
      rows += 1;
      yield line;
    }
  }
  await putObject(objectKey, Readable.from(counted()).pipe(createGzip()));
  const sha256 = hash.digest("hex");

  // Step 3: read it back. A disk or compression problem shows up here.
  const check = await readArchive(objectKey);
  if (check.rows !== rows || check.sha256 !== sha256) {
    throw new Error(`archive of ${partition.name} did not verify`);
  }

  // Steps 4 and 5. If the drop refuses (a row arrived late), the manifest
  // stays 'verified' and the next run writes a fresh file.
  await tx(SYSTEM_PRINCIPAL, async (db) => {
    await db.query(
      `INSERT INTO archive_manifests
         (table_name, partition_name, range_start, range_end, row_count, sha256, object_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (partition_name) DO UPDATE
         SET row_count = EXCLUDED.row_count, sha256 = EXCLUDED.sha256,
             object_key = EXCLUDED.object_key, created_at = now()
       WHERE archive_manifests.status = 'verified'`,
      [
        partition.table,
        partition.name,
        partition.rangeStart,
        partition.rangeEnd,
        rows,
        sha256,
        objectKey,
      ],
    );
  });
  // The drop waits at most 200 ms for its locks (see migration 014). On a
  // busy table that can fail with 55P03 "lock not available": try again a
  // moment later, a limited number of times.
  for (let attempt = 1; ; attempt++) {
    try {
      await tx(SYSTEM_PRINCIPAL, async (db) => {
        await db.query("SELECT drop_archived_partition($1, $2)", [partition.name, rows]);
      });
      return rows;
    } catch (err) {
      const busy = (err as { code?: string }).code === "55P03";
      if (!busy || attempt >= dropAttempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 100));
    }
  }
}

// The archive job.
// dropAttempts: how many times to try the final drop when the tables are too
// busy to lock (see migration 014). Giving up is safe: the next run retries.
export async function archiveOldPartitions(options: {
  retentionMonths: number;
  dropAttempts?: number;
}): Promise<ArchiveSummary> {
  const summary: ArchiveSummary = { archived: [], skipped: [] };
  for (const partition of await candidatePartitions(options.retentionMonths)) {
    const reason = await blockingReason(partition);
    if (reason) {
      summary.skipped.push({ partition: partition.name, reason });
      continue;
    }
    try {
      const rows = await archivePartition(partition, options.dropAttempts);
      summary.archived.push({ partition: partition.name, rows });
    } catch (err) {
      logger.warn({ err, partition: partition.name }, "archiving a partition failed");
      summary.skipped.push({ partition: partition.name, reason: (err as Error).message });
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Lookup: a ticket's archived timeline
// ---------------------------------------------------------------------------

export type ArchivedEvent = {
  id: string;
  ticket_id: string;
  actor_id: string | null;
  type: string;
  visibility: "public" | "internal";
  data: object;
  created_at: string;
};

export async function archivedTimeline(
  principal: Principal,
  ticketId: string,
): Promise<ArchivedEvent[]> {
  // The ticket itself is never archived, so the usual check applies: 404 if
  // it does not exist or RLS hides it, then the role check.
  const manifests = await tx(principal, async (db) => {
    const ticket = await findTicket(db, ticketId);
    requirePermission(principal, "timeline:read");
    const result = await db.query<{ object_key: string; row_count: number; sha256: string }>(
      `SELECT object_key, row_count, sha256 FROM archive_manifests
        WHERE table_name = 'ticket_events' AND status = 'dropped' AND range_end > $1
        ORDER BY range_start`,
      [ticket.created_at],
    );
    return result.rows;
  });

  // Read each file outside any transaction. Requesters get public events
  // only, the same rule RLS applies to the live table.
  const events: ArchivedEvent[] = [];
  for (const manifest of manifests) {
    const check = await readArchive(manifest.object_key, (line) => {
      const event = JSON.parse(line) as ArchivedEvent;
      if (event.ticket_id !== ticketId) return;
      if (!isStaff(principal.role) && event.visibility !== "public") return;
      events.push(event);
    });
    if (check.rows !== manifest.row_count || check.sha256 !== manifest.sha256) {
      logger.error({ objectKey: manifest.object_key }, "archive file does not match its manifest");
      throw new AppError(
        500,
        "archive_corrupt",
        "Archive corrupt",
        "An archive file failed its checksum.",
      );
    }
  }
  return events.sort((a, b) => a.created_at.localeCompare(b.created_at));
}
