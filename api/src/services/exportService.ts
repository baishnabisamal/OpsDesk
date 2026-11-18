import { requirePermission } from "../core/auth.js";
import { tx } from "../db/tx.js";
import { csvRow } from "../domain/csv.js";
import type { Principal } from "../domain/enums.js";

// Streaming CSV export of tickets, with no row cap.
//
// The naive version (SELECT everything, build one big string, send it) needs
// memory in proportion to the number of rows: 100,000 tickets would sit in
// memory as objects AND as text at the same time.
//
// This version is an async generator: it produces the CSV one line at a time,
// and reads the next batch of 1,000 rows only when the previous one has been
// handed on. The route pipes it into the HTTP response, and Node's streams
// pull from it only as fast as the client downloads (backpressure). So memory
// holds about one batch, whatever the size of the export.
//
// Batches use keyset paging on (created_at, id), the same idea as the ticket
// list, and each batch is its own short transaction. A long export therefore
// never holds a lock or a connection for minutes. The cost: tickets created
// while an export is running may or may not be included, depending on when
// their batch is read. For a report that is acceptable.

const BATCH_SIZE = 1000;

export const EXPORT_COLUMNS = [
  "id",
  "created_at",
  "agency_id",
  "tboh",
  "subject",
  "intent",
  "priority",
  "status",
  "region_code",
  "assignee_id",
  "sla_due_at",
  "sla_state",
  "resolved_at",
  "closed_at",
] as const;

export type ExportFilters = {
  status?: string;
  region?: string;
  agency_id?: string;
  from?: string; // date, included
  to?: string; // date, excluded (half-open)
};

type ExportRow = Record<(typeof EXPORT_COLUMNS)[number], unknown> & { cursor_created_at: string };

export async function* exportTicketsCsv(
  principal: Principal,
  filters: ExportFilters,
): AsyncGenerator<string> {
  requirePermission(principal, "export:run");

  yield csvRow([...EXPORT_COLUMNS]);

  let cursor: { createdAt: string; id: string } | null = null;
  for (;;) {
    const batch: ExportRow[] = await tx(principal, async (db) => {
      const result = await db.query<ExportRow>(
        `SELECT t.id, t.created_at, t.agency_id, b.tboh, t.subject, t.intent, t.priority,
                t.status, t.region_code, t.assignee_id, t.sla_due_at, t.sla_state,
                t.resolved_at, t.closed_at, t.created_at::text AS cursor_created_at
           FROM tickets t
           JOIN bookings b ON b.id = t.booking_id
          WHERE ($1::text IS NULL OR t.status = $1)
            AND ($2::text IS NULL OR t.region_code = $2)
            AND ($3::uuid IS NULL OR t.agency_id = $3)
            AND ($4::date IS NULL OR t.created_at >= $4::date)
            AND ($5::date IS NULL OR t.created_at < $5::date)
            AND ($6::timestamptz IS NULL OR (t.created_at, t.id) > ($6::timestamptz, $7::uuid))
          ORDER BY t.created_at, t.id
          LIMIT $8`,
        [
          filters.status ?? null,
          filters.region ?? null,
          filters.agency_id ?? null,
          filters.from ?? null,
          filters.to ?? null,
          cursor?.createdAt ?? null,
          cursor?.id ?? null,
          BATCH_SIZE,
        ],
      );
      return result.rows;
    });

    for (const row of batch) {
      yield csvRow(EXPORT_COLUMNS.map((column) => row[column]));
    }
    if (batch.length < BATCH_SIZE) return; // that was the last batch

    const last = batch[batch.length - 1]!;
    cursor = { createdAt: last.cursor_created_at, id: String(last.id) };
  }
}
