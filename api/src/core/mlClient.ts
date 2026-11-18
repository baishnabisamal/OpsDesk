import { z } from "zod";
import { INTENTS } from "../domain/enums.js";
import { CircuitBreaker } from "./circuitBreaker.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

// The Node side of the ML boundary.
//
// The one promise this file makes: it NEVER throws and never takes longer
// than the timeout. Every function returns null when the ML service is down,
// slow, or answers nonsense, and the caller carries on without it.
// That is how "the model can never block a ticket" is kept.

// 5 failures in a row open the breaker; after 10 s one trial call is allowed.
export const mlBreaker = new CircuitBreaker(5, 10_000);

// The answers are checked like any other outside input.
const classifyResponse = z.object({
  intent: z.enum(INTENTS),
  confidence: z.number().min(0).max(1),
  model_version: z.string().min(1).max(100),
});

const similarityResponse = z.object({
  scores: z.array(z.object({ id: z.string(), score: z.number() })),
});

export type Prediction = z.infer<typeof classifyResponse>;
export type SimilarityScore = { id: string; score: number };

// `options` exist for the weekly clustering job: it runs in the background,
// may take seconds, and must not trip the breaker that protects ticket create.
async function post<T>(
  path: string,
  body: object,
  schema: z.ZodType<T>,
  options: { timeoutMs?: number; useBreaker?: boolean } = {},
): Promise<T | null> {
  const useBreaker = options.useBreaker ?? true;
  if (useBreaker && !mlBreaker.canRequest()) {
    return null; // breaker is open: fail instantly, do not touch the network
  }

  try {
    const response = await fetch(`${config.ml.url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-ML-Secret": config.ml.sharedSecret },
      body: JSON.stringify(body),
      // Cancels the request, and rejects, when the time is up.
      signal: AbortSignal.timeout(options.timeoutMs ?? config.ml.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`ML service answered ${response.status}`);
    }
    const parsed = schema.parse(await response.json());
    if (useBreaker) mlBreaker.recordSuccess();
    return parsed;
  } catch (err) {
    if (useBreaker) mlBreaker.recordFailure();
    logger.warn({ path, reason: (err as Error).message }, "ML call failed, using fallback");
    return null;
  }
}

// The model sees one string: subject on the first line, then the body.
// ml/model.py joins its training data the same way.
export function joinText(subject: string, body: string): string {
  return `${subject}\n${body}`;
}

export function classify(text: string): Promise<Prediction | null> {
  return post("/classify", { text }, classifyResponse);
}

export async function similarity(
  text: string,
  candidates: { id: string; text: string }[],
): Promise<SimilarityScore[] | null> {
  if (candidates.length === 0) return [];
  const result = await post("/similarity", { text, candidates }, similarityResponse);
  return result ? result.scores : null;
}

const clusterResponse = z.object({
  clusters: z.array(
    z.object({
      label: z.string(),
      terms: z.array(z.string()),
      size: z.number().int().nonnegative(),
      ticket_ids: z.array(z.string()),
    }),
  ),
});

export type Cluster = z.infer<typeof clusterResponse>["clusters"][number];

// Groups a week's tickets into themes. Background work: a generous timeout,
// and outside the circuit breaker that guards ticket create.
export async function clusterThemes(
  tickets: { id: string; text: string }[],
): Promise<Cluster[] | null> {
  const result = await post("/themes/cluster", { tickets }, clusterResponse, {
    timeoutMs: 30_000,
    useBreaker: false,
  });
  return result ? result.clusters : null;
}
