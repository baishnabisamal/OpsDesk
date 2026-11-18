import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { io } from "socket.io-client";
import { getSession } from "./api/client";
import { keys } from "./api/queries";
import type { LiveEvent } from "./api/types";

// Live updates from the realtime gateway (api/src/realtime).
//
// The gateway pushes "ticket_event" messages. We do not patch data from the
// event itself; we only mark the affected queries stale, and TanStack Query
// refetches what is on screen. The API stays the single source of truth,
// and the visibility rules (internal notes) are applied by the API as usual.
//
// Delivery is at-least-once, so an event_id seen before is ignored.

export type LiveStatus = "connecting" | "live" | "offline";

export function useLiveUpdates(enabled: boolean): LiveStatus {
  const client = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>("connecting");

  useEffect(() => {
    if (!enabled) return;
    const seen = new Set<string>();

    const socket = io({
      path: "/socket.io",
      // Read the token at every (re)connect: it is refreshed every 15 minutes.
      auth: (send) => send({ token: getSession()?.access_token }),
      transports: ["websocket"],
    });

    socket.on("connect", () => setStatus("live"));
    socket.on("disconnect", () => setStatus("offline"));
    socket.on("connect_error", () => setStatus("offline"));

    // Queue lists can get many events per second; refetch them at most
    // once every 800 ms.
    let queueTimer: ReturnType<typeof setTimeout> | null = null;
    const refreshLists = () => {
      if (queueTimer) return;
      queueTimer = setTimeout(() => {
        queueTimer = null;
        void client.invalidateQueries({ queryKey: ["queue"] });
        void client.invalidateQueries({ queryKey: ["tickets"] });
      }, 800);
    };

    socket.on("ticket_event", (event: LiveEvent) => {
      if (seen.has(event.event_id)) return;
      seen.add(event.event_id);
      if (seen.size > 2000) seen.clear();

      // Everything under ["ticket", id]: the ticket, messages, timeline, links.
      void client.invalidateQueries({ queryKey: keys.ticket(event.ticket_id) });
      if (event.type.startsWith("side_")) {
        void client.invalidateQueries({ queryKey: ["side"] });
      }
      refreshLists();
    });

    return () => {
      if (queueTimer) clearTimeout(queueTimer);
      socket.disconnect();
    };
  }, [enabled, client]);

  return enabled ? status : "offline";
}
