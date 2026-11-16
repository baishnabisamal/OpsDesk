import { DateTime } from "luxon";
import type { Intent, Priority } from "./enums.js";

// Routing: which agent should get this ticket? Pure functions, no database.
//
// Two stages, always in this order:
//   1. FILTER: remove agents who cannot take the ticket at all
//      (offline, off shift, already at their limit)
//   2. RANK: give each remaining agent a score and sort, best first
//
// Every step records a reason in plain words, so the decision can be stored
// and shown later: "why did Meera get this ticket?"

export type Shift = {
  weekday: number; // 1 = Monday ... 7 = Sunday, in the region's local time
  startMinute: number; // minutes after midnight, 540 = 09:00
  endMinute: number; // exclusive, 1080 = 18:00
};

export type AgentSnapshot = {
  userId: string;
  name: string;
  isOnline: boolean;
  openCount: number; // tickets they are working on now
  maxOpen: number; // their limit
  skills: Intent[];
  shifts: Shift[];
};

export type TicketToRoute = { intent: Intent; priority: Priority };

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

// Shifts are stored in local time, so "now" is converted to the region's
// clock first. An agent in Dubai on a 09:00 to 18:00 shift is on shift at
// 06:00 UTC, and that must not depend on where the server runs.
export function isOnShift(shifts: Shift[], now: Date, timeZone: string): boolean {
  const local = DateTime.fromJSDate(now, { zone: timeZone });
  const minuteOfDay = local.hour * 60 + local.minute;
  return shifts.some(
    (shift) =>
      shift.weekday === local.weekday &&
      minuteOfDay >= shift.startMinute &&
      minuteOfDay < shift.endMinute, // half-open: the end minute is not included
  );
}

// ---------------------------------------------------------------------------
// Stage 1: filter
// ---------------------------------------------------------------------------

export type Rejection = { userId: string; name: string; reason: string };

export function filterAgents(agents: AgentSnapshot[], now: Date, timeZone: string) {
  const eligible: AgentSnapshot[] = [];
  const rejected: Rejection[] = [];

  for (const agent of agents) {
    let reason: string | null = null;
    if (!agent.isOnline) reason = "offline";
    else if (!isOnShift(agent.shifts, now, timeZone)) reason = "off shift";
    else if (agent.openCount >= agent.maxOpen)
      reason = `at limit (${agent.openCount}/${agent.maxOpen})`;

    if (reason) rejected.push({ userId: agent.userId, name: agent.name, reason });
    else eligible.push(agent);
  }
  return { eligible, rejected };
}

// ---------------------------------------------------------------------------
// Stage 2: rank
// ---------------------------------------------------------------------------

export const SKILL_POINTS = 40;
export const LOAD_POINTS = 40;

// For pressing tickets, free capacity matters more than skill: it is better
// that someone starts now than that the specialist starts in an hour.
const LOAD_WEIGHT: Record<Priority, number> = { low: 1, normal: 1, high: 1.5, urgent: 2 };

export type ScoredAgent = { userId: string; name: string; score: number; reasons: string[] };

export function scoreAgent(agent: AgentSnapshot, ticket: TicketToRoute): ScoredAgent {
  const reasons: string[] = [];
  let score = 0;

  if (agent.skills.includes(ticket.intent)) {
    score += SKILL_POINTS;
    reasons.push(`has the ${ticket.intent} skill (+${SKILL_POINTS})`);
  }

  // 1 when the agent has nothing open, 0 when they are full.
  const freeShare = (agent.maxOpen - agent.openCount) / agent.maxOpen;
  const loadPoints = Math.round(freeShare * LOAD_POINTS * LOAD_WEIGHT[ticket.priority]);
  score += loadPoints;
  reasons.push(`${agent.openCount} of ${agent.maxOpen} open (+${loadPoints})`);

  return { userId: agent.userId, name: agent.name, score, reasons };
}

// Best first. Equal scores are ordered by user id so the result is the same
// every time for the same input (no coin flips in routing).
export function rankAgents(agents: AgentSnapshot[], ticket: TicketToRoute): ScoredAgent[] {
  return agents
    .map((agent) => scoreAgent(agent, ticket))
    .sort((a, b) => b.score - a.score || a.userId.localeCompare(b.userId));
}

// Both stages together.
export function planRouting(
  agents: AgentSnapshot[],
  ticket: TicketToRoute,
  now: Date,
  timeZone: string,
): { ranked: ScoredAgent[]; rejected: Rejection[] } {
  const { eligible, rejected } = filterAgents(agents, now, timeZone);
  return { ranked: rankAgents(eligible, ticket), rejected };
}
