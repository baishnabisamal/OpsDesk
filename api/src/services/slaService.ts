import type { PoolClient } from "pg";
import type { Priority } from "../domain/enums.js";
import { computeSla, type SlaResult } from "../domain/sla.js";

// Reads what the SLA maths needs from the database (the priority's policy,
// the region's time zone and holidays) and hands it to the pure function in
// domain/sla.ts. The maths itself has no database code in it.

export async function computeSlaFor(
  db: PoolClient,
  input: {
    regionCode: string;
    priority: Priority;
    createdAt: Date;
    checkInAt: Date;
    lcdAt: Date;
  },
): Promise<SlaResult> {
  const policyResult = await db.query<{ target_minutes: number; business_hours_only: boolean }>(
    "SELECT target_minutes, business_hours_only FROM sla_policies WHERE priority = $1",
    [input.priority],
  );
  const policy = policyResult.rows[0]!;

  const regionResult = await db.query<{ time_zone: string }>(
    "SELECT time_zone FROM regions WHERE code = $1",
    [input.regionCode],
  );

  // Only holidays that could matter: from the day before the ticket (the
  // region may be a day ahead of UTC) to 60 days later. holiday::text gives
  // "2026-12-25", which is how the calendar compares dates.
  const holidayResult = await db.query<{ day: string }>(
    `SELECT holiday::text AS day
       FROM region_holidays
      WHERE region_code = $1
        AND holiday BETWEEN ($2::timestamptz)::date - 1 AND ($2::timestamptz)::date + 60`,
    [input.regionCode, input.createdAt],
  );

  return computeSla({
    createdAt: input.createdAt,
    policy: {
      targetMinutes: policy.target_minutes,
      businessHoursOnly: policy.business_hours_only,
    },
    calendar: {
      timeZone: regionResult.rows[0]!.time_zone,
      holidays: new Set(holidayResult.rows.map((row) => row.day)),
    },
    checkInAt: input.checkInAt,
    lcdAt: input.lcdAt,
  });
}
