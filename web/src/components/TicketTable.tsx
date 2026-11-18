import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { StaffMember, Ticket } from "../api/types";
import { INTENT_LABEL, relative, shortId } from "../lib/format";
import { PriorityText, SlaClock, StatusText } from "./bits";

type Props = {
  tickets: Ticket[];
  staff?: StaffMember[];
  // Requesters do not see who is handling the ticket internally.
  showAssignee?: boolean;
};

// The list of tickets used by every queue and by search.
// Keyboard: j / k move down / up, Enter opens. Agents live in this table all
// day, so it should not need the mouse.
export function TicketTable({ tickets, staff = [], showAssignee = true }: Props) {
  const navigate = useNavigate();
  const [active, setActive] = useState(-1);
  const names = new Map(staff.map((member) => [member.id, member.full_name]));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable]")) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "j") setActive((i) => Math.min(i + 1, tickets.length - 1));
      if (event.key === "k") setActive((i) => Math.max(i - 1, 0));
      if (event.key === "Enter" && active >= 0 && tickets[active]) {
        navigate(`/tickets/${tickets[active].id}`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tickets, active, navigate]);

  // Keep the highlighted row on screen.
  useEffect(() => {
    if (active < 0) return;
    document.querySelector(`[data-row="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <div className="table-wrap">
      <table className="tickets">
        <thead>
          <tr>
            <th scope="col">Ticket</th>
            <th scope="col">Status</th>
            <th scope="col">Priority</th>
            <th scope="col">Intent</th>
            <th scope="col">SLA</th>
            {showAssignee ? <th scope="col">Owner</th> : null}
            <th scope="col">Region</th>
          </tr>
        </thead>
        <tbody>
          {tickets.map((ticket, index) => (
            <tr
              key={ticket.id}
              data-row={index}
              data-active={index === active}
              onClick={() => navigate(`/tickets/${ticket.id}`)}
            >
              <td>
                <Link
                  className="subject"
                  to={`/tickets/${ticket.id}`}
                  onClick={(event) => event.stopPropagation()}
                >
                  {ticket.subject}
                </Link>
                <div className="meta">
                  <span className="mono">{shortId(ticket.id)}</span> · opened{" "}
                  {relative(ticket.created_at)}
                </div>
              </td>
              <td>
                <StatusText status={ticket.status} />
              </td>
              <td>
                <PriorityText priority={ticket.priority} />
              </td>
              <td>
                {INTENT_LABEL[ticket.intent]}
                {ticket.needs_review ? (
                  <>
                    {" "}
                    <span className="tag review">check</span>
                  </>
                ) : null}
              </td>
              <td>
                <SlaClock ticket={ticket} />
              </td>
              {showAssignee ? (
                <td>
                  {ticket.assignee_id ? (
                    (names.get(ticket.assignee_id) ?? "Staff")
                  ) : (
                    <span className="muted">Nobody</span>
                  )}
                </td>
              ) : null}
              <td className="mono">{ticket.region_code}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
