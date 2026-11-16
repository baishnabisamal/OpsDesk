import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../../src/core/circuitBreaker.js";

// A breaker with a clock the test controls: 3 failures open it for 1000 ms.
function setup() {
  let time = 0;
  const breaker = new CircuitBreaker(3, 1000, () => time);
  const advance = (ms: number) => {
    time += ms;
  };
  return { breaker, advance };
}

function fail(breaker: CircuitBreaker, times: number) {
  for (let i = 0; i < times; i++) breaker.recordFailure();
}

describe("circuit breaker", () => {
  it("starts closed and lets calls through", () => {
    const { breaker } = setup();
    expect(breaker.state).toBe("closed");
    expect(breaker.canRequest()).toBe(true);
  });

  it("stays closed below the failure threshold", () => {
    const { breaker } = setup();
    fail(breaker, 2);
    expect(breaker.state).toBe("closed");
    expect(breaker.canRequest()).toBe(true);
  });

  it("opens at the threshold and blocks calls", () => {
    const { breaker } = setup();
    fail(breaker, 3);
    expect(breaker.state).toBe("open");
    expect(breaker.canRequest()).toBe(false);
  });

  it("a success resets the failure count", () => {
    const { breaker } = setup();
    fail(breaker, 2);
    breaker.recordSuccess();
    fail(breaker, 2);
    expect(breaker.state).toBe("closed");
  });

  it("stays open until the wait is over", () => {
    const { breaker, advance } = setup();
    fail(breaker, 3);
    advance(999);
    expect(breaker.canRequest()).toBe(false);
  });

  it("after the wait, lets exactly one trial call through", () => {
    const { breaker, advance } = setup();
    fail(breaker, 3);
    advance(1000);

    expect(breaker.state).toBe("half_open");
    expect(breaker.canRequest()).toBe(true); // the trial
    expect(breaker.canRequest()).toBe(false); // everyone else still waits
  });

  it("closes when the trial call succeeds", () => {
    const { breaker, advance } = setup();
    fail(breaker, 3);
    advance(1000);
    breaker.canRequest();
    breaker.recordSuccess();

    expect(breaker.state).toBe("closed");
    expect(breaker.canRequest()).toBe(true);
    expect(breaker.canRequest()).toBe(true);
  });

  it("opens again for a full wait when the trial call fails", () => {
    const { breaker, advance } = setup();
    fail(breaker, 3);
    advance(1000);
    breaker.canRequest();
    breaker.recordFailure();

    expect(breaker.state).toBe("open");
    advance(999);
    expect(breaker.canRequest()).toBe(false);
    advance(1);
    expect(breaker.canRequest()).toBe(true);
  });

  it("reset closes it", () => {
    const { breaker } = setup();
    fail(breaker, 3);
    breaker.reset();
    expect(breaker.state).toBe("closed");
  });
});
