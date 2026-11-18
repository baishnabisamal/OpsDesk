import type { NextFunction, Request, Response } from "express";
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";
import { poolStats } from "../db/pool.js";
import { tx } from "../db/tx.js";
import { SYSTEM_PRINCIPAL } from "../domain/enums.js";
import { logger } from "./logger.js";

// Metrics for Prometheus, served at GET /metrics.
//
// Prometheus "scrapes" (fetches) this page every few seconds and stores each
// number over time; Grafana draws graphs from it. The page is plain text,
// one line per value, for example:
//   http_requests_total{method="GET",route="/api/v1/tickets/:id",status="200"} 42
//
// Three kinds of numbers:
//   Counter    only goes up (requests served). Graphs show its rate.
//   Histogram  counts values in buckets (request durations), so Prometheus
//              can work out percentiles such as p95.
//   Gauge      a value right now (outbox lag), read when the page is fetched.

export const registry = new Registry();

// Process basics: CPU, memory, event-loop delay, garbage collection.
collectDefaultMetrics({ register: registry });

// RED metrics: Rate, Errors, Duration, per route.
const requests = new Counter({
  name: "http_requests_total",
  help: "HTTP requests served, by method, route pattern and status",
  labelNames: ["method", "route", "status"],
  registers: [registry],
});

const duration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds, by method and route pattern",
  labelNames: ["method", "route"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.15, 0.25, 0.3, 0.5, 1, 2.5, 5],
  registers: [registry],
});

// The route PATTERN, not the URL. /api/v1/tickets/<uuid> becomes
// /api/v1/tickets/:id. With raw URLs every ticket id would start a new time
// series, and Prometheus memory would grow without end ("cardinality").
function routeLabel(req: Request): string {
  const pattern = req.route?.path as string | undefined;
  return pattern ? `${req.baseUrl}${pattern}` : "unmatched";
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const stop = duration.startTimer();
  res.on("finish", () => {
    const route = routeLabel(req);
    requests.inc({ method: req.method, route, status: String(res.statusCode) });
    stop({ method: req.method, route });
  });
  next();
}

// Gauges read from the database when Prometheus asks. One query for all of
// them, as the system actor. If the database is down, the values are simply
// left out of this scrape.
const outboxUnpublished = new Gauge({
  name: "outbox_unpublished_events",
  help: "Events written but not yet published to Redis",
  registers: [registry],
});
const outboxLag = new Gauge({
  name: "outbox_lag_seconds",
  help: "Age of the oldest unpublished event; if it keeps growing, realtime and email are behind",
  registers: [registry],
});
const triageDepth = new Gauge({
  name: "tickets_in_triage",
  help: "Live tickets nobody owns",
  registers: [registry],
});
const breached = new Gauge({
  name: "tickets_sla_breached",
  help: "Live tickets past their SLA deadline",
  registers: [registry],
});
const loadDrift = new Gauge({
  name: "agent_load_drift",
  help: "Agents whose stored ticket count differs from a recount; must be 0",
  registers: [registry],
});
const pool = new Gauge({
  name: "db_pool_connections",
  help: "Database pool connections by state",
  labelNames: ["state"],
  registers: [registry],
});

async function refreshGauges() {
  const stats = poolStats();
  pool.set({ state: "total" }, stats.total);
  pool.set({ state: "idle" }, stats.idle);
  pool.set({ state: "waiting" }, stats.waiting);

  try {
    const row = await tx(SYSTEM_PRINCIPAL, async (db) => {
      const result = await db.query<{
        unpublished: number;
        lag: number | null;
        triage: number;
        breached: number;
        drift: number;
      }>(
        `SELECT
           (SELECT count(*)::int FROM outbox WHERE published_at IS NULL) AS unpublished,
           (SELECT extract(epoch FROM now() - min(created_at))::float
              FROM outbox WHERE published_at IS NULL) AS lag,
           (SELECT count(*)::int FROM tickets
             WHERE assignee_id IS NULL AND status IN ('new', 'open')) AS triage,
           (SELECT count(*)::int FROM tickets
             WHERE sla_state = 'breached' AND status IN ('new', 'open', 'pending', 'escalated')) AS breached,
           (SELECT count(*)::int FROM (
              SELECT p.user_id FROM agent_presence p
                LEFT JOIN tickets t
                  ON t.assignee_id = p.user_id AND t.status IN ('open', 'pending', 'escalated')
               GROUP BY p.user_id, p.open_count
              HAVING p.open_count <> count(t.id)) d) AS drift`,
      );
      return result.rows[0]!;
    });
    outboxUnpublished.set(row.unpublished);
    outboxLag.set(row.lag ?? 0);
    triageDepth.set(row.triage);
    breached.set(row.breached);
    loadDrift.set(row.drift);
  } catch (err) {
    logger.warn({ err }, "could not refresh database gauges");
  }
}

export async function renderMetrics(): Promise<{ contentType: string; body: string }> {
  await refreshGauges();
  return { contentType: registry.contentType, body: await registry.metrics() };
}
