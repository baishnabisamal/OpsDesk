// The closed sets of values used across the app. The same values are
// repeated as CHECK constraints in the database (migration 001).

export const ROLES = ["requester", "agent", "escalation_manager", "lead"] as const;
export type Role = (typeof ROLES)[number];

// An actor is a person's role, or "system" for background jobs.
export type Actor = Role | "system";

export const STAFF_ROLES: readonly Role[] = ["agent", "escalation_manager", "lead"];

export function isStaff(role: Actor): boolean {
  return role !== "requester" && role !== "system";
}

export const TICKET_STATUSES = [
  "new",
  "open",
  "pending",
  "escalated",
  "resolved",
  "closed",
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const INTENTS = [
  "booking_not_found",
  "cancellation",
  "amendment",
  "refund",
  "voucher",
  "payment",
  "other",
] as const;
export type Intent = (typeof INTENTS)[number];

export const VISIBILITIES = ["public", "internal"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

// Who is making a request. Built from the access token by the auth middleware
// and passed to tx(), which gives it to PostgreSQL for Row-Level Security.
export type Principal = {
  userId: string | null; // null only for the system actor
  role: Actor;
  agencyId: string | null; // set only for requesters
  teamId: string | null;
};

export const SYSTEM_PRINCIPAL: Principal = {
  userId: null,
  role: "system",
  agencyId: null,
  teamId: null,
};
