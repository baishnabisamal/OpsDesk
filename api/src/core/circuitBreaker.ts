// A circuit breaker stops calling a dependency that keeps failing.
//
// Without it, while the ML service is down every ticket create would wait
// the full timeout before giving up. With it, after a few failures in a row
// we stop trying for a short while and fail instantly instead.
//
// Three states:
//   closed     normal: every call goes through
//   open       the dependency looks dead: no calls for `openMs`
//   half-open  the wait is over: ONE trial call is let through.
//              If it works the breaker closes; if not it opens again.
//
// (The names come from electricity: an open circuit carries no current.)

export type BreakerState = "closed" | "open" | "half_open";

export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private trialInProgress = false;

  constructor(
    private readonly failureThreshold = 5,
    private readonly openMs = 10_000,
    // The clock is a parameter so tests can move time forward by hand.
    private readonly now: () => number = Date.now,
  ) {}

  get state(): BreakerState {
    if (this.openedAt === null) return "closed";
    return this.now() - this.openedAt >= this.openMs ? "half_open" : "open";
  }

  // Ask before every call. False means "do not even try".
  canRequest(): boolean {
    const state = this.state;
    if (state === "closed") return true;
    if (state === "open") return false;

    // Half-open: allow exactly one trial call at a time.
    if (this.trialInProgress) return false;
    this.trialInProgress = true;
    return true;
  }

  recordSuccess() {
    this.failures = 0;
    this.openedAt = null;
    this.trialInProgress = false;
  }

  recordFailure() {
    this.failures += 1;
    this.trialInProgress = false;
    if (this.failures >= this.failureThreshold) {
      // Open, or re-open after a failed trial: the wait starts again from now.
      this.openedAt = this.now();
    }
  }

  reset() {
    this.recordSuccess();
  }
}
