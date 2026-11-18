import { useState } from "react";
import { login } from "../api/client";
import { ErrorNotice } from "../components/bits";

// The seeded demo accounts (api/scripts/seed.ts). All use the same password.
const DEMO_PASSWORD = "Password123!";
const DEMO_ACCOUNTS = [
  { email: "agent1.eu@opsdesk.test", label: "Agent, EU team" },
  { email: "manager.eu@opsdesk.test", label: "Escalation manager" },
  { email: "lead.eu@opsdesk.test", label: "Team lead (insights, export)" },
  { email: "user1@skyline-travels.test", label: "Travel agency user" },
];

// Illustration only: what a queue looks like. Not live data.
const BOARD = [
  { ref: "TBOH-48213", what: "Cancellation · Lisbon", left: "1h 50m" },
  { ref: "TBOH-30977", what: "Booking not found · Dubai", left: "overdue 12m", late: true },
  { ref: "TBOH-52140", what: "Amendment · Kyoto", left: "6h 05m" },
  { ref: "TBOH-11486", what: "Refund · Cancún", left: "2d 3h" },
];

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(asEmail = email, asPassword = password) {
    setBusy(true);
    setError(null);
    try {
      await login(asEmail, asPassword);
      // The app re-renders on its own: the session listener sees the login.
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <section className="login-art" aria-hidden="true">
        <div>
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
        <h2>Sign in</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="field">
            <span>Email</span>
            <input
              className="input"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? "Signing in" : "Sign in"}
          </button>
          <ErrorNotice error={error} />
        </form>

        <div className="demo">
          <p>
            Demo accounts from the seed data. Password <span className="mono">{DEMO_PASSWORD}</span>
          </p>
          <div className="demo-list">
            {DEMO_ACCOUNTS.map((account) => (
              <button
                key={account.email}
                type="button"
                disabled={busy}
                onClick={() => {
                  setEmail(account.email);
                  setPassword(DEMO_PASSWORD);
                  void submit(account.email, DEMO_PASSWORD);
                }}
              >
                <span>{account.label}</span>
                <span className="mono">{account.email}</span>
              </button>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
