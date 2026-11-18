import { describe, expect, it } from "vitest";
import { duration, initials, relative, slaReading } from "./format";
import { nextStatuses, transitionLabel } from "./rules";
import { mondayOf } from "../pages/InsightsPage";

const MIN = 60_000;

describe("duration", () => {
  it("uses minutes, then hours and minutes, then days", () => {
    expect(duration(30 * 1000)).toBe("<1m");
    expect(duration(45 * MIN)).toBe("45m");
    expect(duration(125 * MIN)).toBe("2h 5m");
    expect(duration(120 * MIN)).toBe("2h");
    expect(duration(47 * 60 * MIN)).toBe("47h");
    expect(duration((3 * 24 + 4) * 60 * MIN)).toBe("3d 4h");
  });

  it("ignores the sign", () => {
    expect(duration(-90 * MIN)).toBe("1h 30m");
  });
});

describe("relative", () => {
  it("says in or ago", () => {
    const now = Date.parse("2026-11-19T12:00:00Z");
    expect(relative("2026-11-19T14:00:00Z", now)).toBe("in 2h");
    expect(relative("2026-11-19T11:00:00Z", now)).toBe("1h ago");
  });
});

describe("slaReading", () => {
  const base = {
    created_at: "2026-11-19T10:00:00Z",
    sla_due_at: "2026-11-19T14:00:00Z",
    sla_paused_at: null,
    status: "open" as const,
  };

  it("shows time left and the share of time used", () => {
    const reading = slaReading(base, Date.parse("2026-11-19T11:00:00Z"));
    expect(reading.text).toBe("3h left");
    expect(reading.usedFraction).toBeCloseTo(0.25);
  });

  it("shows how late a ticket is, with the bar full", () => {
    const reading = slaReading(base, Date.parse("2026-11-19T15:30:00Z"));
    expect(reading.text).toBe("overdue 1h 30m");
    expect(reading.usedFraction).toBe(1);
  });

  it("stops the clock while pending", () => {
    const paused = { ...base, status: "pending" as const, sla_paused_at: "2026-11-19T12:00:00Z" };
    // Hours later, the reading is still the one from the moment it paused.
    const reading = slaReading(paused, Date.parse("2026-11-19T20:00:00Z"));
    expect(reading.text).toBe("paused, 2h left");
    expect(reading.usedFraction).toBeCloseTo(0.5);
  });

  it("is done once resolved", () => {
    expect(slaReading({ ...base, status: "resolved" }).text).toBe("done");
  });
});

describe("initials", () => {
  it("takes the first letter of the first two words", () => {
    expect(initials("Priya Raman")).toBe("PR");
    expect(initials("  omar  ")).toBe("O");
    expect(initials("Ana Maria de Souza")).toBe("AM");
  });
});

describe("buttons from the transition table", () => {
  it("shows staff the moves of an open ticket", () => {
    expect(nextStatuses("open", "agent")).toEqual(["pending", "escalated", "resolved"]);
  });

  it("lets only senior staff move an escalated ticket", () => {
    expect(nextStatuses("escalated", "agent")).toEqual([]);
    expect(nextStatuses("escalated", "escalation_manager")).toEqual(["open", "resolved"]);
  });

  it("lets a requester reopen or close a resolved ticket, and nothing else", () => {
    expect(nextStatuses("resolved", "requester")).toEqual(["open", "closed"]);
    expect(nextStatuses("open", "requester")).toEqual([]);
  });

  it("has no button for new (assigning opens it) or closed", () => {
    expect(nextStatuses("new", "lead")).toEqual([]);
    expect(nextStatuses("closed", "lead")).toEqual([]);
  });

  it("names the action, not the target state", () => {
    expect(transitionLabel("resolved", "open")).toBe("Reopen");
    expect(transitionLabel("escalated", "open")).toBe("De-escalate");
    expect(transitionLabel("open", "pending")).toBe("Wait on customer");
  });
});

describe("mondayOf", () => {
  it("finds the Monday of the week in UTC", () => {
    expect(mondayOf(new Date("2026-11-19T12:00:00Z"))).toBe("2026-11-16"); // Thursday
    expect(mondayOf(new Date("2026-11-16T00:00:00Z"))).toBe("2026-11-16"); // Monday
    expect(mondayOf(new Date("2026-11-22T23:59:00Z"))).toBe("2026-11-16"); // Sunday
  });
});
