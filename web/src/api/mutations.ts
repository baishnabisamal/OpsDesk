import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "./client";
import { keys } from "./queries";
import type { Message, Priority, Ticket, TicketStatus } from "./types";

// Changing a ticket: optimistic UI with version conflicts.
//
// Optimistic: the screen shows the change at once, before the server has
// answered. If the server refuses, the old value is put back.
//
// Version conflicts: every change sends the version the user was looking at
// (If-Match: "7"). If someone else changed the ticket since, the server
// answers 409 version_conflict and changes nothing. We then load the latest
// ticket and tell the user, with the option to apply their change again on
// top of it. Nothing is silently overwritten.

export type TicketChange =
  | { kind: "priority"; priority: Priority }
  | { kind: "subject"; subject: string }
  | { kind: "transition"; to: TicketStatus }
  | { kind: "assign"; assigneeId: string }
  | { kind: "intent"; intent: Ticket["intent"] };

function request(ticket: Ticket, change: TicketChange): Promise<Ticket> {
  const headers = { "If-Match": `"${ticket.version}"` };
  const base = `/api/v1/tickets/${ticket.id}`;
  switch (change.kind) {
    case "priority":
      return api(base, { method: "PATCH", headers, body: { priority: change.priority } });
    case "subject":
      return api(base, { method: "PATCH", headers, body: { subject: change.subject } });
    case "transition":
      return api(`${base}/transitions`, { method: "POST", headers, body: { to: change.to } });
    case "assign":
      return api(`${base}/assign`, {
        method: "POST",
        headers,
        body: { assignee_id: change.assigneeId },
      });
    case "intent":
      return api(`${base}/intent`, { method: "PUT", headers, body: { intent: change.intent } });
  }
}

// The guess shown while the request is in flight.
function optimistic(ticket: Ticket, change: TicketChange): Ticket {
  switch (change.kind) {
    case "priority":
      return { ...ticket, priority: change.priority };
    case "subject":
      return { ...ticket, subject: change.subject };
    case "transition":
      return { ...ticket, status: change.to };
    case "assign":
      return {
        ...ticket,
        assignee_id: change.assigneeId,
        status: ticket.status === "new" ? "open" : ticket.status,
      };
    case "intent":
      return { ...ticket, intent: change.intent, needs_review: false };
  }
}

export type Conflict = { change: TicketChange; latest: Ticket };

export function useTicketChange(ticketId: string) {
  const client = useQueryClient();
  const [conflict, setConflict] = useState<Conflict | null>(null);

  const mutation = useMutation({
    mutationFn: ({ ticket, change }: { ticket: Ticket; change: TicketChange }) =>
      request(ticket, change),

    onMutate: async ({ ticket, change }) => {
      setConflict(null);
      // Stop a refetch in flight from overwriting the optimistic value.
      await client.cancelQueries({ queryKey: keys.ticket(ticketId), exact: true });
      const previous = client.getQueryData<Ticket>(keys.ticket(ticketId));
      client.setQueryData(keys.ticket(ticketId), optimistic(ticket, change));
      return { previous };
    },

    onError: async (error, { change }, context) => {
      // Put the screen back the way it was.
      if (context?.previous) client.setQueryData(keys.ticket(ticketId), context.previous);
      if (error instanceof ApiError && error.code === "version_conflict") {
        const latest = await client.fetchQuery({
          queryKey: keys.ticket(ticketId),
          queryFn: () => api<Ticket>(`/api/v1/tickets/${ticketId}`),
          staleTime: 0,
        });
        setConflict({ change, latest });
      }
    },

    onSuccess: (saved) => {
      // The server's answer is the truth, including the new version.
      client.setQueryData(keys.ticket(ticketId), saved);
    },

    onSettled: () => {
      void client.invalidateQueries({ queryKey: keys.timeline(ticketId) });
      void client.invalidateQueries({ queryKey: ["queue"] });
      void client.invalidateQueries({ queryKey: ["tickets"] });
    },
  });

  return {
    change: (ticket: Ticket, change: TicketChange) => mutation.mutate({ ticket, change }),
    pending: mutation.isPending,
    // A version conflict is shown by its own banner, not as a plain error.
    error:
      mutation.error instanceof ApiError && mutation.error.code === "version_conflict"
        ? null
        : (mutation.error as Error | null),
    conflict,
    // "Apply my change again" on top of the latest version.
    retry: () => {
      if (conflict) mutation.mutate({ ticket: conflict.latest, change: conflict.change });
    },
    dismiss: () => setConflict(null),
  };
}

export function useAddMessage(ticketId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { body: string; visibility: "public" | "internal" }) =>
      api<Message>(`/api/v1/tickets/${ticketId}/messages`, { method: "POST", body: input }),
    onSuccess: (message) => {
      client.setQueryData<Message[]>(keys.messages(ticketId), (old) =>
        old && !old.some((m) => m.id === message.id) ? [...old, message] : old,
      );
      void client.invalidateQueries({ queryKey: keys.timeline(ticketId) });
      void client.invalidateQueries({ queryKey: keys.ticket(ticketId) });
    },
  });
}
