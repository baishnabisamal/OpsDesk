import type { Actor } from "./enums.js";

// Which roles may perform which action at all. This is the first of the two
// isolation checks; Row-Level Security in the database is the second and
// decides which rows a role can touch.

const STAFF: Actor[] = ["agent", "escalation_manager", "lead"];
const EVERYONE: Actor[] = ["requester", ...STAFF];

const PERMISSIONS = {
  "ticket:create": ["requester"],
  "ticket:read": EVERYONE,
  "ticket:edit": STAFF,
  // The state machine then decides which transitions each role may make.
  "ticket:transition": EVERYONE,
  // Any staff member may take an unassigned ticket for themselves.
  "ticket:assign_self": STAFF,
  // Only a lead may give a ticket to someone else or take it from someone.
  "ticket:assign_other": ["lead"],
  "message:read": EVERYONE,
  "message:write_public": EVERYONE,
  "message:write_internal": STAFF,
  "timeline:read": EVERYONE,
} satisfies Record<string, Actor[]>;

export type Action = keyof typeof PERMISSIONS;

export const ACTIONS = Object.keys(PERMISSIONS) as Action[];

export function can(actor: Actor, action: Action): boolean {
  const allowed: Actor[] = PERMISSIONS[action];
  return allowed.includes(actor);
}
