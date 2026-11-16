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

async function post<T>(path: string, body: object, schema: z.ZodType<T>): Promise<T | null> {
  if (!mlBreaker.canRequest()) {
    return null; // breaker is open: fail instantly, do not touch the network
  }

  try {
    const response = await fetch(`${config.ml.url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-ML-Secret": config.ml.sharedSecret },
      body: JSON.stringify(body),
      // Cancels the request, and rejects, when the time is up.
      signal: AbortSignal.timeout(config.ml.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`ML service answered ${response.status}`);
    }
    const parsed = schema.parse(await response.json());
    mlBreaker.recordSuccess();
    return parsed;
  } catch (err) {
    mlBreaker.recordFailure();
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
