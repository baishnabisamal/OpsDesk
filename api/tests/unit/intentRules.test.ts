import { describe, expect, it } from "vitest";
import { classifyByRules } from "../../src/domain/intentRules.js";

describe("intent rules", () => {
  it.each([
    ["Booking not found at hotel", "Guest is at reception.", "booking_not_found"],
    ["Hotel says no reservation exists", "Please reconfirm.", "booking_not_found"],
    ["Urgent", "The hotel cannot find the booking for our guest.", "booking_not_found"],
    ["Booking missing at hotel", "Guest was turned away.", "booking_not_found"],
    ["Refund not received", "It has been 10 days.", "refund"],
    ["Where is our money back?", "Still waiting.", "refund"],
    ["Charged twice for one booking", "See card statement.", "payment"],
    ["Payment failed", "The card was declined at checkout.", "payment"],
    ["Voucher shows wrong dates", "Please fix.", "voucher"],
    ["Change of guest name", "It is spelled wrong.", "amendment"],
    ["Need to change the dates", "Arriving one day later.", "amendment"],
    ["Please cancel this booking", "Client no longer needs the room.", "cancellation"],
    ["Cancellation request", "Free of charge please.", "cancellation"],
  ])("%j / %j -> %s", (subject, body, expected) => {
    expect(classifyByRules(subject, body)?.intent).toBe(expected);
  });

  it("prefers refund when a cancelled booking is waiting for its refund", () => {
    const match = classifyByRules(
      "Booking cancelled",
      "We cancelled last week, refund not arrived.",
    );
    expect(match).toEqual({ intent: "refund", rule: "refund_words" });
  });

  it("prefers payment over refund for a double charge", () => {
    const match = classifyByRules("Charged twice", "Please refund one of the charges.");
    expect(match?.intent).toBe("payment");
  });

  it("ignores case and punctuation", () => {
    expect(classifyByRules("REFUND!!!", "???")?.intent).toBe("refund");
  });

  it.each([
    ["Late check-out request", "Can the guest stay until 4 pm?"],
    ["Question", "Is breakfast included in this rate?"],
    ["Help needed", "Please call us back."],
  ])("returns null when nothing is obvious: %j", (subject, body) => {
    expect(classifyByRules(subject, body)).toBeNull();
  });

  it("does not match a word that only contains a keyword", () => {
    // "cancel" must be a whole word: "cancellous" is not a cancellation.
    expect(classifyByRules("Cancellous bone query", "Not about travel.")).toBeNull();
  });
});
