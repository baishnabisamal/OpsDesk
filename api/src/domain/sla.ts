import { DateTime } from "luxon";
import type { Priority } from "./enums.js";

// SLA maths. Pure functions: dates in, dates out, no database.
//
// An SLA (service level agreement) deadline is "this ticket must be handled
// by then". OpsDesk works it out from two things:
//   1. the priority: urgent tickets get less time than low ones, counted in
//      BUSINESS time (office hours, working days, not holidays) of the region
//   2. the booking: the deadline may never be later than the traveller's own
//      deadline (free-cancellation cut-off or check-in) minus a safety buffer
//
// All the time zone work is done by luxon. A DateTime knows its zone, so
// "9 o'clock tomorrow in Dubai" is one call and daylight-saving changes are
// handled for us.

// Office hours, in the region's local time. Monday to Friday.
export const BUSINESS_START_HOUR = 9;
export const BUSINESS_END_HOUR = 18;

// The deadline is at least this long before the travel deadline...
export const TRAVEL_BUFFER_MINUTES = 60;
// ...but a ticket always gets at least this long, however close the trip is.
export const MIN_RESPONSE_MINUTES = 15;
// A ticket is "at risk" for the last fifth of its time.
export const AT_RISK_FRACTION = 0.2;

export type SlaPolicy = {
  targetMinutes: number;
  // false = the clock runs day and night (used for urgent tickets).
  businessHoursOnly: boolean;
};

export type BusinessCalendar = {
  timeZone: string; // IANA name, for example "Europe/Berlin"
  holidays: ReadonlySet<string>; // local dates, "2026-12-25"
};

// ---------------------------------------------------------------------------
// Business time
// ---------------------------------------------------------------------------

function isWorkingDay(day: DateTime, calendar: BusinessCalendar): boolean {
  const isWeekend = day.weekday === 6 || day.weekday === 7; // Saturday, Sunday
  return !isWeekend && !calendar.holidays.has(day.toISODate()!);
}

function startOfBusiness(day: DateTime): DateTime {
  return day.set({ hour: BUSINESS_START_HOUR, minute: 0, second: 0, millisecond: 0 });
}

function endOfBusiness(day: DateTime): DateTime {
  return day.set({ hour: BUSINESS_END_HOUR, minute: 0, second: 0, millisecond: 0 });
}

// Adds `minutes` of business time to `start`.
//
// Think of a cursor walking forward through the calendar. Time only counts
// while the cursor is inside office hours on a working day. Outside them the
// cursor jumps to the next opening time without using up any minutes.
export function addBusinessMinutes(start: Date, minutes: number, calendar: BusinessCalendar): Date {
  let cursor: DateTime = DateTime.fromJSDate(start, { zone: calendar.timeZone });
  let remaining = minutes;

  // Each loop either finishes or moves to a later day, so it always ends.
  for (;;) {
    const opens = startOfBusiness(cursor);
    const closes = endOfBusiness(cursor);

    if (!isWorkingDay(cursor, calendar) || cursor >= closes) {
      // Closed for the rest of today: jump to tomorrow's opening time.
      cursor = startOfBusiness(cursor.plus({ days: 1 }));
      continue;
    }
    if (cursor < opens) {
      cursor = opens; // early morning: wait for the office to open
    }

    const minutesLeftToday = closes.diff(cursor, "minutes").minutes;
    if (remaining <= minutesLeftToday) {
      return cursor.plus({ minutes: remaining }).toJSDate();
    }
    // Use up today and carry the rest over to the next day.
    remaining -= minutesLeftToday;
    cursor = startOfBusiness(cursor.plus({ days: 1 }));
  }
}

// ---------------------------------------------------------------------------
// The deadline
// ---------------------------------------------------------------------------

export type SlaInput = {
  createdAt: Date;
  policy: SlaPolicy;
  calendar: BusinessCalendar;
  checkInAt: Date;
  lcdAt: Date;
};

export type SlaResult = {
  dueAt: Date;
  atRiskAt: Date; // from this moment the ticket counts as "at risk"
  // Which rule set the deadline: the priority's policy, the booking's own
  // deadline, or the minimum response time.
  basis: "policy" | "travel_deadline" | "minimum";
};

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

// The next moment after which the booking can no longer be fixed cheaply:
// the free-cancellation cut-off if it is still ahead, otherwise check-in.
// Null when both are already in the past, because then nothing is left to protect.
export function travelDeadline(createdAt: Date, checkInAt: Date, lcdAt: Date): Date | null {
  const upcoming = [lcdAt, checkInAt].filter((date) => date > createdAt);
  if (upcoming.length === 0) return null;
  return upcoming.reduce((earliest, date) => (date < earliest ? date : earliest));
}

export function computeSla(input: SlaInput): SlaResult {
  const { createdAt, policy, calendar } = input;

  // 1. The deadline from the priority alone.
  let dueAt = policy.businessHoursOnly
    ? addBusinessMinutes(createdAt, policy.targetMinutes, calendar)
    : addMinutes(createdAt, policy.targetMinutes);
  let basis: SlaResult["basis"] = "policy";

  // 2. Never later than the travel deadline minus the buffer.
  const deadline = travelDeadline(createdAt, input.checkInAt, input.lcdAt);
  if (deadline) {
    const latestAllowed = addMinutes(deadline, -TRAVEL_BUFFER_MINUTES);
    if (latestAllowed < dueAt) {
      dueAt = latestAllowed;
      basis = "travel_deadline";
    }
  }

  // 3. But never sooner than the minimum response time.
  const earliestAllowed = addMinutes(createdAt, MIN_RESPONSE_MINUTES);
  if (dueAt < earliestAllowed) {
    dueAt = earliestAllowed;
    basis = "minimum";
  }

  const totalMs = dueAt.getTime() - createdAt.getTime();
  const atRiskAt = new Date(dueAt.getTime() - totalMs * AT_RISK_FRACTION);
  return { dueAt, atRiskAt, basis };
}

// ---------------------------------------------------------------------------
// The state
// ---------------------------------------------------------------------------

export const SLA_STATES = ["on_track", "at_risk", "breached"] as const;
export type SlaState = (typeof SLA_STATES)[number];

export function slaState(now: Date, atRiskAt: Date, dueAt: Date): SlaState {
  if (now >= dueAt) return "breached";
  if (now >= atRiskAt) return "at_risk";
  return "on_track";
}

// States only ever get worse while the clock runs: the scanner must not turn
// a breached ticket back to at-risk.
export function isWorse(next: SlaState, current: SlaState): boolean {
  return SLA_STATES.indexOf(next) > SLA_STATES.indexOf(current);
}

// The priorities, so the policy table in the database can be checked against it.
export type PolicyTable = Record<Priority, SlaPolicy>;
