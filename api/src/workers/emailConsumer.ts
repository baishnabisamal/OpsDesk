import type { Redis } from "ioredis";
import type { Transporter } from "nodemailer";
import { EVENTS_STREAM, parseStreamEntry, type StreamEvent } from "../core/redis.js";
import { logger } from "../core/logger.js";
import { tx } from "../db/tx.js";
import { SYSTEM_PRINCIPAL } from "../domain/enums.js";
import { deliverSideMessage, type DeliveryOptions } from "../services/emailService.js";

// Reads the event stream as a CONSUMER GROUP and sends the emails.
//
// A consumer group shares a stream among several workers: Redis hands each
// entry to ONE worker in the group, and remembers it as "pending" until that
// worker acknowledges it (XACK). If a worker dies before XACK, the entry
// stays pending; another worker claims it after a while (XAUTOCLAIM) and
// tries again. That is at-least-once delivery, made safe by the claim in
// email_deliveries.

export const EMAIL_GROUP = "email";

type StreamReply = [string, [string, string[]][]][] | null;

// Creates the group if it does not exist yet. "0" = start from the first
// entry in the stream; "$" = only entries added from now on.
export async function ensureGroup(redis: Redis, group: string, startId = "0") {
  try {
    await redis.xgroup("CREATE", EVENTS_STREAM, group, startId, "MKSTREAM");
  } catch (err) {
    if (!(err as Error).message.includes("BUSYGROUP")) throw err; // BUSYGROUP = already exists
  }
}

export type ConsumerOptions = {
  group?: string;
  consumer: string; // this worker's name within the group
  blockMs?: number; // how long one read waits for new entries
  minIdleMs?: number; // how long an entry must sit unacknowledged before others may take it
  maxDeliveries?: number; // after this many tries, give up and store a dead letter
  count?: number; // how many entries one round reads at most (default 50)
  delivery?: DeliveryOptions;
};

export type ConsumerResult = {
  handled: number;
  failed: number;
  deadLettered: number;
  inProgress: number;
};

function isEmailEvent(event: StreamEvent): boolean {
  return event.type === "side_message.created" && event.payload.direction === "outbound";
}

async function deadLetter(event: StreamEvent, error: Error, attempts: number) {
  await tx(SYSTEM_PRINCIPAL, async (db) => {
    await db.query(
      `INSERT INTO dead_letter_jobs (queue, job_name, payload, error, attempts)
       VALUES ('email', 'side_message.created', $1, $2, $3)`,
      [JSON.stringify(event.payload), error.message.slice(0, 1000), attempts],
    );
  });
}

// One round: first take over entries another worker left unacknowledged,
// then read new ones. Returns what happened.
export async function runEmailConsumerOnce(
  redis: Redis,
  transport: Transporter,
  options: ConsumerOptions,
): Promise<ConsumerResult> {
  const group = options.group ?? EMAIL_GROUP;
  const maxDeliveries = options.maxDeliveries ?? 5;
  const result: ConsumerResult = { handled: 0, failed: 0, deadLettered: 0, inProgress: 0 };

  // 1. Entries pending longer than minIdleMs (their worker probably died).
  const [, stale] = (await redis.xautoclaim(
    EVENTS_STREAM,
    group,
    options.consumer,
    options.minIdleMs ?? 60_000,
    "0-0",
    "COUNT",
    options.count ?? 50,
  )) as [string, [string, string[]][]];

  // 2. New entries.
  const fresh = (await redis.xreadgroup(
    "GROUP",
    group,
    options.consumer,
    "COUNT",
    options.count ?? 50,
    "BLOCK",
    options.blockMs ?? 1000,
    "STREAMS",
    EVENTS_STREAM,
    ">",
  )) as StreamReply;

  const entries = [...stale, ...(fresh?.[0]?.[1] ?? [])].filter(
    // XAUTOCLAIM returns null fields for entries trimmed from the stream.
    (entry): entry is [string, string[]] => Array.isArray(entry[1]),
  );

  for (const [streamId, fields] of entries) {
    const event = parseStreamEntry(streamId, fields);
    try {
      if (isEmailEvent(event)) {
        const delivery = await deliverSideMessage(
          transport,
          String(event.payload.side_message_id),
          options.delivery,
        );
        if (delivery.inProgress > 0) {
          // Someone else holds a lease on one of the emails, or died holding
          // it. Do NOT acknowledge: the entry stays pending and comes back
          // after minIdleMs, by which time the lease has run out. Acknowledging
          // now could lose the email for good.
          result.inProgress += 1;
          continue;
        }
      }
      // Acknowledge only after the work is done.
      await redis.xack(EVENTS_STREAM, group, streamId);
      result.handled += 1;
    } catch (err) {
      result.failed += 1;
      // How many times has this entry been handed out? XPENDING tells us.
      const pending = (await redis.xpending(EVENTS_STREAM, group, streamId, streamId, 1)) as [
        string,
        string,
        number,
        number,
      ][];
      const deliveries = pending[0]?.[3] ?? 1;
      logger.warn({ err, streamId, deliveries }, "email delivery failed");
      if (deliveries >= maxDeliveries) {
        await deadLetter(event, err as Error, deliveries);
        await redis.xack(EVENTS_STREAM, group, streamId); // stop retrying
        result.deadLettered += 1;
      }
      // Otherwise leave it pending; a later round takes it over and retries.
    }
  }
  return result;
}

// The worker process runs this for ever.
export function startEmailConsumer(redis: Redis, transport: Transporter, consumer: string) {
  let running = true;
  const loop = async () => {
    await ensureGroup(redis, EMAIL_GROUP);
    while (running) {
      try {
        await runEmailConsumerOnce(redis, transport, { consumer });
      } catch (err) {
        logger.error({ err }, "email consumer round failed");
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  };
  const done = loop();
  return async function stop() {
    running = false;
    await done;
  };
}
