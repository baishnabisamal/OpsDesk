import { requirePermission } from "../core/auth.js";
import { notFound } from "../core/errors.js";
import * as ml from "../core/mlClient.js";
import { tx } from "../db/tx.js";
import { SYSTEM_PRINCIPAL, type Principal } from "../domain/enums.js";

// Weekly themes: what were tickets about this week?
//
// Two views, both precomputed into theme_weekly by a nightly job:
//   intents   how many tickets per intent, with a few example tickets
//   clusters  groups of tickets with similar words, found by the ML service
//
// A week runs from Monday 00:00 UTC (included) to the next Monday (excluded):
// a half-open range, so a ticket at exactly midnight belongs to one week only.

const SAMPLES = 5;
const MAX_TEXTS_TO_CLUSTER = 2000;

type IntentCount = { intent: string; count: number; sample_ticket_ids: string[] };
type ClusterSummary = { label: string; terms: string[]; size: number; sample_ticket_ids: string[] };

export type WeeklyThemes = {
  week_start: string;
  ticket_count: number;
  intents: IntentCount[];
  clusters: ClusterSummary[] | null;
  computed_at: Date;
};

// Computes and stores one week. `weekStart` must be a Monday ("2026-11-16").
export async function rollupWeek(weekStart: string): Promise<WeeklyThemes> {
  // 1. Read the week's numbers and texts (a short read-only transaction).
  const { intents, texts } = await tx(SYSTEM_PRINCIPAL, async (db) => {
    const counts = await db.query<IntentCount>(
      `SELECT intent,
              count(*)::int AS count,
              (array_agg(id ORDER BY created_at DESC))[1:$2] AS sample_ticket_ids
         FROM tickets
        WHERE created_at >= $1::date AND created_at < $1::date + 7
        GROUP BY intent
        ORDER BY count DESC, intent`,
      [weekStart, SAMPLES],
    );
    const sample = await db.query<{ id: string; text: string }>(
      `SELECT id, subject || E'\\n' || body AS text
         FROM tickets
        WHERE created_at >= $1::date AND created_at < $1::date + 7
        ORDER BY created_at DESC
        LIMIT $2`,
      [weekStart, MAX_TEXTS_TO_CLUSTER],
    );
    return { intents: counts.rows, texts: sample.rows };
  });

  // 2. Cluster, with NO transaction open (architecture rule 4). If the ML
  //    service is down, the week is stored without clusters.
  const clusters = texts.length === 0 ? [] : await ml.clusterThemes(texts);

  const ticketCount = intents.reduce((sum, row) => sum + row.count, 0);
  const clusterSummaries =
    clusters?.map((cluster) => ({
      label: cluster.label,
      terms: cluster.terms,
      size: cluster.size,
      sample_ticket_ids: cluster.ticket_ids.slice(0, SAMPLES),
    })) ?? null;

  // 3. Store it, replacing any earlier answer for the same week.
  return tx(SYSTEM_PRINCIPAL, async (db) => {
    const saved = await db.query<WeeklyThemes>(
      `INSERT INTO theme_weekly (week_start, ticket_count, intents, clusters)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (week_start) DO UPDATE
         SET ticket_count = EXCLUDED.ticket_count,
             intents = EXCLUDED.intents,
             clusters = EXCLUDED.clusters,
             computed_at = now()
       RETURNING week_start::text, ticket_count, intents, clusters, computed_at`,
      [
        weekStart,
        ticketCount,
        JSON.stringify(intents),
        clusterSummaries === null ? null : JSON.stringify(clusterSummaries),
      ],
    );
    return saved.rows[0]!;
  });
}

// The nightly job: this week so far, and last week (tickets created late on
// Sunday are only counted once that day is over).
export async function rollupRecentWeeks(): Promise<{ weeks: string[] }> {
  const weeks = await tx(SYSTEM_PRINCIPAL, async (db) => {
    const result = await db.query<{ week: string }>(
      `SELECT (date_trunc('week', now() AT TIME ZONE 'UTC') - interval '7 days')::date::text AS week
       UNION ALL
       SELECT date_trunc('week', now() AT TIME ZONE 'UTC')::date::text`,
    );
    return result.rows.map((row) => row.week);
  });
  for (const week of weeks) await rollupWeek(week);
  return { weeks };
}

export async function getThemes(principal: Principal, weekStart: string): Promise<WeeklyThemes> {
  requirePermission(principal, "insights:read");
  return tx(principal, async (db) => {
    const result = await db.query<WeeklyThemes>(
      `SELECT week_start::text, ticket_count, intents, clusters, computed_at
         FROM theme_weekly WHERE week_start = $1`,
      [weekStart],
    );
    const row = result.rows[0];
    if (!row) throw notFound("No themes have been computed for this week yet.");
    return row;
  });
}
