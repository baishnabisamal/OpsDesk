import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, getSession, query, setSession } from "./client";
import type { Session } from "./types";

// The API client with a fake fetch: no server needed.

function session(access: string, refresh: string): Session {
  return {
    access_token: access,
    refresh_token: refresh,
    expires_in: 900,
    user: {
      id: "u1",
      email: "a@test.example",
      full_name: "Test User",
      role: "agent",
      agency_id: null,
      team_id: null,
    },
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  setSession(session("old-access", "refresh-1"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  setSession(null);
});

const authOf = (call: unknown[]) =>
  (call[1] as { headers: Record<string, string> }).headers.Authorization;

describe("api()", () => {
  it("sends the access token", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ok: true }));
    await api("/api/v1/tickets");
    expect(authOf(fetchMock.mock.calls[0]!)).toBe("Bearer old-access");
  });

  it("on 401 refreshes once and repeats the request with the new token", async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, { code: "unauthorized" }))
      .mockResolvedValueOnce(json(200, session("new-access", "refresh-2")))
      .mockResolvedValueOnce(json(200, { items: [] }));

    await expect(api("/api/v1/tickets")).resolves.toEqual({ items: [] });
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/v1/auth/refresh");
    expect(authOf(fetchMock.mock.calls[2]!)).toBe("Bearer new-access");
    expect(getSession()?.refresh_token).toBe("refresh-2");
  });

  it("parallel 401s share ONE refresh (refresh tokens are single-use)", async () => {
    let refreshCalls = 0;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url === "/api/v1/auth/refresh") {
        refreshCalls++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return json(200, session("new-access", "refresh-2"));
      }
      const auth = (init.headers as Record<string, string>).Authorization;
      return auth === "Bearer new-access" ? json(200, { ok: url }) : json(401, {});
    });

    const results = await Promise.all([api("/a"), api("/b"), api("/c")]);
    expect(results).toEqual([{ ok: "/a" }, { ok: "/b" }, { ok: "/c" }]);
    expect(refreshCalls).toBe(1);
  });

  it("logs out when the refresh is refused", async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, {}))
      .mockResolvedValueOnce(json(401, { code: "invalid_refresh_token" }));

    await expect(api("/api/v1/tickets")).rejects.toBeInstanceOf(ApiError);
    expect(getSession()).toBeNull();
  });

  it("turns problem+json into an ApiError with the stable code", async () => {
    fetchMock.mockResolvedValueOnce(
      json(409, {
        title: "Conflict",
        status: 409,
        code: "version_conflict",
        detail: "The ticket was changed by someone else.",
        request_id: "req_1",
      }),
    );
    const error = await api("/api/v1/tickets/x").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: "version_conflict",
      requestId: "req_1",
    });
  });

  it("reads Retry-After on 429", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: "rate_limited" }), {
        status: 429,
        headers: { "Retry-After": "7" },
      }),
    );
    const error = (await api("/x").catch((err: unknown) => err)) as ApiError;
    expect(error.retryAfter).toBe(7);
  });
});

describe("query()", () => {
  it("leaves out empty values", () => {
    expect(query({ a: "1", b: "", c: undefined, d: null, e: 0 })).toBe("?a=1&e=0");
    expect(query({})).toBe("");
  });
});
