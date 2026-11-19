import { describe, expect, it } from "vitest";
import { REPO } from "./links";
import { issueUrl } from "./sections";

// The contact form has no backend: it opens a GitHub issue. Issues are public,
// so the email address must only appear when the visitor asks for it.
describe("contact form issue link", () => {
  const form = { name: "Asha", email: "asha@example.com", message: "How does routing pick?" };

  it("opens a new issue on the project with the message as the body", () => {
    const url = new URL(issueUrl(form, false));
    expect(`${url.origin}${url.pathname}`).toBe(`${REPO}/issues/new`);
    expect(url.searchParams.get("title")).toBe("Message from Asha");
    expect(url.searchParams.get("body")).toContain("How does routing pick?");
  });

  it("leaves the email out unless the visitor ticks the box", () => {
    expect(new URL(issueUrl(form, false)).searchParams.get("body")).not.toContain(
      "asha@example.com",
    );
    expect(new URL(issueUrl(form, true)).searchParams.get("body")).toContain("asha@example.com");
  });

  it("encodes characters that would break the address", () => {
    const url = new URL(issueUrl({ ...form, message: "a & b = c? #1" }, false));
    expect(url.searchParams.get("body")).toContain("a & b = c? #1");
  });
});
