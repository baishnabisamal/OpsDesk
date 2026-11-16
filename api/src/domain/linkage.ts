// Pure rules for linking tickets. No I/O.

// Two tickets on different bookings are linked automatically when their text
// similarity (0 = nothing in common, 1 = same words) is at least this.
export const SIMILARITY_THRESHOLD = 0.5;

// How far back, and how many, tickets are compared with a new one.
export const CANDIDATE_WINDOW_DAYS = 14;
export const MAX_CANDIDATES = 10;

export type SimilarTicket = { id: string; score: number };

// Keeps the scores that are high enough, best first.
export function pickSimilar(
  scores: SimilarTicket[],
  threshold = SIMILARITY_THRESHOLD,
): SimilarTicket[] {
  return scores
    .filter((item) => item.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .map((item) => ({ id: item.id, score: Math.min(1, item.score) }));
}

// A link has no direction, so a pair is always stored smaller id first.
// Then "A linked to B" and "B linked to A" are the same row.
export function orderPair(first: string, second: string): [string, string] {
  return first < second ? [first, second] : [second, first];
}
