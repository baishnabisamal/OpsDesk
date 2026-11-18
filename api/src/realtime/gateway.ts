import type { Server as HttpServer } from "node:http";
import type { Redis } from "ioredis";
import { Server } from "socket.io";
import { principalFromToken } from "../core/auth.js";
import { logger } from "../core/logger.js";
import { EVENTS_STREAM, parseStreamEntry } from "../core/redis.js";
import { isStaff, type Principal } from "../domain/enums.js";
import { agencyRoom, audienceFor, STAFF_ROOM } from "../domain/realtime.js";

// The WebSocket gateway: pushes events from the Redis Stream to browsers.
//
// Socket.IO is a WebSocket library with "rooms": a server can send to every
// connection in a room at once. Rooms map directly to "who may see this":
//   staff            every member of staff
//   agency:<id>      the requesters of one agency
//
// A connection's room is decided from its VERIFIED access token, never from
// anything the client says, and the event filter (domain/realtime.ts) uses
// the same rules as the API. The gateway cannot show more than the API would.
//
// Delivery is at-least-once (the relay may publish an event twice), so each
// event carries its event_id and clients drop ids they have already seen.

type SocketData = { principal: Principal };

export type TicketEventMessage = {
  event_id: string;
  type: string;
  ticket_id: string;
  payload: Record<string, unknown>;
  created_at: string;
};

export function createGateway(httpServer: HttpServer, redis: Redis) {
  const io = new Server<
    Record<string, never>,
    Record<string, never>,
    Record<string, never>,
    SocketData
  >(httpServer, { serveClient: false });

  // Runs once per connection attempt, before "connection". The browser sends
  // its access token in the handshake: io(url, { auth: { token } }).
  io.use((socket, next) => {
    const token = (socket.handshake.auth as { token?: unknown }).token;
    const principal = principalFromToken(typeof token === "string" ? token : undefined);
    if (!principal) {
      next(new Error("unauthorized"));
      return;
    }
    socket.data.principal = principal;
    next();
  });

  io.on("connection", (socket) => {
    const { principal } = socket.data;
    if (isStaff(principal.role)) {
      void socket.join(STAFF_ROOM);
    } else if (principal.agencyId) {
      void socket.join(agencyRoom(principal.agencyId));
    }
  });

  // Reading the stream. A plain XREAD, not a consumer group: every gateway
  // instance must see EVERY event, because each one has its own connected
  // browsers. (A consumer group would hand each event to only one of them.)
  let running = true;

  const readLoop = async () => {
    // Start after the newest entry that exists now. Old events are history;
    // a browser that connects loads current state through the API.
    const newest = await redis.xrevrange(EVENTS_STREAM, "+", "-", "COUNT", 1);
    let lastId = newest[0]?.[0] ?? "0-0";

    while (running) {
      try {
        // BLOCK: wait up to 1 s for new entries, then loop (so stop() is noticed).
        const reply = (await redis.xread(
          "COUNT",
          200,
          "BLOCK",
          1000,
          "STREAMS",
          EVENTS_STREAM,
          lastId,
        )) as [string, [string, string[]][]][] | null;

        for (const [streamId, fields] of reply?.[0]?.[1] ?? []) {
          lastId = streamId;
          const event = parseStreamEntry(streamId, fields);
          const message: TicketEventMessage = {
            event_id: event.eventId,
            type: event.type,
            ticket_id: event.ticketId,
            payload: event.payload,
            created_at: event.createdAt,
          };
          io.to(STAFF_ROOM).emit("ticket_event" as never, message as never);
          if (audienceFor(event.type, event.payload) === "everyone") {
            io.to(agencyRoom(event.agencyId)).emit("ticket_event" as never, message as never);
          }
        }
      } catch (err) {
        if (!running) break;
        logger.warn({ err }, "gateway stream read failed");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  };
  const done = readLoop();

  return {
    io,
    async close() {
      running = false;
      // Interrupt the blocking XREAD instead of waiting up to a second.
      redis.disconnect();
      await done;
      await io.close();
    },
  };
}
