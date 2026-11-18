import { Redis } from "ioredis";
import { config } from "./config.js";

// All events go into one Redis Stream. A stream is an append-only log: each
// entry gets an id like "1731900000000-0" (time, then a counter), entries
// stay in order, and many readers can read the same entries.
export const EVENTS_STREAM = "opsdesk:events";

// Keep about the last 100,000 entries. "~" lets Redis trim in whole blocks,
// which is much cheaper than trimming to the exact number. The stream is not
// the record of truth (PostgreSQL is), so old entries can safely go.
export const STREAM_MAX_LENGTH = 100_000;

export function createRedis(): Redis {
  return new Redis({
    host: config.redis.host,
    port: config.redis.port,
    // Keep retrying a command while Redis is away instead of failing after
    // 20 tries. The callers decide what to do when it takes too long.
    maxRetriesPerRequest: null,
  });
}

// One event as it is stored in the stream.
export type StreamEvent = {
  streamId: string; // Redis's id for the entry
  eventId: string; // the outbox row id: the same on a re-publish, so consumers can drop duplicates
  type: string;
  ticketId: string;
  agencyId: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

// Redis returns an entry's fields as a flat list: [name, value, name, value...].
export function parseStreamEntry(streamId: string, fields: string[]): StreamEvent {
  const map = new Map<string, string>();
  for (let i = 0; i + 1 < fields.length; i += 2) map.set(fields[i]!, fields[i + 1]!);
  return {
    streamId,
    eventId: map.get("event_id") ?? "",
    type: map.get("type") ?? "",
    ticketId: map.get("ticket_id") ?? "",
    agencyId: map.get("agency_id") ?? "",
    payload: JSON.parse(map.get("payload") ?? "{}") as Record<string, unknown>,
    createdAt: map.get("created_at") ?? "",
  };
}
