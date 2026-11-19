import { useState } from "react";
import { Link } from "react-router";
import { api, ApiError, login } from "../api/client";
import { ErrorNotice } from "../components/bits";
import { AuthShell } from "../components/AuthShell";

// The seeded demo accounts (api/scripts/seed.ts). Shown by the dev server,
// and by a production build only when it was built with
// VITE_DEMO_LOGINS=true (a public demo whose database holds only seed data).
// A real deployment leaves it off and never lists accounts and a password.
const SHOW_DEMO = import.meta.env.DEV || import.meta.env.VITE_DEMO_LOGINS === "true";
const DEMO_PASSWORD = "Password123!";
const DEMO_ACCOUNTS = [
  { email: "agent1.eu@opsdesk.test", label: "Agent, EU team" },
  { email: "manager.eu@opsdesk.test", label: "Escalation manager" },
  { email: "lead.eu@opsdesk.test", label: "Team lead (insights, team, export)" },
  { email: "user1@skyline-travels.test", label: "Travel agency user" },
];

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [resent, setResent] = useState(false);

  async function submit(asEmail = email, asPassword = password) {
    setBusy(true);
    setError(null);
    setResent(false);
    try {
      await login(asEmail, asPassword);
      // The app re-renders on its own: the session listener sees the login.
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const notVerified = error instanceof ApiError && error.code === "email_not_verified";

  return (
    <AuthShell title="Sign in">
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
          <span className="field-row">
            Password <Link to="/forgot-password">Forgot it?</Link>
          </span>
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

        {notVerified ? (
          <div className="notice" role="alert">
            <p>Confirm your email address first. The link is in the email we sent you.</p>
            <div className="row">
              <button
                type="button"
                className="btn small"
                disabled={resent}
                onClick={() => {
                  void api("/api/v1/auth/verify-email/resend", {
                    method: "POST",
                    body: { email },
                  }).then(() => setResent(true));
                }}
              >
                {resent ? "Sent. Check your inbox" : "Send the link again"}
              </button>
            </div>
          </div>
        ) : (
          <ErrorNotice error={error} />
        )}
      </form>

      <p className="auth-switch">
        New travel agency? <Link to="/signup">Create an account</Link>
      </p>

      {SHOW_DEMO ? (
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
      ) : null}
    </AuthShell>
  );
}
