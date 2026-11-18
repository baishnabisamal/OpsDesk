import type { NextFunction, Request, Response } from "express";
import { Redis } from "ioredis";
import { principalFromToken } from "./auth.js";
import { config } from "./config.js";
import { AppError } from "./errors.js";
import { logger } from "./logger.js";

// Rate limiting with a TOKEN BUCKET.
//
// Picture a bucket that holds up to `capacity` tokens and is refilled at
// `perSecond` tokens a second. Each request takes one token. An empty bucket
// means "too many requests": the client is told when the next token will be
// there (Retry-After). A full bucket allows a short burst, the refill rate
// sets the long-run limit.
//
// The bucket lives in Redis, so every API process shares it. The update is
// a Lua script: Redis runs a script from start to finish without running
// anything else in between, so "read tokens, check, write tokens" cannot be
// interleaved by two requests. Without that, 50 requests arriving together
// could all read "1 token left" and all pass.
//
// The script uses Redis's own clock (TIME), so several API servers with
// slightly different clocks still agree.

const TAKE_TOKEN_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local saved = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(saved[1])
local ts = tonumber(saved[2])
if tokens == nil then
  tokens = capacity
  ts = now
end

-- Refill for the time that passed, never above capacity.
tokens = math.min(capacity, tokens + math.max(0, now - ts) * rate / 1000)

local allowed = 0
local retry_ms = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry_ms = math.ceil((1 - tokens) * 1000 / rate)
end

redis.call('HSET', key, 'tokens', tostring(tokens), 'ts', now)
-- Forget the bucket once it would be full again anyway.
redis.call('PEXPIRE', key, math.ceil(capacity * 1000 / rate) + 1000)
return {allowed, math.floor(tokens), retry_ms}
`;

export type RateRule = {
  name: string;
  capacity: number;
  perSecond: number;
  // Which bucket this request uses, or null if the rule does not apply.
  key: (req: Request) => string | null;
};

type TakeTokenRedis = Redis & {
  takeToken(key: string, capacity: number, perSecond: number): Promise<[number, number, number]>;
};

// A Redis client that fails FAST: no queueing while disconnected, one try,
// 200 ms at most. A rate limiter that hangs when Redis is slow would turn a
// Redis problem into an outage of the whole API.
export function createLimiterRedis(host = config.redis.host, port = config.redis.port): Redis {
  const redis = new Redis({
    host,
    port,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 200,
  });
  // Without a listener, every failed reconnect would be an "unhandled error".
  redis.on("error", (err: Error) => logger.debug({ err }, "rate limiter Redis connection error"));
  return redis;
}

// Clients that already know the script (defineCommand once per client).
const scriptDefined = new WeakSet<Redis>();

export function createRateLimiter(redis: Redis, rules: RateRule[]) {
  if (!scriptDefined.has(redis)) {
    redis.defineCommand("takeToken", { numberOfKeys: 1, lua: TAKE_TOKEN_SCRIPT });
    scriptDefined.add(redis);
  }
  const client = redis as TakeTokenRedis;

  return async function rateLimit(req: Request, res: Response, next: NextFunction) {
    for (const rule of rules) {
      const bucket = rule.key(req);
      if (!bucket) continue;

      let result: [number, number, number];
      try {
        result = await client.takeToken(`rl:${rule.name}:${bucket}`, rule.capacity, rule.perSecond);
      } catch (err) {
        // FAIL OPEN. If Redis is down, let the request through and log it.
        // Being briefly unlimited is better than refusing every request:
        // ticket create must keep working without Redis (README section 3).
        logger.warn({ err, rule: rule.name }, "rate limiter unavailable, allowing request");
        next();
        return;
      }

      const [allowed, remaining, retryMs] = result;
      res.setHeader("RateLimit-Limit", rule.capacity);
      res.setHeader("RateLimit-Remaining", remaining);
      if (allowed !== 1) {
        const retryAfter = Math.max(1, Math.ceil(retryMs / 1000));
        res.setHeader("Retry-After", retryAfter);
        next(
          new AppError(
            429,
            "rate_limited",
            "Too many requests",
            `Limit "${rule.name}" reached. Try again in ${retryAfter} s.`,
          ),
        );
        return;
      }
    }
    next();
  };
}

// The rules the API uses. The caller is read from the access token here, a
// cheap signature check; routes still authenticate as usual. A request with
// no valid token is not limited here: the route answers 401 anyway.
function callerOf(req: Request) {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? principalFromToken(header.slice(7)) : null;
}

export function apiRules(): RateRule[] {
  const limits = config.rateLimit;
  return [
    {
      // Slows down password guessing, mass sign-ups and email flooding: per
      // IP address, on every POST /auth/* that a stranger can call except
      // refresh and logout (those need a valid token anyway).
      name: "login",
      capacity: limits.loginCapacity,
      perSecond: limits.loginPerSecond,
      key: (req) =>
        req.method === "POST" &&
        req.path.startsWith("/auth/") &&
        req.path !== "/auth/refresh" &&
        req.path !== "/auth/logout"
          ? (req.ip ?? "unknown")
          : null,
    },
    {
      name: "user",
      capacity: limits.userCapacity,
      perSecond: limits.userPerSecond,
      key: (req) => callerOf(req)?.userId ?? null,
    },
    {
      // One agency's users together; staff have no agency and skip this rule.
      name: "agency",
      capacity: limits.agencyCapacity,
      perSecond: limits.agencyPerSecond,
      key: (req) => callerOf(req)?.agencyId ?? null,
    },
  ];
}
