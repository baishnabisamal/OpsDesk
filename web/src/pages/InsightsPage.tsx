import { useState } from "react";
import { Link } from "react-router";
import { ApiError, apiRaw, query } from "../api/client";
import { useThemes } from "../api/queries";
import { REGIONS, STATUSES } from "../api/types";
import { Empty, ErrorNotice } from "../components/bits";
import { INTENT_LABEL, STATUS_LABEL, dateTime, shortId } from "../lib/format";

// Monday of the week that contains `date`, as "2026-11-16" (UTC, like the server).
export function mondayOf(date: Date): string {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = (day.getUTCDay() + 6) % 7; // Monday = 0
  day.setUTCDate(day.getUTCDate() - weekday);
  return day.toISOString().slice(0, 10);
}

function addWeeks(monday: string, weeks: number): string {
  const day = new Date(`${monday}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + weeks * 7);
  return day.toISOString().slice(0, 10);
}

// Weekly themes (precomputed every night by the theme-rollup job) and the
// streaming CSV export. Leads only.
export function InsightsPage() {
  const thisWeek = mondayOf(new Date());
  const [week, setWeek] = useState(thisWeek);
  const themes = useThemes(week);
  const notComputed = themes.error instanceof ApiError && themes.error.status === 404;
  const data = themes.data;
  const top = Math.max(1, ...(data?.intents.map((row) => row.count) ?? [1]));

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Insights</h1>
          <p className="sub">
            What agencies wrote about, week by week. Counts come from SQL; themes are groups of
            tickets with similar words, found by the ML service.
          </p>
        </div>
        <div className="week-picker" role="group" aria-label="Week">
          <button className="btn small" onClick={() => setWeek(addWeeks(week, -1))}>
            Previous
          </button>
          <span className="mono" style={{ padding: "0 8px" }}>
            week of {week}
          </span>
          <button
            className="btn small"
            disabled={week >= thisWeek}
            onClick={() => setWeek(addWeeks(week, 1))}
          >
            Next
          </button>
        </div>
      </header>

      {notComputed ? (
        <Empty title="Not computed yet">
          The theme job runs nightly. Start the worker (<span className="mono">make worker</span>)
          and this week appears after its first run.
        </Empty>
      ) : (
        <ErrorNotice error={themes.error} />
      )}

      {data ? (
        <div className="insight-grid">
          <section>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 18 }}>
              <span className="big-number">{data.ticket_count}</span>
              <span className="muted">tickets this week</span>
            </div>
            <h2 className="section-title">By intent</h2>
            <ul className="bars">
              {[...data.intents]
                .sort((a, b) => b.count - a.count)
                .map((row) => (
                  <li key={row.intent}>
                    <span>{INTENT_LABEL[row.intent] ?? row.intent}</span>
                    <span className="bar" aria-hidden="true">
                      <i style={{ width: `${(row.count / top) * 100}%` }} />
                    </span>
                    <span className="mono" style={{ textAlign: "right" }}>
                      {row.count}
                    </span>
                  </li>
                ))}
            </ul>
            <p className="muted" style={{ fontSize: 12 }}>
              Computed {dateTime(data.computed_at)}.
            </p>
          </section>

          <section>
            <h2 className="section-title">Themes</h2>
            {data.clusters === null ? (
              <p className="muted">The ML service was down when this week was computed.</p>
            ) : data.clusters.length === 0 ? (
              <p className="muted">No tickets to group.</p>
            ) : (
              <ol className="clusters">
                {data.clusters.map((cluster, index) => (
                  <li key={cluster.label + index}>
                    <span className="rank">{index + 1}</span>
                    <div>
                      <b>{cluster.label}</b>{" "}
                      <span className="muted">
                        {cluster.size} ticket{cluster.size === 1 ? "" : "s"}
                      </span>
                      <div className="terms">
                        {cluster.terms.map((term) => (
                          <span className="tag" key={term}>
                            {term}
                          </span>
                        ))}
                      </div>
                      <div style={{ fontSize: 13 }}>
                        {cluster.sample_ticket_ids.slice(0, 3).map((id, n) => (
                          <span key={id}>
                            {n > 0 ? ", " : "e.g. "}
                            <Link className="mono" to={`/tickets/${id}`}>
                              {shortId(id)}
                            </Link>
                          </span>
                        ))}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      ) : null}

      <ExportPanel />
    </>
  );
}

// The export streams from the server row by row (100,000 rows in about 5 s).
// The browser collects it into a file and offers the download.
function ExportPanel() {
  const [status, setStatus] = useState("");
  const [region, setRegion] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function download() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiRaw(`/api/v1/exports/tickets.csv${query({ status, region, from, to })}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `opsdesk-tickets-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={{ marginTop: 48 }}>
      <h2 className="section-title">Export tickets as CSV</h2>
      <div className="filters">
        <select
          className="select"
          aria-label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">Any status</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <select
          className="select"
          aria-label="Region"
          value={region}
          onChange={(e) => setRegion(e.target.value)}
        >
          <option value="">Any region</option>
          {REGIONS.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
        <label className="field" style={{ gridAutoFlow: "column", alignItems: "center" }}>
          <span>From</span>
          <input
            className="input"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="field" style={{ gridAutoFlow: "column", alignItems: "center" }}>
          <span>To</span>
          <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button className="btn primary" onClick={() => void download()} disabled={busy}>
          {busy ? "Exporting" : "Download CSV"}
        </button>
      </div>
      <ErrorNotice error={error} />
    </section>
  );
}
