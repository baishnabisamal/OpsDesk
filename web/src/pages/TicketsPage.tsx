import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { type TicketFilters, useStaff, useTickets } from "../api/queries";
import { INTENTS, PRIORITIES, STATUSES } from "../api/types";
import { useRequiredUser } from "../auth";
import { Empty, ErrorNotice } from "../components/bits";
import { TicketTable } from "../components/TicketTable";
import { INTENT_LABEL, PRIORITY_LABEL, STATUS_LABEL } from "../lib/format";
import { isStaff } from "../lib/rules";

// All tickets the user may see, newest first, with full-text search.
// For staff: every agency. For an agency user: their agency only (RLS).
export function TicketsPage() {
  const user = useRequiredUser();
  const staff = isStaff(user.role);
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get("q") ?? "");

  const filters: TicketFilters = {
    q: params.get("q") ?? undefined,
    status: params.get("status") ?? undefined,
    priority: params.get("priority") ?? undefined,
    intent: params.get("intent") ?? undefined,
    needs_review: params.get("review") ? "true" : undefined,
  };

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  // Search after the user stops typing for 300 ms, not on every key.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (text.trim() !== (params.get("q") ?? "")) set("q", text.trim());
    }, 300);
    return () => clearTimeout(timer);
  });

  const list = useTickets(filters);
  const { data: people } = useStaff(staff);
  const tickets = list.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <>
      <header className="page-head">
        <div>
          <h1>{staff ? "All tickets" : "Our tickets"}</h1>
          <p className="sub">
            {staff
              ? "Every agency, newest first. Search looks inside subjects and descriptions."
              : "Everything your agency has raised, newest first."}
          </p>
        </div>
        {!staff ? (
          <div className="actions">
            <Link className="btn primary" to="/new">
              Raise a ticket
            </Link>
          </div>
        ) : null}
      </header>

      <div className="filters">
        <label style={{ flex: "1 1 240px" }}>
          <span className="visually-hidden">Search</span>
          <input
            className="input"
            type="search"
            placeholder="Search, for example: refund Lisbon"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <Picker
          label="Status"
          value={filters.status}
          options={STATUSES.map((s) => [s, STATUS_LABEL[s]])}
          onChange={(v) => set("status", v)}
        />
        <Picker
          label="Priority"
          value={filters.priority}
          options={PRIORITIES.map((p) => [p, PRIORITY_LABEL[p]])}
          onChange={(v) => set("priority", v)}
        />
        {staff ? (
          <>
            <Picker
              label="Intent"
              value={filters.intent}
              options={INTENTS.map((i) => [i, INTENT_LABEL[i]])}
              onChange={(v) => set("intent", v)}
            />
            <label className="btn small" style={{ cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={filters.needs_review === "true"}
                onChange={(event) => set("review", event.target.checked ? "1" : "")}
              />
              Intent to check
            </label>
          </>
        ) : null}
      </div>

      <ErrorNotice error={list.error} />

      {list.isPending ? (
        <p className="muted">Loading</p>
      ) : tickets.length === 0 ? (
        <Empty title="No tickets found">
          {filters.q ? (
            "Try fewer words."
          ) : staff ? null : (
            <Link to="/new">Raise the first one</Link>
          )}
        </Empty>
      ) : (
        <TicketTable tickets={tickets} staff={people} showAssignee={staff} />
      )}

      {list.hasNextPage ? (
        <div className="more">
          <button
            className="btn"
            onClick={() => void list.fetchNextPage()}
            disabled={list.isFetchingNextPage}
          >
            {list.isFetchingNextPage ? "Loading" : "Load more"}
          </button>
        </div>
      ) : null}
    </>
  );
}

function Picker(props: {
  label: string;
  value: string | undefined;
  options: [string, string][];
  onChange: (value: string) => void;
}) {
  return (
    <label>
      <span className="visually-hidden">{props.label}</span>
      <select
        className="select"
        value={props.value ?? ""}
        onChange={(event) => props.onChange(event.target.value)}
      >
        <option value="">{props.label}: any</option>
        {props.options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}
