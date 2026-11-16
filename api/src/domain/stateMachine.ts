import type { Actor, TicketStatus } from "./enums.js";

// The whole status policy in one table: from -> to -> who may do it.
// Anything not listed here is illegal. (README section 11.)

const STAFF: Actor[] = ["agent", "escalation_manager", "lead"];
const SENIOR: Actor[] = ["escalation_manager", "lead"];
const ANYONE: Actor[] = ["requester", ...STAFF];

const TRANSITIONS: Record<TicketStatus, Partial<Record<TicketStatus, Actor[]>>> = {
  new: {
    open: [...STAFF, "system"],
  },
  open: {
    pending: STAFF,
    escalated: [...STAFF, "system"],
    resolved: STAFF,
  },
  pending: {
    open: ANYONE,
    escalated: [...STAFF, "system"],
    resolved: STAFF,
  },
  escalated: {
    open: SENIOR,
    resolved: SENIOR,
  },
  resolved: {
    open: ANYONE,
    closed: [...ANYONE, "system"],
  },
  closed: {},
};

export function canTransition(from: TicketStatus, to: TicketStatus, actor: Actor): boolean {
  const allowed = TRANSITIONS[from][to];
  return allowed !== undefined && allowed.includes(actor);
}

// The timestamp columns that must change together with the status.
// `undefined` means "leave the column as it is".
export type TransitionEffects = {
  resolvedAt: "set" | "clear" | undefined;
  closedAt: "set" | undefined;
};

export function transitionEffects(from: TicketStatus, to: TicketStatus): TransitionEffects {
  return {
    // Entering resolved stamps the time; reopening removes it.
    resolvedAt:
      to === "resolved" ? "set" : from === "resolved" && to === "open" ? "clear" : undefined,
    closedAt: to === "closed" ? "set" : undefined,
  };
}
