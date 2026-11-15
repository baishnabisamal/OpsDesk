import { describe, expect, it } from "vitest";

// Proves the toolchain works end to end: TypeScript compiles, Vitest finds
// and runs tests. Delete once real tests exist (Phase 1, step 3).
describe("toolchain", () => {
  it("runs a TypeScript test", () => {
    const sum: number = 1 + 1;
    expect(sum).toBe(2);
  });
});
