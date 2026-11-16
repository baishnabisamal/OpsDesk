import { describe, expect, it } from "vitest";
import {
  filterAgents,
  isOnShift,
  planRouting,
  rankAgents,
  scoreAgent,
  type AgentSnapshot,
  type Shift,
} from "../../src/domain/routing.js";

// 16 November 2026 is a Monday. 10:00 in Berlin is 09:00 UTC.
const MONDAY_10_BERLIN = new Date("2026-11-16T09:00:00Z");
const ZONE = "Europe/Berlin";

const WEEKDAY_SHIFTS: Shift[] = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  startMinute: 9 * 60,
  endMinute: 18 * 60,
}));

function agent(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    userId: "a",
    name: "Agent A",
    isOnline: true,
    openCount: 0,
    maxOpen: 5,
    skills: [],
    shifts: WEEKDAY_SHIFTS,
    ...overrides,
  };
}

const refundTicket = { intent: "refund", priority: "normal" } as const;

describe("isOnShift", () => {
  it("is true inside the shift", () => {
    expect(isOnShift(WEEKDAY_SHIFTS, MONDAY_10_BERLIN, ZONE)).toBe(true);
  });

  it("includes the first minute and excludes the end minute", () => {
    expect(isOnShift(WEEKDAY_SHIFTS, new Date("2026-11-16T08:00:00Z"), ZONE)).toBe(true); // 09:00
    expect(isOnShift(WEEKDAY_SHIFTS, new Date("2026-11-16T07:59:00Z"), ZONE)).toBe(false); // 08:59
    expect(isOnShift(WEEKDAY_SHIFTS, new Date("2026-11-16T16:59:00Z"), ZONE)).toBe(true); // 17:59
    expect(isOnShift(WEEKDAY_SHIFTS, new Date("2026-11-16T17:00:00Z"), ZONE)).toBe(false); // 18:00
  });

  it("is false on a day with no shift", () => {
    expect(isOnShift(WEEKDAY_SHIFTS, new Date("2026-11-15T09:00:00Z"), ZONE)).toBe(false); // Sunday
  });

  it("uses the region's clock: the same instant is on shift in one zone and off in another", () => {
    // 05:30 UTC is 09:30 in Dubai (on shift) but 06:30 in Berlin (not yet).
    const instant = new Date("2026-11-16T05:30:00Z");
    expect(isOnShift(WEEKDAY_SHIFTS, instant, "Asia/Dubai")).toBe(true);
    expect(isOnShift(WEEKDAY_SHIFTS, instant, ZONE)).toBe(false);
  });

  it("uses the region's weekday: late Sunday UTC is already Monday in Singapore", () => {
    const instant = new Date("2026-11-15T02:00:00Z"); // Sunday 10:00 in Singapore
    const mondayOnly: Shift[] = [{ weekday: 1, startMinute: 0, endMinute: 1440 }];
    expect(isOnShift(mondayOnly, instant, "Asia/Singapore")).toBe(false);
    expect(isOnShift(mondayOnly, new Date("2026-11-15T17:00:00Z"), "Asia/Singapore")).toBe(true);
  });

  it("is false with no shifts at all", () => {
    expect(isOnShift([], MONDAY_10_BERLIN, ZONE)).toBe(false);
  });
});

describe("filterAgents", () => {
  it("keeps an online agent who is on shift and under their limit", () => {
    const { eligible, rejected } = filterAgents([agent()], MONDAY_10_BERLIN, ZONE);
    expect(eligible.length).toBe(1);
    expect(rejected).toEqual([]);
  });

  it("rejects with a reason in plain words", () => {
    const agents = [
      agent({ userId: "off", name: "Offline", isOnline: false }),
      agent({ userId: "noshift", name: "No shift", shifts: [] }),
      agent({ userId: "full", name: "Full", openCount: 5, maxOpen: 5 }),
      agent({ userId: "ok", name: "Fine" }),
    ];
    const { eligible, rejected } = filterAgents(agents, MONDAY_10_BERLIN, ZONE);

    expect(eligible.map((a) => a.userId)).toEqual(["ok"]);
    expect(rejected).toEqual([
      { userId: "off", name: "Offline", reason: "offline" },
      { userId: "noshift", name: "No shift", reason: "off shift" },
      { userId: "full", name: "Full", reason: "at limit (5/5)" },
    ]);
  });
});

describe("scoring and ranking", () => {
  it("gives points for the matching skill", () => {
    const withSkill = scoreAgent(agent({ skills: ["refund"] }), refundTicket);
    const without = scoreAgent(agent({ skills: ["voucher"] }), refundTicket);
    expect(withSkill.score - without.score).toBe(40);
    expect(withSkill.reasons[0]).toBe("has the refund skill (+40)");
  });

  it("gives more points to an agent with more free capacity", () => {
    const empty = scoreAgent(agent({ openCount: 0 }), refundTicket);
    const busy = scoreAgent(agent({ openCount: 4 }), refundTicket);
    expect(empty.score).toBe(40);
    expect(busy.score).toBe(8);
    expect(busy.reasons).toEqual(["4 of 5 open (+8)"]);
  });

  it("ranks the skilled agent first when loads are equal", () => {
    const ranked = rankAgents(
      [agent({ userId: "plain" }), agent({ userId: "skilled", skills: ["refund"] })],
      refundTicket,
    );
    expect(ranked.map((a) => a.userId)).toEqual(["skilled", "plain"]);
  });

  it("for a normal ticket, a busy specialist beats a free generalist", () => {
    const ranked = rankAgents(
      [
        agent({ userId: "free" }), // 0 + 40
        agent({ userId: "specialist", skills: ["refund"], openCount: 3 }), // 40 + 16
      ],
      refundTicket,
    );
    expect(ranked[0]!.userId).toBe("specialist");
  });

  it("for an urgent ticket, the free generalist wins: starting now matters more", () => {
    const ranked = rankAgents(
      [
        agent({ userId: "free" }), // 0 + 80
        agent({ userId: "specialist", skills: ["refund"], openCount: 3 }), // 40 + 32
      ],
      { intent: "refund", priority: "urgent" },
    );
    expect(ranked[0]!.userId).toBe("free");
  });

  it("breaks ties by user id, so the order never depends on input order", () => {
    const forward = rankAgents([agent({ userId: "a" }), agent({ userId: "b" })], refundTicket);
    const backward = rankAgents([agent({ userId: "b" }), agent({ userId: "a" })], refundTicket);
    expect(forward.map((a) => a.userId)).toEqual(["a", "b"]);
    expect(backward.map((a) => a.userId)).toEqual(["a", "b"]);
  });
});

describe("planRouting", () => {
  it("filters first, then ranks, and reports both", () => {
    const plan = planRouting(
      [
        agent({ userId: "full", name: "Full", openCount: 5, skills: ["refund"] }),
        agent({ userId: "ok", name: "Fine" }),
      ],
      refundTicket,
      MONDAY_10_BERLIN,
      ZONE,
    );
    // The full agent has the skill but is never ranked: filter comes first.
    expect(plan.ranked.map((a) => a.userId)).toEqual(["ok"]);
    expect(plan.rejected.map((r) => r.userId)).toEqual(["full"]);
  });

  it("returns an empty ranking when nobody can take the ticket", () => {
    const plan = planRouting([agent({ isOnline: false })], refundTicket, MONDAY_10_BERLIN, ZONE);
    expect(plan.ranked).toEqual([]);
  });
});
