import { describe, expect, it } from "vitest";
import { orderPair, pickSimilar, SIMILARITY_THRESHOLD } from "../../src/domain/linkage.js";

describe("pickSimilar", () => {
  it("keeps scores at or above the threshold, best first", () => {
    const picked = pickSimilar([
      { id: "low", score: 0.2 },
      { id: "good", score: 0.7 },
      { id: "edge", score: SIMILARITY_THRESHOLD },
      { id: "best", score: 0.95 },
    ]);
    expect(picked.map((item) => item.id)).toEqual(["best", "good", "edge"]);
  });

  it("returns nothing when nothing is similar enough", () => {
    expect(pickSimilar([{ id: "a", score: 0.1 }])).toEqual([]);
    expect(pickSimilar([])).toEqual([]);
  });

  it("caps a score that is a hair above 1 because of rounding", () => {
    expect(pickSimilar([{ id: "same", score: 1.0000001 }])).toEqual([{ id: "same", score: 1 }]);
  });

  it("accepts a custom threshold", () => {
    expect(pickSimilar([{ id: "a", score: 0.3 }], 0.25).length).toBe(1);
  });
});

describe("orderPair", () => {
  it("puts the smaller id first, whichever way round it is given", () => {
    expect(orderPair("b", "a")).toEqual(["a", "b"]);
    expect(orderPair("a", "b")).toEqual(["a", "b"]);
  });
});
