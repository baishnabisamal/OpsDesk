import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { EXPORT_COLUMNS } from "../../src/services/exportService.js";
import {
  bearer,
  closeTestPools,
  createAgencyWithRequester,
  createUser,
  type TestAgency,
  type TestBooking,
  type TestUser,
} from "./helpers.js";

const app = createApp();

let agency: TestAgency;
let requester: TestUser;
let booking: TestBooking;
let lead: TestUser;
let agent: TestUser;
const subjects = ["Refund not received", "Voucher, wrong dates", '=HYPERLINK("http://evil")'];

beforeAll(async () => {
  ({ agency, requester, booking } = await createAgencyWithRequester());
  lead = await createUser("lead");
  agent = await createUser("agent");
  for (const subject of subjects) {
    const res = await request(app)
      .post("/api/v1/tickets")
      .set(bearer(requester))
      .set("Idempotency-Key", randomUUID())
      .send({ tboh: booking.tboh, subject, body: "Please check." });
    expect(res.status).toBe(201);
  }
});

afterAll(closeTestPools);

function exportCsv(user: TestUser, query: Record<string, string> = {}) {
  return request(app)
    .get("/api/v1/exports/tickets.csv")
    .query({ agency_id: agency.id, ...query })
    .set(bearer(user))
    .buffer(true)
    .parse((res, done) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (text += chunk));
      res.on("end", () => done(null, text));
    });
}

describe("GET /exports/tickets.csv", () => {
  it("streams a CSV file with a header and one line per ticket", async () => {
    const res = await exportCsv(lead);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="tickets.csv"');

    const lines = (res.body as string).split("\r\n").filter(Boolean);
    expect(lines[0]).toBe(EXPORT_COLUMNS.join(","));
    expect(lines.length).toBe(1 + subjects.length);
    expect(res.body).toContain(booking.tboh);
  });

  it("quotes commas and neutralises formulas", async () => {
    const res = await exportCsv(lead);
    expect(res.body).toContain('"Voucher, wrong dates"');
    expect(res.body).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(res.body).not.toMatch(/,=HYPERLINK/);
  });

  it("filters by status and by a half-open date range", async () => {
    const none = await exportCsv(lead, { status: "closed" });
    expect((none.body as string).split("\r\n").filter(Boolean).length).toBe(1); // header only

    const today = new Date().toISOString().slice(0, 10);
    const beforeToday = await exportCsv(lead, { to: today }); // `to` is excluded
    expect((beforeToday.body as string).split("\r\n").filter(Boolean).length).toBe(1);
  });

  it("is for leads only, and refuses before sending any CSV", async () => {
    const asAgent = await request(app).get("/api/v1/exports/tickets.csv").set(bearer(agent));
    const asRequester = await request(app)
      .get("/api/v1/exports/tickets.csv")
      .set(bearer(requester));
    expect(asAgent.status).toBe(403);
    expect(asAgent.headers["content-type"]).toContain("application/problem+json");
    expect(asRequester.status).toBe(403);
  });

  it("rejects unknown filters", async () => {
    const res = await request(app)
      .get("/api/v1/exports/tickets.csv")
      .query({ everything: "yes" })
      .set(bearer(lead));
    expect(res.status).toBe(400);
  });
});
