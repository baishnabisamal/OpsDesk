import { describe, expect, it } from "vitest";
import { TICKET_STATUSES, type Actor, type TicketStatus } from "../../src/domain/enums.js";
import { canTransition, transitionEffects } from "../../src/domain/stateMachine.js";

const ACTORS: Actor[] = ["requester", "agent", "escalation_manager", "lead", "system"];

// The expected policy, written out by hand from README section 11.
// Format: "from>to" -> actors allowed.
const staff: Actor[] = ["agent", "escalation_manager", "lead"];
const EXPECTED: Record<string, Actor[]> = {
  "new>open": [...staff, "system"],
  "open>pending": staff,
  "open>escalated": [...staff, "system"],
  "open>resolved": staff,
  "pending>open": ["requester", ...staff],
  "pending>escalated": [...staff, "system"],
  "pending>resolved": staff,
  "escalated>open": ["escalation_manager", "lead"],
  "escalated>resolved": ["escalation_manager", "lead"],
  "resolved>open": ["requester", ...staff],
  "resolved>closed": ["requester", ...staff, "system"],
};

describe("state machine", () => {
  // 6 statuses x 6 statuses x 5 actors = 180 cases, every one checked.
  for (const from of TICKET_STATUSES) {
    for (const to of TICKET_STATUSES) {
      for (const actor of ACTORS) {
        const expected = (EXPECTED[`${from}>${to}`] ?? []).includes(actor);
        it(`${from} -> ${to} as ${actor} is ${expected ? "allowed" : "rejected"}`, () => {
          expect(canTransition(from, to, actor)).toBe(expected);
        });
      }
    }
  }

  it("closed is final", () => {
    for (const to of TICKET_STATUSES) {
      for (const actor of ACTORS) {
        expect(canTransition("closed", to, actor)).toBe(false);
      }
    }
  });

  it("a status never transitions to itself", () => {
    for (const status of TICKET_STATUSES) {
      for (const actor of ACTORS) {
        expect(canTransition(status, status as TicketStatus, actor)).toBe(false);
      }
    }
  });
});

describe("transition effects", () => {
  it("entering resolved sets resolved_at", () => {
    expect(transitionEffects("open", "resolved")).toEqual({
      resolvedAt: "set",
      closedAt: undefined,
    });
  });

  it("reopening clears resolved_at", () => {
    expect(transitionEffects("resolved", "open")).toEqual({
      resolvedAt: "clear",
      closedAt: undefined,
    });
  });

  it("closing sets closed_at and keeps resolved_at", () => {
    expect(transitionEffects("resolved", "closed")).toEqual({
      resolvedAt: undefined,
      closedAt: "set",
    });
  });

  it("other transitions touch neither timestamp", () => {
    expect(transitionEffects("open", "pending")).toEqual({
      resolvedAt: undefined,
      closedAt: undefined,
    });
  });
});
