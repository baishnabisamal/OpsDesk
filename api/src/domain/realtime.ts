// Who may receive which live event. Pure, no I/O.
//
// The gateway pushes every event to the staff room. It also pushes an event
// to the agency's own room, but only when the agency may see it. The rule is
// an allow-list: a new kind of event is staff-only until someone decides
// otherwise. Forgetting to add it here can only hide an event, never leak one.

export type Audience = "everyone" | "staff";

// Events about the ticket itself that the agency also sees through the API.
const AGENCY_EVENTS = new Set(["ticket.created", "ticket.updated", "ticket.status_changed"]);

export function audienceFor(type: string, payload: Record<string, unknown>): Audience {
  if (AGENCY_EVENTS.has(type)) return "everyone";
  // A reply is for the agency only when it is public; internal notes never are.
  if (type === "message.created" && payload.visibility === "public") return "everyone";
  // Everything else (assignment, SLA flags, links, intent, routing, supplier
  // threads, internal notes) is for staff only.
  return "staff";
}

export function agencyRoom(agencyId: string): string {
  return `agency:${agencyId}`;
}

export const STAFF_ROOM = "staff";
