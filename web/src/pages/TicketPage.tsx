import { useState } from "react";
import { Link, useParams } from "react-router";
import { ApiError } from "../api/client";
import { type Conflict, useTicketChange } from "../api/mutations";
import {
  useMessages,
  useSideConversations,
  useStaff,
  useTicket,
  useTimeline,
} from "../api/queries";
import type { StaffMember, Ticket, User } from "../api/types";
import { useRequiredUser } from "../auth";
import { Empty, ErrorNotice } from "../components/bits";
import { Conversation } from "../components/Conversation";
import { FactsRail } from "../components/FactsRail";
import { SideThreads } from "../components/SideThreads";
import { STATUS_LABEL, dateTime, relative, shortId } from "../lib/format";
import { isStaff, nextStatuses, transitionLabel } from "../lib/rules";
import { describeEvent } from "../lib/timeline";

type Tab = "conversation" | "timeline" | "supplier";

export function TicketPage() {
  const { id = "" } = useParams();
  const user = useRequiredUser();
  const ticket = useTicket(id);
  const { data: staff = [] } = useStaff(isStaff(user.role));

  if (ticket.isPending) return <p className="muted">Loading</p>;
  if (ticket.error) {
    // 404 covers "does not exist" and "not yours": the API never says which.
    if (ticket.error instanceof ApiError && ticket.error.status === 404) {
      return (
        <Empty title="Ticket not found">
          It does not exist, or it belongs to another agency.{" "}
          <Link to="/tickets">Back to tickets</Link>
        </Empty>
      );
    }
    return <ErrorNotice error={ticket.error} />;
  }
  return <TicketView ticket={ticket.data} user={user} staff={staff} />;
}

function TicketView({ ticket, user, staff }: { ticket: Ticket; user: User; staff: StaffMember[] }) {
  const [tab, setTab] = useState<Tab>("conversation");
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState(ticket.subject);
  const changer = useTicketChange(ticket.id);
  const staffUser = isStaff(user.role);
  const messages = useMessages(ticket.id);
  const sides = useSideConversations(ticket.id, staffUser);

  const moves = nextStatuses(ticket.status, user.role);
  const canTake =
    staffUser &&
    ticket.assignee_id === null &&
    ticket.status !== "resolved" &&
    ticket.status !== "closed";

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to={staffUser ? "/queues/triage" : "/tickets"}>
          {staffUser ? "Queues" : "Tickets"}
        </Link>
        <span aria-hidden="true">/</span>
        <span className="mono">{shortId(ticket.id)}</span>
        <span aria-hidden="true">·</span>
        <span>opened {relative(ticket.created_at)}</span>
      </nav>

      {editingTitle ? (
        <form
          className="title-edit"
          onSubmit={(event) => {
            event.preventDefault();
            if (title.trim() && title.trim() !== ticket.subject) {
              changer.change(ticket, { kind: "subject", subject: title.trim() });
            }
            setEditingTitle(false);
          }}
        >
          <input
            className="input"
            autoFocus
            maxLength={200}
            value={title}
            aria-label="Subject"
            onChange={(event) => setTitle(event.target.value)}
          />
          <button className="btn primary">Save</button>
          <button type="button" className="btn quiet" onClick={() => setEditingTitle(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <h1 className="ticket-title">
          {ticket.subject}{" "}
          {staffUser && ticket.status !== "closed" ? (
            <button
              className="btn quiet small"
              onClick={() => {
                setTitle(ticket.subject);
                setEditingTitle(true);
              }}
            >
              Edit
            </button>
          ) : null}
        </h1>
      )}

      {moves.length > 0 || canTake ? (
        <div className="action-bar">
          {canTake ? (
            <button
              className="btn primary"
              disabled={changer.pending}
              onClick={() => changer.change(ticket, { kind: "assign", assigneeId: user.id })}
            >
              Take it
            </button>
          ) : null}
          {moves.map((to) => (
            <button
              key={to}
              className={
                to === "escalated" ? "btn danger" : to === "resolved" ? "btn primary" : "btn"
              }
              disabled={changer.pending}
              onClick={() => changer.change(ticket, { kind: "transition", to })}
            >
              {transitionLabel(ticket.status, to)}
            </button>
          ))}
          <span className="spacer" />
          <span className="muted mono" title="Sent as If-Match with every change">
            v{ticket.version}
          </span>
        </div>
      ) : null}

      {changer.conflict ? (
        <ConflictNotice
          conflict={changer.conflict}
          staff={staff}
          onRetry={changer.retry}
          onDismiss={changer.dismiss}
        />
      ) : null}
      <ErrorNotice error={changer.error} />

      <div className="ticket-grid">
        <div>
          <div className="tabs" role="tablist">
            <TabButton tab="conversation" current={tab} onSelect={setTab}>
              Conversation<span className="count">{(messages.data?.length ?? 0) + 1}</span>
            </TabButton>
            <TabButton tab="timeline" current={tab} onSelect={setTab}>
              Timeline
            </TabButton>
            {staffUser ? (
              <TabButton tab="supplier" current={tab} onSelect={setTab}>
                Supplier threads<span className="count">{sides.data?.length ?? 0}</span>
              </TabButton>
            ) : null}
          </div>

          {tab === "conversation" ? <Conversation ticket={ticket} user={user} /> : null}
          {tab === "timeline" ? <Timeline ticketId={ticket.id} staff={staff} user={user} /> : null}
          {tab === "supplier" && staffUser ? <SideThreads ticketId={ticket.id} /> : null}
        </div>

        <FactsRail
          ticket={ticket}
          user={user}
          staff={staff}
          busy={changer.pending}
          onChange={(change) => changer.change(ticket, change)}
        />
      </div>
    </>
  );
}

function TabButton(props: {
  tab: Tab;
  current: Tab;
  onSelect: (tab: Tab) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      role="tab"
      aria-selected={props.tab === props.current}
      onClick={() => props.onSelect(props.tab)}
    >
      {props.children}
    </button>
  );
}

// Shown when someone else changed the ticket between the user loading it
// and pressing the button. Nothing was saved; the latest ticket is on screen.
function ConflictNotice(props: {
  conflict: Conflict;
  staff: StaffMember[];
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const { latest, change } = props.conflict;
  const what =
    change.kind === "transition"
      ? `move it to ${STATUS_LABEL[change.to]}`
      : change.kind === "assign"
        ? "change the owner"
        : `change the ${change.kind}`;
  return (
    <div className="notice conflict" role="alert" style={{ marginTop: 14 }}>
      <p>
        <b>Someone else changed this ticket first.</b> Your request to {what} was not saved. The
        latest version (v{latest.version}, status {STATUS_LABEL[latest.status]}) is now on screen.
      </p>
      <div className="row">
        <button className="btn small primary" onClick={props.onRetry}>
          Apply my change again
        </button>
        <button className="btn small" onClick={props.onDismiss}>
          Keep theirs
        </button>
      </div>
    </div>
  );
}

function Timeline({
  ticketId,
  staff,
  user,
}: {
  ticketId: string;
  staff: StaffMember[];
  user: User;
}) {
  const timeline = useTimeline(ticketId);
  const names = new Map(staff.map((member) => [member.id, member.full_name]));
  const name = (id: string | null | undefined) =>
    !id
      ? "Nobody"
      : id === user.id
        ? "You"
        : (names.get(id) ?? (isStaff(user.role) ? "Agency" : "Support"));

  return (
    <section aria-label="Timeline">
      <ErrorNotice error={timeline.error} />
      <ol className="ledger">
        {timeline.data?.map((event) => (
          <li key={event.id}>
            <time dateTime={event.created_at}>{dateTime(event.created_at)}</time>
            <span>
              {describeEvent(event, name)}
              {event.visibility === "internal" ? <span className="internal">INTERNAL</span> : null}
            </span>
          </li>
        ))}
      </ol>
      <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
        The timeline is append-only. Nobody, including the app itself, can edit or delete it.
      </p>
    </section>
  );
}
