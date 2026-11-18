import { describe, expect, it } from "vitest";
import type { Actor } from "../../src/domain/enums.js";
import { ACTIONS, can, type Action } from "../../src/domain/permissions.js";

const ACTORS: Actor[] = ["requester", "agent", "escalation_manager", "lead", "system"];

const staff: Actor[] = ["agent", "escalation_manager", "lead"];
const everyone: Actor[] = ["requester", ...staff];

// The expected table, written by hand. If someone changes a permission,
// this test fails and they have to change it here on purpose too.
const EXPECTED: Record<Action, Actor[]> = {
  "ticket:create": ["requester"],
  "ticket:read": everyone,
  "ticket:edit": staff,
  "ticket:override_intent": staff,
  "ticket:transition": everyone,
  "ticket:assign_self": staff,
  "ticket:assign_other": ["lead"],
  "ticket:link": staff,
  "case:read": everyone,
  "presence:update": staff,
  "queue:read": staff,
  "side_conversation:read": staff,
  "side_conversation:write": staff,
  "insights:read": ["lead"],
  "export:run": ["lead"],
  "staff:invite": ["lead"],
  "message:read": everyone,
  "message:write_public": everyone,
  "message:write_internal": staff,
  "timeline:read": everyone,
};

describe("permission table", () => {
  it("has an expectation for every action", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...ACTIONS].sort());
  });

  for (const action of ACTIONS) {
    for (const actor of ACTORS) {
      const expected = EXPECTED[action].includes(actor);
      it(`${actor} ${expected ? "may" : "may not"} ${action}`, () => {
        expect(can(actor, action)).toBe(expected);
      });
    }
  }

  it("a requester can never write an internal note", () => {
    expect(can("requester", "message:write_internal")).toBe(false);
  });

  it("the system actor has no HTTP permissions", () => {
    for (const action of ACTIONS) {
      expect(can("system", action)).toBe(false);
    }
  });
});
