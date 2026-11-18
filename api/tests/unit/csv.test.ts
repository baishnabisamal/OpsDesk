import { describe, expect, it } from "vitest";
import { csvCell, csvRow } from "../../src/domain/csv.js";

describe("csvCell", () => {
  it.each([
    ["plain", "plain"],
    ["with, comma", '"with, comma"'],
    ['say "hi"', '"say ""hi"""'],
    ["two\nlines", '"two\nlines"'],
    ["", ""],
    [42, "42"],
    [null, ""],
    [undefined, ""],
  ])("%j -> %j", (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  it("writes dates as ISO instants in UTC", () => {
    expect(csvCell(new Date("2026-11-16T09:30:00Z"))).toBe("2026-11-16T09:30:00.000Z");
  });

  it.each(["=SUM(A1:A9)", "+1", "-1", "@cmd", "\tx"])(
    "neutralises a cell that a spreadsheet would run as a formula: %j",
    (input) => {
      expect(csvCell(input).replace(/^"/, "").startsWith("'")).toBe(true);
    },
  );

  it("still quotes a neutralised formula that contains a comma", () => {
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
  });
});

describe("csvRow", () => {
  it("joins cells with commas and ends with CRLF", () => {
    expect(csvRow(["a", "b,c", null])).toBe('a,"b,c",\r\n');
  });
});
