import type { TimelineEvent } from "../api/types";
import { INTENT_LABEL, PRIORITY_LABEL, SLA_LABEL, STATUS_LABEL, shortId } from "./format";

// Turns a timeline event into one readable sentence.
// `name` maps a user id to a name (staff list), falling back to "Someone".

type Lookup = (id: string | null | undefined) => string;

const label = (map: Record<string, string>, value: unknown) =>
  typeof value === "string" ? (map[value] ?? value) : "?";

export function describeEvent(event: TimelineEvent, name: Lookup): string {
  const d = event.data;
  const who = event.actor_id ? name(event.actor_id) : "System";
  switch (event.type) {
    case "ticket_created":
      return `${who} raised the ticket (${label(INTENT_LABEL, d.intent)}, ${label(PRIORITY_LABEL, d.priority)})`;
    case "status_changed":
      return `${who} moved it from ${label(STATUS_LABEL, d.from)} to ${label(STATUS_LABEL, d.to)}`;
    case "ticket_assigned": {
      const to = d.to ? name(d.to as string) : "nobody";
      if (d.by === "routing") return `Routing assigned it to ${to}`;
      if (d.by === "escalation") return `Escalation handed it to ${to}`;
      return d.from ? `${who} transferred it to ${to}` : `${who} assigned it to ${to}`;
    }
    case "ticket_updated": {
      const changes = (d.changes ?? {}) as Record<string, { from: unknown; to: unknown }>;
      const parts = Object.entries(changes).map(([field, change]) =>
        field === "priority"
          ? `priority ${label(PRIORITY_LABEL, change.from)} to ${label(PRIORITY_LABEL, change.to)}`
          : `the ${field}`,
      );
      return `${who} changed ${parts.join(" and ") || "the ticket"}`;
    }
    case "intent_overridden":
      return `${who} corrected the intent from ${label(INTENT_LABEL, d.from)} to ${label(INTENT_LABEL, d.to)}`;
    case "message_added":
      return event.visibility === "internal" ? `${who} added an internal note` : `${who} replied`;
    case "ticket_linked":
      return d.reason === "manual"
        ? `${who} linked ticket ${shortId(String(d.ticket_id))}`
        : `Linked to ticket ${shortId(String(d.ticket_id))} (similar text)`;
    case "ticket_unlinked":
      return `${who} unlinked ticket ${shortId(String(d.ticket_id))}`;
    case "sla_state_changed":
      return `SLA is now ${label(SLA_LABEL, d.to).toLowerCase()}`;
    case "side_conversation_started":
      return `${who} started a supplier thread`;
    case "side_message_added":
      return d.direction === "inbound" ? "The supplier replied" : `${who} wrote to the supplier`;
    default:
      return `${who}: ${event.type.replaceAll("_", " ")}`;
  }
}
