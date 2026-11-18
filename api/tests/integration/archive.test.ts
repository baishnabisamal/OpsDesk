import { createWriteStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { config } from "../../src/core/config.js";
import { objectExists } from "../../src/core/objectStore.js";
import { archiveOldPartitions, readArchive } from "../../src/services/archiveService.js";
import {
  bearer,
  closeTestPools,
  createAgencyWithRequester,
  createUser,
  ownerPool,
  type TestUser,
} from "./helpers.js";

// History from 2019 lives in partitions this file creates itself. No other
// test file uses 2019, and only this file runs the archive job.

const app = createApp();

let agent: TestUser;
let requester: TestUser;
let otherRequester: TestUser;
let closedTicket: string;
let openTicket: string;

async function makePartition(table: string, month: string) {
  const [year, mm] = month.split("-");
  const next =
    mm === "12" ? `${Number(year) + 1}-01` : `${year}-${String(Number(mm) + 1).padStart(2, "0")}`;
  // Creating a partition locks the parent AND the tables its foreign keys
  // point at. Done plainly, it deadlocked with other test files' requests
  // (and PostgreSQL killed THEIR request). So, like the app's own partition
  // function (migration 012): take every lock first, wait at most 200 ms,
  // and retry if busy.
  for (let attempt = 1; ; attempt++) {
    const client = await ownerPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '200ms'");
      await client.query("LOCK TABLE tickets, users IN SHARE ROW EXCLUSIVE MODE");
      await client.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
      await client.query(
        `CREATE TABLE ${table}_${year}_${mm} PARTITION OF ${table}
           FOR VALUES FROM ('${month}-01 00:00:00+00') TO ('${next}-01 00:00:00+00')`,
      );
      await client.query("COMMIT");
      return;
    } catch (err) {
      await client.query("ROLLBACK");
      if ((err as { code?: string }).code !== "55P03" || attempt === 200) throw err;
      await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 50));
    } finally {
      client.release();
    }
  }
}

async function oldTicket(status: "closed" | "open"): Promise<{ id: string; requester: TestUser }> {
  const { requester: owner, booking } = await createAgencyWithRequester();
  await ownerPool.query(
    `INSERT INTO cases (booking_id, agency_id, status, closed_at)
     SELECT id, agency_id, $2, CASE WHEN $2 = 'closed' THEN now() END FROM bookings WHERE id = $1`,
    [booking.id, status],
  );
  const closed = status === "closed";
  const result = await ownerPool.query<{ id: string }>(
    `INSERT INTO tickets (agency_id, booking_id, case_id, requester_id, subject, body, intent_source,
                          check_in_at, lcd_at, region_code, sla_due_at, sla_at_risk_at, status,
                          resolved_at, closed_at, created_at)
     SELECT b.agency_id, b.id, c.id, $2, 'Old ticket', 'From 2019.', 'manual', now(), now(), 'EU',
            '2019-01-06', '2019-01-05', $3, $4, $4, '2019-01-05 10:00:00+00'
       FROM bookings b JOIN cases c ON c.booking_id = b.id WHERE b.id = $1
     RETURNING id`,
    [booking.id, owner.id, status, closed ? "2019-01-20 00:00:00+00" : null],
  );
  return { id: result.rows[0]!.id, requester: owner };
}

async function event(ticketId: string, visibility: string, at: string, type = "status_changed") {
  await ownerPool.query(
    `INSERT INTO ticket_events (ticket_id, agency_id, type, visibility, data, created_at)
     SELECT id, agency_id, $2, $3, '{"note":"old"}', $4 FROM tickets WHERE id = $1`,
    [ticketId, type, visibility, at],
  );
}

const partitionExists = async (name: string) =>
  (await ownerPool.query<{ t: string | null }>("SELECT to_regclass($1)::text AS t", [name]))
    .rows[0]!.t !== null;

beforeAll(async () => {
  agent = await createUser("agent");

  for (const table of ["ticket_events", "messages"]) {
    await makePartition(table, "2019-01");
    await makePartition(table, "2019-02");
    await makePartition(table, "2019-03");
  }

  // January: one closed ticket with three events (one of them internal).
  const closed = await oldTicket("closed");
  closedTicket = closed.id;
  requester = closed.requester;
  await event(closedTicket, "public", "2019-01-05 10:00:00+00", "ticket_created");
  await event(closedTicket, "internal", "2019-01-06 11:00:00+00", "message_added");
  await event(closedTicket, "public", "2019-01-20 00:00:00+00");

  // February: an event of a ticket that is still open. It must stay.
  const open = await oldTicket("open");
  openTicket = open.id;
  await event(openTicket, "public", "2019-02-10 09:00:00+00");

  ({ requester: otherRequester } = await createAgencyWithRequester());
});

afterAll(closeTestPools);

describe("archiving old partitions", () => {
  // The whole test suite runs in parallel and writes to `tickets` nonstop, so
  // the drop's locks are hard to get here. The tests allow many more tries
  // than the nightly job (20); the behaviour checked is the same.
  const options = { retentionMonths: 12, dropAttempts: 200 };

  it(
    "archives months whose tickets are all closed, and leaves the others",
    { timeout: 120_000 },
    async () => {
      const summary = await archiveOldPartitions(options);

      expect(summary.archived).toEqual(
        expect.arrayContaining([
          { partition: "ticket_events_2019_01", rows: 3 },
          { partition: "messages_2019_01", rows: 0 },
          { partition: "ticket_events_2019_03", rows: 0 },
        ]),
      );
      expect(summary.skipped).toContainEqual({
        partition: "ticket_events_2019_02",
        reason: "has rows of tickets that are not closed",
      });

      expect(await partitionExists("ticket_events_2019_01")).toBe(false);
      expect(await partitionExists("ticket_events_2019_02")).toBe(true); // still live
    },
  );

  it("records a manifest with the row count and checksum, and the file matches it", async () => {
    const manifest = await ownerPool.query<{
      row_count: number;
      sha256: string;
      object_key: string;
      status: string;
    }>(
      "SELECT row_count, sha256, object_key, status FROM archive_manifests WHERE partition_name = 'ticket_events_2019_01'",
    );
    const row = manifest.rows[0]!;
    expect(row).toMatchObject({ row_count: 3, status: "dropped" });
    expect(await objectExists(row.object_key)).toBe(true);

    const check = await readArchive(row.object_key);
    expect(check).toEqual({ rows: 3, sha256: row.sha256 });
  });

  it("running it again archives nothing new (idempotent)", async () => {
    const summary = await archiveOldPartitions(options);
    expect(summary.archived).toEqual([]);
  });

  it("never touches recent months or the default partition", async () => {
    const summary = await archiveOldPartitions(options);
    const names = [...summary.archived, ...summary.skipped].map((entry) => entry.partition);
    expect(names.every((name) => name.includes("2019"))).toBe(true);
    expect(await partitionExists("ticket_events_default")).toBe(true);
  });

  it(
    "the drop function refuses when the row count does not match its archive",
    { timeout: 120_000 },
    async () => {
      // A verified archive that claims 5 rows, for a partition that has 1.
      await ownerPool.query(
        `INSERT INTO archive_manifests (table_name, partition_name, range_start, range_end, row_count, sha256, object_key)
       VALUES ('ticket_events', 'ticket_events_2019_02', '2019-02-01', '2019-03-01', 5, $1, 'x')`,
        ["0".repeat(64)],
      );
      // Called directly, so retry here when the locks are busy (lock timeout).
      let message = "";
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          await ownerPool.query("SELECT drop_archived_partition('ticket_events_2019_02', 5)");
          message = "it did not refuse";
          break;
        } catch (err) {
          message = (err as Error).message;
          if (!message.includes("lock timeout")) break;
        }
      }
      expect(message).toMatch(/has 1 rows, the archive has 5/);
      expect(await partitionExists("ticket_events_2019_02")).toBe(true);
    },
  );

  it("the drop function refuses a table that is not a monthly partition", async () => {
    await expect(ownerPool.query("SELECT drop_archived_partition('tickets', 0)")).rejects.toThrow(
      /not an archivable partition/,
    );
    await expect(
      ownerPool.query("SELECT drop_archived_partition('ticket_events_default', 0)"),
    ).rejects.toThrow(/not an archivable partition/);
  });
});

// Phase 5 gate: an archived ticket can be looked up.
describe("GET /tickets/:id/archived-timeline", () => {
  it("staff read the archived history back from the file", async () => {
    const res = await request(app)
      .get(`/api/v1/tickets/${closedTicket}/archived-timeline`)
      .set(bearer(agent));
    expect(res.status).toBe(200);
    expect(res.body.items.map((e: { type: string }) => e.type)).toEqual([
      "ticket_created",
      "message_added",
      "status_changed",
    ]);
    // The live timeline no longer has these rows: they really left the database.
    const live = await request(app)
      .get(`/api/v1/tickets/${closedTicket}/timeline`)
      .set(bearer(agent));
    expect(live.body.items).toEqual([]);
  });

  it("the requester sees only the public archived events", async () => {
    const res = await request(app)
      .get(`/api/v1/tickets/${closedTicket}/archived-timeline`)
      .set(bearer(requester));
    expect(res.status).toBe(200);
    expect(res.body.items.map((e: { visibility: string }) => e.visibility)).toEqual([
      "public",
      "public",
    ]);
  });

  it("another agency gets 404", async () => {
    const res = await request(app)
      .get(`/api/v1/tickets/${closedTicket}/archived-timeline`)
      .set(bearer(otherRequester));
    expect(res.status).toBe(404);
  });

  it("a damaged archive file is reported, not silently read", async () => {
    const manifest = await ownerPool.query<{ object_key: string }>(
      "SELECT object_key FROM archive_manifests WHERE partition_name = 'ticket_events_2019_01'",
    );
    const file = path.resolve(config.archiveDir, manifest.rows[0]!.object_key);
    const original = await (await import("node:fs/promises")).readFile(file);
    try {
      // Replace it with a valid gzip file holding different content.
      await pipeline(Readable.from(['{"ticket_id":"x"}\n']), createGzip(), createWriteStream(file));
      const res = await request(app)
        .get(`/api/v1/tickets/${closedTicket}/archived-timeline`)
        .set(bearer(agent));
      expect(res.status).toBe(500);
      expect(res.body.code).toBe("archive_corrupt");
    } finally {
      await (await import("node:fs/promises")).writeFile(file, original);
    }
  });

  it("a ticket with nothing archived has an empty archived timeline", async () => {
    const res = await request(app)
      .get(`/api/v1/tickets/${openTicket}/archived-timeline`)
      .set(bearer(agent));
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });
});
