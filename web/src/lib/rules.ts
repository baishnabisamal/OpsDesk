import type { Role, TicketStatus } from "../api/types";

// A copy of the server's transition table (api/src/domain/stateMachine.ts),
// used ONLY to decide which buttons to show. The server checks every move
// again; hiding a button is a convenience, never the security.

type Actor = Role;
const STAFF: Actor[] = ["agent", "escalation_manager", "lead"];
const SENIOR: Actor[] = ["escalation_manager", "lead"];
const ANYONE: Actor[] = ["requester", ...STAFF];

const TRANSITIONS: Record<TicketStatus, Partial<Record<TicketStatus, Actor[]>>> = {
  // new -> open happens by assigning, so no plain button for it.
  new: {},
  open: { pending: STAFF, escalated: STAFF, resolved: STAFF },
  pending: { open: ANYONE, escalated: STAFF, resolved: STAFF },
  escalated: { open: SENIOR, resolved: SENIOR },
  resolved: { open: ANYONE, closed: ANYONE },
  closed: {},
};

export function nextStatuses(from: TicketStatus, role: Role): TicketStatus[] {
  return (Object.entries(TRANSITIONS[from]) as [TicketStatus, Actor[]][])
    .filter(([, actors]) => actors.includes(role))
    .map(([to]) => to);
}

// The words on the button, which say what happens rather than the target state.
export function transitionLabel(from: TicketStatus, to: TicketStatus): string {
  if (to === "open" && from === "resolved") return "Reopen";
  if (to === "open" && from === "escalated") return "De-escalate";
  if (to === "open" && from === "pending") return "Resume";
  if (to === "pending") return "Wait on customer";
  if (to === "escalated") return "Escalate";
  if (to === "resolved") return "Resolve";
  if (to === "closed") return "Close";
  return to;
}

export const isStaff = (role: Role) => role !== "requester";
