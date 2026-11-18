import type { Session } from "./types";

// The one place the browser talks to the API.
//
// - Adds the access token to every request.
// - When the API answers 401 (the 15-minute access token expired), swaps the
//   refresh token for a new pair ONCE and repeats the request. If several
//   requests fail at the same moment they share one refresh call: refresh
//   tokens are single-use, so two parallel refreshes would look like token
//   theft to the server and end the whole session.
// - Turns problem+json error bodies into an ApiError with the stable `code`.

const STORAGE_KEY = "opsdesk.session";

export class ApiError extends Error {
  status: number;
  code: string;
  detail: string;
  requestId: string | null;
  retryAfter: number | null;

  constructor(status: number, body: Record<string, unknown>, headers?: Headers) {
    const title = typeof body.title === "string" ? body.title : `HTTP ${status}`;
    super(title);
    this.status = status;
    this.code = typeof body.code === "string" ? body.code : "unknown";
    this.detail = typeof body.detail === "string" ? body.detail : title;
    this.requestId = typeof body.request_id === "string" ? body.request_id : null;
    const retry = headers?.get("Retry-After");
    this.retryAfter = retry ? Number(retry) : null;
  }
}

// ---------------------------------------------------------------------------
// Session storage, with listeners so React can follow login and logout.
// ---------------------------------------------------------------------------
// Kept in localStorage so a reload stays logged in. The trade-off: any script
// running on the page could read it. Acceptable for a local demo; a real
// deployment would keep the refresh token in an HttpOnly cookie instead.

type Listener = (session: Session | null) => void;
const listeners = new Set<Listener>();

function readStored(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

let current: Session | null = readStored();

export function getSession(): Session | null {
  return current;
}

export function setSession(session: Session | null) {
  current = session;
  try {
    if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private mode or blocked storage: the session simply lasts until reload.
  }
  for (const listener of listeners) listener(session);
}

export function onSessionChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

type Options = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  // Return the Response untouched (used by the CSV download).
  raw?: boolean;
};

let refreshing: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  const refreshToken = current?.refresh_token;
  if (!refreshToken) return false;
  const res = await fetch("/api/v1/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!res.ok) {
    setSession(null);
    return false;
  }
  setSession((await res.json()) as Session);
  return true;
}

// Every caller waiting on a refresh gets the same promise.
function refreshOnce(): Promise<boolean> {
  refreshing ??= refreshSession().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function send(path: string, options: Options): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (current) headers.Authorization = `Bearer ${current.access_token}`;
  return fetch(path, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

export async function apiRaw(path: string, options: Options = {}): Promise<Response> {
  let res = await send(path, options);
  if (res.status === 401 && current && !path.startsWith("/api/v1/auth/")) {
    if (await refreshOnce()) res = await send(path, options);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body as Record<string, unknown>, res.headers);
  }
  return res;
}

export async function api<T>(path: string, options: Options = {}): Promise<T> {
  const res = await apiRaw(path, options);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// Builds "?a=1&b=2", leaving out empty values.
export function query(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export async function login(email: string, password: string): Promise<Session> {
  const session = await api<Session>("/api/v1/auth/login", {
    method: "POST",
    body: { email, password },
  });
  setSession(session);
  return session;
}

export async function logout() {
  const refreshToken = current?.refresh_token;
  setSession(null);
  if (refreshToken) {
    // Best effort: the local session is gone either way.
    await api("/api/v1/auth/logout", {
      method: "POST",
      body: { refresh_token: refreshToken },
    }).catch(() => undefined);
  }
}
