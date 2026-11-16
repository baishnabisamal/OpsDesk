import type { Intent } from "./enums.js";
import { normalise } from "./text.js";

// The cheap path: keyword rules that catch the obvious intents with no
// network call. The ML model is asked only when no rule fires.
//
// Rules are tried from top to bottom and the first match wins, so the order
// matters. "Booking was cancelled but the refund has not arrived" mentions
// both cancelling and a refund; the person wants the refund, so refund rules
// come before cancellation rules.

type Rule = { intent: Intent; name: string; pattern: RegExp };

const RULES: Rule[] = [
  {
    intent: "booking_not_found",
    name: "no_booking_at_hotel",
    pattern:
      /\b(booking|reservation) (is )?(not found|missing)\b|\bno (reservation|booking|record)\b|\b(cannot|can not|can t|could not|couldn t) find (the|our|any|a) (booking|reservation)\b/,
  },
  {
    intent: "payment",
    name: "charged_twice",
    pattern:
      /\b(charged|debited|billed) twice\b|\bdouble (charge|payment)\b|\bpayment (failed|declined)\b/,
  },
  {
    intent: "refund",
    name: "refund_words",
    pattern: /\brefund(s|ed)?\b|\bmoney back\b|\breimburse/,
  },
  {
    intent: "voucher",
    name: "voucher_words",
    pattern: /\bvoucher\b/,
  },
  {
    intent: "amendment",
    name: "change_request",
    pattern:
      /\b(change|amend|modify|correct|update) (of |the |our |a )?(guest|name|date|dates|stay|booking|room)\b|\bspelled wrong\b|\bname (change|correction)\b|\bamendment\b/,
  },
  {
    intent: "cancellation",
    name: "cancel_request",
    pattern: /\bcancel(s|led|ed|ling|ing|lation)?\b/,
  },
];

export type RuleMatch = { intent: Intent; rule: string };

// Returns the first rule that matches the subject or the body, or null when
// the text is not obvious and the model should be asked.
export function classifyByRules(subject: string, body: string): RuleMatch | null {
  const text = normalise(`${subject} ${body}`);
  for (const rule of RULES) {
    if (rule.pattern.test(text)) {
      return { intent: rule.intent, rule: rule.name };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Putting rule and model together
// ---------------------------------------------------------------------------

export type IntentSource = "rule" | "model" | "manual" | "fallback";

export type IntentDecision = {
  intent: Intent;
  source: IntentSource;
  confidence: number | null; // only when the model decided
  modelVersion: string | null; // only when the model decided
  needsReview: boolean; // true = a person should check this intent
};

// Below this probability the model's answer is kept but flagged for review.
export const MIN_MODEL_CONFIDENCE = 0.6;

type ModelPrediction = { intent: Intent; confidence: number; model_version: string };

// Decides the intent of a new ticket, in order of trust:
//   1. a keyword rule fired            -> use it
//   2. the model answered              -> use it, flag it when it is unsure
//   3. neither (ML down, slow, absent) -> 'other', flagged for review
export function decideIntent(
  rule: RuleMatch | null,
  prediction: ModelPrediction | null,
): IntentDecision {
  if (rule) {
    return {
      intent: rule.intent,
      source: "rule",
      confidence: null,
      modelVersion: null,
      needsReview: false,
    };
  }
  if (prediction) {
    return {
      intent: prediction.intent,
      source: "model",
      confidence: prediction.confidence,
      modelVersion: prediction.model_version,
      needsReview: prediction.confidence < MIN_MODEL_CONFIDENCE,
    };
  }
  return {
    intent: "other",
    source: "fallback",
    confidence: null,
    modelVersion: null,
    needsReview: true,
  };
}
