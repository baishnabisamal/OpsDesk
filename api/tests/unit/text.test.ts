import { describe, expect, it } from "vitest";
import { extractTboh, normalise } from "../../src/domain/text.js";

describe("normalise", () => {
  it("lower-cases, removes punctuation and collapses spaces", () => {
    expect(normalise("  Refund   NOT received!!  ")).toBe("refund not received");
  });

  it("turns apostrophes and dashes into spaces", () => {
    expect(normalise("Can't find the check-in")).toBe("can t find the check in");
  });

  it("keeps letters from other languages and digits", () => {
    expect(normalise("Müller, Zimmer 42")).toBe("müller zimmer 42");
  });

  it("returns an empty string for punctuation only", () => {
    expect(normalise("?!...")).toBe("");
  });
});

describe("extractTboh", () => {
  it.each([
    ["Problem with TBOH1000042 at the hotel", "TBOH1000042"],
    ["problem with tboh1000042", "TBOH1000042"],
    ["Ref: TBOH 1000042.", "TBOH1000042"],
    ["TBOH: 1000042 guest turned away", "TBOH1000042"],
    ["TBOH#1000042", "TBOH1000042"],
    ["booking TBOH-9F3A2C1B is missing", "TBOH-9F3A2C1B"],
    ["(tboh-9f3a2c1b)", "TBOH-9F3A2C1B"],
  ])("finds the reference in %j", (text, expected) => {
    expect(extractTboh(text)).toBe(expected);
  });

  it.each([
    ["no reference here"],
    ["the TBOH number is missing"], // "number" has no digit
    ["TBOH 123"], // too short
    ["XTBOH1000042"], // TBOH must start a word
    [""],
  ])("returns null for %j", (text) => {
    expect(extractTboh(text)).toBeNull();
  });

  it("returns the first reference when there are two", () => {
    expect(extractTboh("TBOH1000001 and also TBOH1000002")).toBe("TBOH1000001");
  });
});
