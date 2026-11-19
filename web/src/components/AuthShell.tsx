import type { ReactNode } from "react";
import { Link } from "react-router";
import { OpsBackdrop } from "./OpsBackdrop";

// Illustration only: what a queue looks like. Not live data.
const BOARD = [
  { ref: "TBOH-48213", what: "Cancellation · Lisbon", left: "1h 50m" },
  { ref: "TBOH-30977", what: "Booking not found · Dubai", left: "overdue 12m", late: true },
  { ref: "TBOH-52140", what: "Amendment · Kyoto", left: "6h 05m" },
  { ref: "TBOH-11486", what: "Refund · Cancún", left: "2d 3h" },
];

// The frame of every signed-out page: the dark panel on the left, the form
// on the right, and the moving operations field (OpsBackdrop) behind the form.
export function AuthShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="login">
      <OpsBackdrop />
      <section className="login-art" aria-hidden="true">
        <div>
          <p className="login-mark">OpsDesk</p>
          <h1>
            Every booking has a <em>deadline.</em>
          </h1>
          <p>
            OpsDesk keeps hotel support tickets in order of what runs out first: check-in, the last
            day to cancel for free, and the promise made to the agency.
          </p>
        </div>
        <div className="board">
          {BOARD.map((row) => (
            <div key={row.ref} className={row.late ? "late" : undefined}>
              <span>{row.ref}</span>
              <span>{row.what}</span>
              <span>{row.left}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="login-form">
        <Link to="/" className="login-home">
          ← OpsDesk home
        </Link>
        <h2>{title}</h2>
        {children}
      </section>
    </div>
  );
}
