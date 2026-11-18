import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api, query } from "./client";
import type {
  CaseView,
  LinkedTicket,
  Message,
  Page,
  SideConversation,
  StaffMember,
  Ticket,
  TimelineEvent,
  WeeklyThemes,
} from "./types";

// Server state lives in TanStack Query, not in React state. Every piece of
// data has a key; anything that changes it (a mutation, a live event) only
// has to say which keys are stale, and the screens refetch on their own.

export const keys = {
  ticket: (id: string) => ["ticket", id] as const,
  messages: (id: string) => ["ticket", id, "messages"] as const,
  timeline: (id: string) => ["ticket", id, "timeline"] as const,
  links: (id: string) => ["ticket", id, "links"] as const,
  sides: (id: string) => ["ticket", id, "sides"] as const,
  side: (id: string) => ["side", id] as const,
  case: (id: string) => ["case", id] as const,
  queue: (name: string, filters: object) => ["queue", name, filters] as const,
  tickets: (filters: object) => ["tickets", filters] as const,
  staff: ["staff"] as const,
  themes: (week: string) => ["themes", week] as const,
};

export function useTicket(id: string) {
  return useQuery({
    queryKey: keys.ticket(id),
    queryFn: () => api<Ticket>(`/api/v1/tickets/${id}`),
  });
}

export function useMessages(id: string) {
  return useQuery({
    queryKey: keys.messages(id),
    queryFn: async () => (await api<{ items: Message[] }>(`/api/v1/tickets/${id}/messages`)).items,
  });
}

export function useTimeline(id: string) {
  return useQuery({
    queryKey: keys.timeline(id),
    queryFn: async () =>
      (await api<{ items: TimelineEvent[] }>(`/api/v1/tickets/${id}/timeline`)).items,
  });
}

export function useLinks(id: string) {
  return useQuery({
    queryKey: keys.links(id),
    queryFn: async () =>
      (await api<{ items: LinkedTicket[] }>(`/api/v1/tickets/${id}/links`)).items,
  });
}

export function useSideConversations(id: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.sides(id),
    enabled,
    queryFn: async () =>
      (await api<{ items: SideConversation[] }>(`/api/v1/tickets/${id}/side-conversations`)).items,
  });
}

export function useSideConversation(id: string | null) {
  return useQuery({
    queryKey: keys.side(id ?? "none"),
    enabled: id !== null,
    queryFn: () => api<SideConversation>(`/api/v1/side-conversations/${id}`),
  });
}

export function useCase(id: string | undefined) {
  return useQuery({
    queryKey: keys.case(id ?? "none"),
    enabled: id !== undefined,
    queryFn: () => api<CaseView>(`/api/v1/cases/${id}`),
  });
}

// The staff list rarely changes; one fetch per minute is plenty.
export function useStaff(enabled: boolean) {
  return useQuery({
    queryKey: keys.staff,
    enabled,
    staleTime: 60_000,
    queryFn: async () => (await api<{ items: StaffMember[] }>("/api/v1/staff")).items,
  });
}

export type QueueFilters = { region?: string; intent?: string; sla_state?: string };

// Keyset paging: each page brings the cursor for the next one.
export function useQueue(name: string, filters: QueueFilters) {
  return useInfiniteQuery({
    queryKey: keys.queue(name, filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api<Page<Ticket>>(
        `/api/v1/queues/${name}${query({ ...filters, limit: 50, cursor: pageParam })}`,
      ),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
}

export type TicketFilters = {
  q?: string;
  status?: string;
  priority?: string;
  intent?: string;
  needs_review?: string;
};

export function useTickets(filters: TicketFilters) {
  return useInfiniteQuery({
    queryKey: keys.tickets(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api<Page<Ticket>>(`/api/v1/tickets${query({ ...filters, limit: 30, cursor: pageParam })}`),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
}

export function useThemes(week: string) {
  return useQuery({
    queryKey: keys.themes(week),
    retry: false, // a 404 means "not computed yet", not a glitch
    queryFn: () => api<WeeklyThemes>(`/api/v1/insights/themes${query({ week })}`),
  });
}
