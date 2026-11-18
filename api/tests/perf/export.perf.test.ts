import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import {
  closeTestPools,
  createAgencyWithRequester,
  createUser,
  ownerPool,
  type TestAgency,
  type TestUser,
} from "../integration/helpers.js";

// Phase 5 gate: 100,000 rows export in under 30 s with flat memory, MEASURED.
//
// The rows are inserted straight into the database (generate_series), all
// closed, so they never appear in a queue. The export then runs through a
// real HTTP server, and the client reads the body piece by piece without
// keeping it, while the server process's memory is sampled every 50 ms.

const ROWS = 100_000;

let server: Server;
let url: string;
let agency: TestAgency;
let lead: TestUser;

beforeAll(async () => {
  const setup = await createAgencyWithRequester();
  agency = setup.agency;
  lead = await createUser("lead");

  await ownerPool.query(
    `INSERT INTO cases (booking_id, agency_id, status, closed_at)
     SELECT id, agency_id, 'closed', now() FROM bookings WHERE id = $1`,
    [setup.booking.id],
  );
  const started = Date.now();
  await ownerPool.query(
    `INSERT INTO tickets (agency_id, booking_id, case_id, requester_id, subject, body, intent,
                          intent_source, check_in_at, lcd_at, region_code, sla_due_at,
                          sla_at_risk_at, status, resolved_at, closed_at, created_at)
     SELECT $1, $2, c.id, $3,
            'Export ticket ' || n, 'Body of export ticket number ' || n, 'refund', 'manual',
            now(), now(), 'EU', now(), now(), 'closed', now(), now(),
            now() - make_interval(secs => n)
       FROM generate_series(1, $4) AS n,
            (SELECT id FROM cases WHERE booking_id = $2) AS c`,
    [agency.id, setup.booking.id, setup.requester.id, ROWS],
  );
  console.log(`inserted ${ROWS} tickets in ${Date.now() - started} ms`);

  server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await closeTestPools();
});

const MB = 1024 * 1024;

describe("streaming export, 100,000 rows", () => {
  it("finishes in under 30 s and memory stays flat", async () => {
    // heapUsed also counts garbage that V8 has not collected yet, which says
    // nothing about the design. So every sample forces a collection first
    // (the perf project runs with --expose-gc) and records what is LIVE.
    const gc = global.gc;
    if (!gc) throw new Error("run with --expose-gc (make test-perf does)");
    gc();
    const baseline = process.memoryUsage();
    let peakHeap = baseline.heapUsed;
    let peakRss = baseline.rss;
    const sampler = setInterval(() => {
      gc();
      const now = process.memoryUsage();
      peakHeap = Math.max(peakHeap, now.heapUsed);
      peakRss = Math.max(peakRss, now.rss);
    }, 50);

    const started = Date.now();
    const res = await fetch(`${url}/api/v1/exports/tickets.csv?agency_id=${agency.id}`, {
      headers: { Authorization: `Bearer ${lead.token}` },
    });
    expect(res.status).toBe(200);

    // Read the body chunk by chunk, counting lines, keeping nothing.
    let lines = 0;
    let bytes = 0;
    const reader = res.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      for (const byte of value) if (byte === 10) lines += 1; // "\n"
    }
    const elapsed = Date.now() - started;
    clearInterval(sampler);

    const heapGrowth = (peakHeap - baseline.heapUsed) / MB;
    const rssGrowth = (peakRss - baseline.rss) / MB;
    const fileSize = bytes / MB;
    console.log(
      `export: ${lines - 1} rows, ${fileSize.toFixed(1)} MB in ${elapsed} ms; ` +
        `live heap grew at most ${heapGrowth.toFixed(1)} MB, RSS at most ${rssGrowth.toFixed(1)} MB`,
    );

    expect(lines - 1).toBe(ROWS); // minus the header line
    expect(elapsed).toBeLessThan(30_000);
    // "Flat": memory growth is a small fraction of the file size. Building the
    // whole file in memory would need at least the file size (and in practice
    // several times it, as row objects plus text).
    expect(heapGrowth).toBeLessThan(fileSize / 2);
  });
});
