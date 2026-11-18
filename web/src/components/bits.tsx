import { useEffect, useState } from "react";
import { ApiError } from "../api/client";
import type { Priority, SlaState, Ticket, TicketStatus } from "../api/types";
import { PRIORITY_LABEL, SLA_LABEL, STATUS_LABEL, slaReading } from "../lib/format";

// Small pieces used on many screens.

export function StatusText({ status }: { status: TicketStatus }) {
  return (
    <span className="status" data-status={status}>
      {STATUS_LABEL[status]}
    </span>
  );
}

export function PriorityText({ priority }: { priority: Priority }) {
  return (
    <span className="priority" data-priority={priority}>
      {PRIORITY_LABEL[priority]}
    </span>
  );
}

// The current time, ticking every `everyMs`. One SLA clock per row would be
// wasteful with a timer each, but 50 timers firing every 30 s is nothing.
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

// Time left on the SLA, with a thin bar of how much of it is used up. The
// colour comes from the server's sla_state (the scanner decides "at risk").
export function SlaClock({ ticket }: { ticket: Ticket }) {
  const now = useNow();
  const reading = slaReading(ticket, now);
  const done = ticket.status === "resolved" || ticket.status === "closed";
  const state: SlaState | "done" = done ? "done" : ticket.sla_state;
  return (
    <div className="sla" data-state={state} title={done ? "Finished" : SLA_LABEL[ticket.sla_state]}>
      <span className="sla-text">{reading.text}</span>
      <span className="sla-bar" aria-hidden="true">
        <i style={{ width: `${Math.round(reading.usedFraction * 100)}%` }} />
      </span>
    </div>
  );
}

export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  const text =
    error instanceof ApiError
      ? error.status === 429
        ? `Too many requests. Try again in ${error.retryAfter ?? "a few"} seconds.`
        : error.detail
      : "Could not reach the server. Is the API running?";
  return (
    <div className="notice error" role="alert">
      <p>{text}</p>
      {error instanceof ApiError && error.requestId ? (
        <p className="muted mono">request {error.requestId}</p>
      ) : null}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}
