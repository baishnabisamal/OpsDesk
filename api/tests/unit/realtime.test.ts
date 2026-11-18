import { describe, expect, it } from "vitest";
import { agencyRoom, audienceFor } from "../../src/domain/realtime.js";

describe("who receives a live event", () => {
  it.each(["ticket.created", "ticket.updated", "ticket.status_changed"])(
    "%s goes to the agency too",
    (type) => {
      expect(audienceFor(type, {})).toBe("everyone");
    },
  );

  it("a public reply goes to the agency; an internal note does not", () => {
    expect(audienceFor("message.created", { visibility: "public" })).toBe("everyone");
    expect(audienceFor("message.created", { visibility: "internal" })).toBe("staff");
    expect(audienceFor("message.created", {})).toBe("staff");
  });

  it.each([
    "ticket.assigned",
    "ticket.sla_at_risk",
    "ticket.sla_breached",
    "ticket.linked",
    "ticket.intent_overridden",
    "side_message.created",
    "a.brand.new.event",
  ])("%s is staff only", (type) => {
    expect(audienceFor(type, { visibility: "public" })).toBe("staff");
  });

  it("names agency rooms by id", () => {
    expect(agencyRoom("abc")).toBe("agency:abc");
  });
});
