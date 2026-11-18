import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api/client";
import type { TicketChange } from "../api/mutations";
import { keys, useCase, useLinks } from "../api/queries";
import { INTENTS, PRIORITIES, type StaffMember, type Ticket, type User } from "../api/types";
import {
  INTENT_LABEL,
  PRIORITY_LABEL,
  STATUS_LABEL,
  dateOnly,
  dateTime,
  shortId,
} from "../lib/format";
import { isStaff } from "../lib/rules";
import { ErrorNotice, PriorityText, SlaClock, StatusText } from "./bits";

const SOURCE_LABEL: Record<string, string> = {
  rule: "matched a keyword rule",
  model: "suggested by the model",
  manual: "set by a person",
  fallback: "model unavailable",
};

type Props = {
  ticket: Ticket;
  user: User;
  staff: StaffMember[];
  busy: boolean;
  onChange: (change: TicketChange) => void;
};

// The facts about a ticket, in the right-hand column. Staff can change
// priority, intent and (leads) owner right here; every change goes through
// useTicketChange with the version the user is looking at.
export function FactsRail({ ticket, user, staff, busy, onChange }: Props) {
  const isStaffUser = isStaff(user.role);
  const caseView = useCase(ticket.case_id);
  const booking = caseView.data?.booking;
  const owner = staff.find((member) => member.id === ticket.assignee_id);
  const live = ticket.status !== "resolved" && ticket.status !== "closed";

  return (
    <aside className="rail">
      <dl className="facts">
        <dt>Status</dt>
        <dd>
          <StatusText status={ticket.status} />
        </dd>

        <dt>SLA</dt>
        <dd>
          <SlaClock ticket={ticket} />
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            due {dateTime(ticket.sla_due_at)}
          </div>
        </dd>

        <dt>Priority</dt>
        <dd>
          {isStaffUser && ticket.status !== "closed" ? (
            <select
              className="select"
              aria-label="Priority"
              value={ticket.priority}
              disabled={busy}
              onChange={(event) =>
                onChange({ kind: "priority", priority: event.target.value as Ticket["priority"] })
              }
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
          ) : (
            <PriorityText priority={ticket.priority} />
          )}
        </dd>

        <dt>Intent</dt>
        <dd>
          {isStaffUser && ticket.status !== "closed" ? (
            <select
              className="select"
              aria-label="Intent"
              value={ticket.intent}
              disabled={busy}
              onChange={(event) =>
                onChange({ kind: "intent", intent: event.target.value as Ticket["intent"] })
              }
            >
              {INTENTS.map((i) => (
                <option key={i} value={i}>
                  {INTENT_LABEL[i]}
                </option>
              ))}
            </select>
          ) : (
            INTENT_LABEL[ticket.intent]
          )}
          {isStaffUser ? (
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              {SOURCE_LABEL[ticket.intent_source] ?? ticket.intent_source}
              {ticket.intent_confidence !== null
                ? `, ${Math.round(ticket.intent_confidence * 100)}% sure`
                : ""}
              {ticket.needs_review ? (
                <>
                  {" "}
                  <span className="tag review">check this</span>
                </>
              ) : null}
            </div>
          ) : null}
        </dd>

        {isStaffUser ? (
          <>
            <dt>Owner</dt>
            <dd>
              {user.role === "lead" && live ? (
                <select
                  className="select"
                  aria-label="Owner"
                  value={ticket.assignee_id ?? ""}
                  disabled={busy}
                  onChange={(event) =>
                    event.target.value &&
                    onChange({ kind: "assign", assigneeId: event.target.value })
                  }
                >
                  <option value="" disabled>
                    Nobody
                  </option>
                  {staff.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.full_name} · {member.region_code ?? "?"}
                      {member.max_open ? ` (${member.open_count}/${member.max_open})` : ""}
                    </option>
                  ))}
                </select>
              ) : owner ? (
                owner.full_name
              ) : (
                <span className="muted">Nobody</span>
              )}
            </dd>
          </>
        ) : null}

        <dt>Region</dt>
        <dd className="mono">{ticket.region_code}</dd>

        <dt>Booking</dt>
        <dd>
          {booking ? (
            <>
              <span className="mono">{booking.tboh}</span>
              <div className="muted" style={{ fontSize: 13 }}>
                {booking.hotel_name}
              </div>
            </>
          ) : (
            <span className="muted">…</span>
          )}
        </dd>

        <dt>Check-in</dt>
        <dd>{dateOnly(ticket.check_in_at)}</dd>

        <dt>Free cancel</dt>
        <dd title="Last cancellation date: after this the agency pays a penalty">
          until {dateTime(ticket.lcd_at)}
        </dd>
      </dl>

      {caseView.data && caseView.data.tickets.length > 1 ? (
        <section>
          <h3>
            Same booking <Link to={`/cases/${ticket.case_id}`}>case view</Link>
          </h3>
          <ul className="rail-list">
            {caseView.data.tickets
              .filter((other) => other.id !== ticket.id)
              .slice(0, 5)
              .map((other) => (
                <li key={other.id}>
                  <Link to={`/tickets/${other.id}`}>{other.subject}</Link>
                  <span className="muted">
                    {STATUS_LABEL[other.status]} · {shortId(other.id)}
                  </span>
                </li>
              ))}
            {caseView.data.tickets.length > 6 ? (
              <li className="muted">
                and {caseView.data.tickets.length - 6} more in the{" "}
                <Link to={`/cases/${ticket.case_id}`}>case view</Link>
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}

      {isStaffUser ? <LinkedTickets ticketId={ticket.id} /> : null}
    </aside>
  );
}

function LinkedTickets({ ticketId }: { ticketId: string }) {
  const client = useQueryClient();
  const links = useLinks(ticketId);
  const [other, setOther] = useState("");

  const refresh = () => {
    void client.invalidateQueries({ queryKey: keys.links(ticketId) });
    void client.invalidateQueries({ queryKey: keys.timeline(ticketId) });
  };
  const link = useMutation({
    mutationFn: (id: string) =>
      api(`/api/v1/tickets/${ticketId}/links`, { method: "POST", body: { ticket_id: id } }),
    onSuccess: () => {
      setOther("");
      refresh();
    },
  });
  const unlink = useMutation({
    mutationFn: (id: string) =>
      api(`/api/v1/tickets/${ticketId}/links/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
  });

  return (
    <section>
      <h3>Linked tickets</h3>
      <ul className="rail-list">
        {links.data?.map((item) => (
          <li key={item.ticket_id}>
            <Link to={`/tickets/${item.ticket_id}`}>{item.subject}</Link>
            <span className="muted" style={{ display: "flex", justifyContent: "space-between" }}>
              <span>
                {item.reason === "manual"
                  ? "linked by hand"
                  : `similar text${item.score !== null ? `, ${Math.round(item.score * 100)}%` : ""}`}
              </span>
              <button
                className="btn quiet small"
                disabled={unlink.isPending}
                onClick={() => unlink.mutate(item.ticket_id)}
              >
                Unlink
              </button>
            </span>
          </li>
        ))}
        {links.data?.length === 0 ? <li className="muted">None</li> : null}
      </ul>
      <form
        style={{ display: "flex", gap: 6, marginTop: 8 }}
        onSubmit={(event) => {
          event.preventDefault();
          if (other.trim()) link.mutate(other.trim());
        }}
      >
        <input
          className="input"
          placeholder="Ticket id to link"
          aria-label="Ticket id to link"
          value={other}
          onChange={(event) => setOther(event.target.value)}
        />
        <button className="btn" disabled={link.isPending || !other.trim()}>
          Link
        </button>
      </form>
      <ErrorNotice error={link.error ?? unlink.error} />
    </section>
  );
}
