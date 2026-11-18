import { useParams, useSearchParams } from "react-router";
import { type QueueFilters, useQueue, useStaff } from "../api/queries";
import { INTENTS, REGIONS } from "../api/types";
import { Empty, ErrorNotice } from "../components/bits";
import { TicketTable } from "../components/TicketTable";
import { INTENT_LABEL } from "../lib/format";

const QUEUES: Record<string, { title: string; sub: string }> = {
  triage: {
    title: "Triage",
    sub: "Tickets nobody owns yet. Routing places most of them; these are the ones it could not.",
  },
  mine: { title: "My queue", sub: "Everything assigned to you that is still live." },
  escalations: {
    title: "Escalations",
    sub: "Breached or hand-escalated tickets, waiting for an escalation manager.",
  },
  linked: {
    title: "Linked cases",
    sub: "Tickets that share a booking or were linked by hand. Read them together before replying.",
  },
  region: { title: "By region", sub: "Live tickets for one region." },
  intent: { title: "By intent", sub: "Live tickets of one kind." },
};

const SLA_FILTERS = [
  { value: "", label: "All" },
  { value: "at_risk", label: "At risk" },
  { value: "breached", label: "Breached" },
];

// Every queue is ordered by SLA deadline, soonest first (server side).
export function QueuePage() {
  const { name = "triage" } = useParams();
  const [params, setParams] = useSearchParams();
  const info = QUEUES[name] ?? QUEUES.triage!;

  const filters: QueueFilters = {
    region: name === "region" ? (params.get("region") ?? "EU") : undefined,
    intent: name === "intent" ? (params.get("intent") ?? "cancellation") : undefined,
    sla_state: params.get("sla") ?? undefined,
  };

  const queue = useQueue(name, filters);
  const { data: staff } = useStaff(true);
  const tickets = queue.data?.pages.flatMap((page) => page.items) ?? [];

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <>
      <header className="page-head">
        <div>
          <h1>{info.title}</h1>
          <p className="sub">{info.sub}</p>
        </div>
      </header>

      <div className="filters">
        {name === "region" ? (
          <label>
            <span className="visually-hidden">Region</span>
            <select
              className="select"
              value={filters.region}
              onChange={(event) => set("region", event.target.value)}
            >
              {REGIONS.map((region) => (
                <option key={region}>{region}</option>
              ))}
            </select>
          </label>
        ) : null}
        {name === "intent" ? (
          <label>
            <span className="visually-hidden">Intent</span>
            <select
              className="select"
              value={filters.intent}
              onChange={(event) => set("intent", event.target.value)}
            >
              {INTENTS.map((intent) => (
                <option key={intent} value={intent}>
                  {INTENT_LABEL[intent]}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="segmented" role="group" aria-label="SLA">
          {SLA_FILTERS.map((option) => (
            <button
              key={option.value}
              aria-pressed={(filters.sla_state ?? "") === option.value}
              onClick={() => set("sla", option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <span className="muted" style={{ marginLeft: "auto" }}>
          {queue.isFetching && !queue.isFetchingNextPage ? "Refreshing" : `${tickets.length} shown`}
        </span>
      </div>

      <ErrorNotice error={queue.error} />

      {queue.isPending ? (
        <p className="muted">Loading</p>
      ) : tickets.length === 0 ? (
        <Empty title="Nothing here">
          {filters.sla_state
            ? "No ticket in this queue matches the SLA filter."
            : "The queue is clear."}
        </Empty>
      ) : (
        <>
          <TicketTable tickets={tickets} staff={staff} />
          <p className="kbd-help">
            <kbd>j</kbd> <kbd>k</kbd> to move, <kbd>Enter</kbd> to open
          </p>
        </>
      )}

      {queue.hasNextPage ? (
        <div className="more">
          <button
            className="btn"
            onClick={() => void queue.fetchNextPage()}
            disabled={queue.isFetchingNextPage}
          >
            {queue.isFetchingNextPage ? "Loading" : "Load more"}
          </button>
        </div>
      ) : null}
    </>
  );
}
