import type { Intent, Priority, SlaState, TicketStatus } from "../api/types";

// Words and numbers shown on screen. Pure functions, unit tested.

export const INTENT_LABEL: Record<Intent, string> = {
  booking_not_found: "Booking not found",
  cancellation: "Cancellation",
  amendment: "Amendment",
  refund: "Refund",
  voucher: "Voucher",
  payment: "Payment",
  other: "Other",
};

export const STATUS_LABEL: Record<TicketStatus, string> = {
  new: "New",
  open: "Open",
  pending: "Pending",
  escalated: "Escalated",
  resolved: "Resolved",
  closed: "Closed",
};

export const PRIORITY_LABEL: Record<Priority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

export const SLA_LABEL: Record<SlaState, string> = {
  ok: "On track",
  at_risk: "At risk",
  breached: "Breached",
};

export const ROLE_LABEL: Record<string, string> = {
  requester: "Agency",
  agent: "Agent",
  escalation_manager: "Escalation manager",
  lead: "Lead",
};

// 125 minutes -> "2h 5m". Days above 48 hours: "3d 4h".
export function duration(ms: number): string {
  const minutes = Math.floor(Math.abs(ms) / 60_000);
  if (minutes < 1) return "<1m";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (minutes >= 48 * 60) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (minutes >= 60)
    return mins ? `${Math.floor(minutes / 60)}h ${mins}m` : `${Math.floor(minutes / 60)}h`;
  return `${mins}m`;
}

// "in 2h 5m" / "3h ago".
export function relative(iso: string, now: number = Date.now()): string {
  const diff = new Date(iso).getTime() - now;
  return diff >= 0 ? `in ${duration(diff)}` : `${duration(diff)} ago`;
}

export type SlaReading = {
  text: string; // "2h 5m left", "overdue 40m", "paused", "met"
  usedFraction: number; // 0..1 of the time between creation and the deadline
};

// What the SLA clock shows for a ticket right now.
export function slaReading(
  ticket: {
    created_at: string;
    sla_due_at: string;
    sla_paused_at: string | null;
    status: TicketStatus;
  },
  now: number = Date.now(),
): SlaReading {
  const start = new Date(ticket.created_at).getTime();
  const due = new Date(ticket.sla_due_at).getTime();
  const total = Math.max(due - start, 1);

  if (ticket.status === "resolved" || ticket.status === "closed") {
    return { text: "done", usedFraction: 1 };
  }
  // While pending (waiting on the customer) the clock is stopped.
  const at = ticket.sla_paused_at ? new Date(ticket.sla_paused_at).getTime() : now;
  const used = Math.min(Math.max((at - start) / total, 0), 1);
  const left = due - at;
  const text = ticket.sla_paused_at
    ? `paused, ${duration(left)} left`
    : left >= 0
      ? `${duration(left)} left`
      : `overdue ${duration(left)}`;
  return { text, usedFraction: used };
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function dateOnly(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// "Priya Raman" -> "PR"
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}
