import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSession } from "./client";
import { useTicketChange } from "./mutations";
import { keys } from "./queries";
import type { Ticket } from "./types";

// Optimistic UI with version conflicts, tested with a fake fetch.

const ticket = {
  id: "t1",
  subject: "Refund not received",
  priority: "normal",
  status: "open",
  version: 3,
} as Ticket;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

let fetchMock: ReturnType<typeof vi.fn>;
let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(keys.ticket("t1"), ticket);
  setSession({
    access_token: "a",
    refresh_token: "r",
    expires_in: 900,
    user: { id: "u1", email: "", full_name: "", role: "agent", agency_id: null, team_id: null },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  setSession(null);
});

const ifMatchOf = (call: unknown[]) =>
  (call[1] as { headers: Record<string, string> }).headers["If-Match"];

describe("useTicketChange", () => {
  it("shows the change at once, then keeps the server's answer", async () => {
    let answer!: (res: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => (answer = resolve)));
    fetchMock.mockResolvedValue(json(200, { items: [] })); // later refetches

    const { result } = renderHook(() => useTicketChange("t1"), { wrapper });
    act(() => result.current.change(ticket, { kind: "priority", priority: "urgent" }));

    // Before the server answers, the screen already says urgent.
    await waitFor(() =>
      expect(client.getQueryData<Ticket>(keys.ticket("t1"))?.priority).toBe("urgent"),
    );
    expect(ifMatchOf(fetchMock.mock.calls[0]!)).toBe('"3"');

    answer(json(200, { ...ticket, priority: "urgent", version: 4 }));
    await waitFor(() => expect(client.getQueryData<Ticket>(keys.ticket("t1"))?.version).toBe(4));
  });

  it("on a version conflict: puts the latest ticket on screen and offers a retry on top of it", async () => {
    const latest = { ...ticket, status: "pending", version: 5 };
    fetchMock
      .mockResolvedValueOnce(json(409, { code: "version_conflict", title: "Conflict" }))
      .mockResolvedValueOnce(json(200, latest)) // GET after the conflict
      .mockResolvedValueOnce(json(200, { ...latest, priority: "urgent", version: 6 })) // the retry
      .mockResolvedValue(json(200, { items: [] }));

    const { result } = renderHook(() => useTicketChange("t1"), { wrapper });
    act(() => result.current.change(ticket, { kind: "priority", priority: "urgent" }));

    await waitFor(() => expect(result.current.conflict).not.toBeNull());
    // The optimistic "urgent" was rolled back; the screen shows their version.
    expect(client.getQueryData<Ticket>(keys.ticket("t1"))).toMatchObject({
      priority: "normal",
      status: "pending",
      version: 5,
    });
    // A conflict is not shown as a plain error.
    expect(result.current.error).toBeNull();

    act(() => result.current.retry());
    await waitFor(() => expect(client.getQueryData<Ticket>(keys.ticket("t1"))?.version).toBe(6));
    expect(ifMatchOf(fetchMock.mock.calls[2]!)).toBe('"5"');
    expect(result.current.conflict).toBeNull();
  });

  it("on any other refusal: rolls back and reports the error", async () => {
    fetchMock
      .mockResolvedValueOnce(json(403, { code: "forbidden", title: "Forbidden", detail: "No." }))
      .mockResolvedValue(json(200, { items: [] }));

    const { result } = renderHook(() => useTicketChange("t1"), { wrapper });
    act(() => result.current.change(ticket, { kind: "transition", to: "resolved" }));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(client.getQueryData<Ticket>(keys.ticket("t1"))?.status).toBe("open");
    expect(result.current.conflict).toBeNull();
  });
});
