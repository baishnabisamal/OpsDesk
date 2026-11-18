import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, setSession } from "../api/client";
import type { Session } from "../api/types";
import { ErrorNotice } from "../components/bits";
import { AuthShell } from "../components/AuthShell";

// The signed-out pages besides login: sign up, the emailed links, and the
// forgotten password. The server decides everything; these pages only
// collect input and show what happened.

const PASSWORD_HINT = "At least 10 characters. A short sentence is easier to remember.";

// The token travels after "#" in the emailed link, so it never reaches a
// server log. Read it once and remove it from the address bar and history.
function useLinkToken(): string | null {
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get("token"));
  useEffect(() => {
    if (window.location.hash) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);
  return token;
}

function CheckEmail({ email, children }: { email: string; children?: React.ReactNode }) {
  return (
    <div className="check-email" role="status">
      <p>
        If everything is in order, an email is on its way to <b>{email}</b>. The link in it works
        once.
      </p>
      {children}
      <p className="muted" style={{ fontSize: 13 }}>
        Running locally? Emails land in Mailpit:{" "}
        <a href="http://localhost:8025" target="_blank" rel="noreferrer">
          localhost:8025
        </a>
      </p>
      <p className="auth-switch">
        <Link to="/">Back to sign in</Link>
      </p>
    </div>
  );
}

function PasswordField(props: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
}) {
  return (
    <label className="field">
      <span>{props.label ?? "Password"}</span>
      <input
        className="input"
        type="password"
        autoComplete="new-password"
        required
        minLength={10}
        maxLength={200}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
      <small className="muted">{PASSWORD_HINT}</small>
    </label>
  );
}

// ---------------------------------------------------------------------------

export function SignupPage() {
  const [form, setForm] = useState({ agency_name: "", full_name: "", email: "", password: "" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [key]: event.target.value });

  if (done) {
    return (
      <AuthShell title="Check your email">
        <CheckEmail email={form.email} />
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Create an agency account">
      <p className="muted" style={{ margin: 0 }}>
        For travel agencies that book hotels through us. Support staff are invited by their team
        lead instead.
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api("/api/v1/auth/signup", { method: "POST", body: form });
            setDone(true);
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="field">
          <span>Agency name</span>
          <input
            className="input"
            required
            minLength={2}
            maxLength={120}
            autoComplete="organization"
            value={form.agency_name}
            onChange={set("agency_name")}
          />
        </label>
        <label className="field">
          <span>Your name</span>
          <input
            className="input"
            required
            maxLength={200}
            autoComplete="name"
            value={form.full_name}
            onChange={set("full_name")}
          />
        </label>
        <label className="field">
          <span>Work email</span>
          <input
            className="input"
            type="email"
            required
            autoComplete="email"
            value={form.email}
            onChange={set("email")}
          />
        </label>
        <PasswordField
          value={form.password}
          onChange={(password) => setForm({ ...form, password })}
        />
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? "Creating" : "Create account"}
        </button>
        <ErrorNotice error={error} />
      </form>
      <p className="auth-switch">
        Already have an account? <Link to="/">Sign in</Link>
      </p>
    </AuthShell>
  );
}

// ---------------------------------------------------------------------------

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  if (done) {
    return (
      <AuthShell title="Check your email">
        <CheckEmail email={email}>
          <p className="muted">The reset link expires in 1 hour.</p>
        </CheckEmail>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Forgot your password?">
      <p className="muted" style={{ margin: 0 }}>
        We will email you a link to choose a new one.
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setError(null);
          try {
            await api("/api/v1/auth/password/forgot", { method: "POST", body: { email } });
            setDone(true);
          } catch (err) {
            setError(err);
          }
        }}
      >
        <label className="field">
          <span>Email</span>
          <input
            className="input"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <button className="btn primary" type="submit">
          Send the link
        </button>
        <ErrorNotice error={error} />
      </form>
      <p className="auth-switch">
        <Link to="/">Back to sign in</Link>
      </p>
    </AuthShell>
  );
}

// ---------------------------------------------------------------------------
// Pages opened from an email link.
// ---------------------------------------------------------------------------

function MissingToken() {
  return (
    <AuthShell title="This link is incomplete">
      <p>Open the link straight from the email, or ask for a new one.</p>
      <p className="auth-switch">
        <Link to="/">Back to sign in</Link>
      </p>
    </AuthShell>
  );
}

// Each emailed token can be used once. React's StrictMode runs effects twice
// in development, so remember which tokens were already sent.
const verifyStarted = new Set<string>();

export function VerifyEmailPage() {
  const token = useLinkToken();
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!token || verifyStarted.has(token)) return;
    verifyStarted.add(token);
    api<Session>("/api/v1/auth/verify-email", { method: "POST", body: { token } })
      .then((session) => {
        navigate("/", { replace: true });
        setSession(session); // signed in: the app switches to the logged-in screens
      })
      .catch(setError);
  }, [token, navigate]);

  if (!token) return <MissingToken />;
  return (
    <AuthShell title={error ? "That link did not work" : "Confirming your email"}>
      {error ? (
        <>
          <ErrorNotice error={error} />
          <p>
            Links work once and expire after 48 hours. Sign in and we will offer to send a new one.
          </p>
          <p className="auth-switch">
            <Link to="/">Back to sign in</Link>
          </p>
        </>
      ) : (
        <p className="muted">One moment.</p>
      )}
    </AuthShell>
  );
}

export function ResetPasswordPage() {
  const token = useLinkToken();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  if (!token) return <MissingToken />;
  if (done) {
    return (
      <AuthShell title="Password changed">
        <p>Every device that was signed in to your account has been signed out.</p>
        <Link className="btn primary" to="/">
          Sign in
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Choose a new password">
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setError(null);
          try {
            await api("/api/v1/auth/password/reset", { method: "POST", body: { token, password } });
            setDone(true);
          } catch (err) {
            setError(err);
          }
        }}
      >
        <PasswordField label="New password" value={password} onChange={setPassword} />
        <button className="btn primary" type="submit">
          Save password
        </button>
        <ErrorNotice error={error} />
      </form>
    </AuthShell>
  );
}

export function AcceptInvitePage() {
  const token = useLinkToken();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);

  if (!token) return <MissingToken />;
  return (
    <AuthShell title="Join the support team">
      <p className="muted" style={{ margin: 0 }}>
        Your team lead invited you. Choose a password to finish.
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setError(null);
          try {
            const session = await api<Session>("/api/v1/auth/invites/accept", {
              method: "POST",
              body: { token, password },
            });
            navigate("/", { replace: true });
            setSession(session);
          } catch (err) {
            setError(err);
          }
        }}
      >
        <PasswordField value={password} onChange={setPassword} />
        <button className="btn primary" type="submit">
          Start
        </button>
        <ErrorNotice error={error} />
      </form>
    </AuthShell>
  );
}
