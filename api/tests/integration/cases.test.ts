import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { mlBreaker } from "../../src/core/mlClient.js";
import { FakeMl } from "./fakeMl.js";
import {
  bearer,
  closeTestPools,
  createAgencyWithRequester,
  createBooking,
  createUser,
  ownerPool,
  type TestAgency,
  type TestBooking,
  type TestUser,
} from "./helpers.js";

const app = createApp();
const fakeMl = new FakeMl();

let agency: TestAgency;
let requester: TestUser;
let agent: TestUser;

beforeAll(async () => {
  ({ agency, requester } = await createAgencyWithRequester());
  agent = await createUser("agent");
  await fakeMl.start();
});

beforeEach(() => {
  fakeMl.reset();
  mlBreaker.reset();
  // By default the fake says "nothing is similar".
  fakeMl.handler = () => ({ scores: [] });
});

afterAll(async () => {
  await fakeMl.stop();
  await closeTestPools();
});

type TicketBody = { id: string; case_id: string; version: number; status: string };

async function create(
  booking: TestBooking,
  subject = "Refund not received",
  user = requester,
): Promise<TicketBody> {
  const res = await request(app)
    .post("/api/v1/tickets")
    .set(bearer(user))
    .set("Idempotency-Key", randomUUID())
    .send({ tboh: booking.tboh, subject, body: "Please check this booking." });
  expect(res.status).toBe(201);
  return res.body;
}

function getCase(user: TestUser, caseId: string) {
  return request(app).get(`/api/v1/cases/${caseId}`).set(bearer(user));
}

function getLinks(user: TestUser, ticketId: string) {
  return request(app).get(`/api/v1/tickets/${ticketId}/links`).set(bearer(user));
}

function link(user: TestUser, ticketId: string, otherId: string) {
  return request(app)
    .post(`/api/v1/tickets/${ticketId}/links`)
    .set(bearer(user))
    .send({ ticket_id: otherId });
}

function unlink(user: TestUser, ticketId: string, otherId: string) {
  return request(app).delete(`/api/v1/tickets/${ticketId}/links/${otherId}`).set(bearer(user));
}

// Takes a ticket all the way to closed.
async function closeTicket(ticket: TicketBody) {
  const step = (path: string, version: number, body: object) =>
    request(app)
      .post(`/api/v1/tickets/${ticket.id}/${path}`)
      .set(bearer(agent))
      .set("If-Match", `"${version}"`)
      .send(body);

  const assigned = await step("assign", ticket.version, { assignee_id: agent.id });
  const resolved = await step("transitions", assigned.body.version, { to: "resolved" });
  const closed = await step("transitions", resolved.body.version, { to: "closed" });
  expect(closed.body.status).toBe("closed");
}

async function caseRow(caseId: string) {
  const result = await ownerPool.query<{ status: string; closed_at: Date | null }>(
    "SELECT status, closed_at FROM cases WHERE id = $1",
    [caseId],
  );
  return result.rows[0]!;
}

describe("cases", () => {
  // Phase 2 gate.
  it("three contacts on one TBOH land in one case", async () => {
    const booking = await createBooking(agency.id);

    const first = await create(booking, "Refund not received");
    const second = await create(booking, "Any update on our refund?");
    const third = await create(booking, "Voucher shows wrong dates");

    expect(second.case_id).toBe(first.case_id);
    expect(third.case_id).toBe(first.case_id);

    const res = await getCase(requester, first.case_id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: first.case_id,
      status: "open",
      closed_at: null,
      booking: { id: booking.id, tboh: booking.tboh, check_in_date: "2027-06-10" },
    });
    // All three, oldest first.
    expect(res.body.tickets.map((ticket: TicketBody) => ticket.id)).toEqual([
      first.id,
      second.id,
      third.id,
    ]);
  });

  it("tickets on different bookings get different cases", async () => {
    const a = await create(await createBooking(agency.id));
    const b = await create(await createBooking(agency.id));
    expect(a.case_id).not.toBe(b.case_id);
  });

  // Phase 2 gate, hazard 6 in README section 9.
  it("10 simultaneous creates on a new booking share one case", async () => {
    const booking = await createBooking(agency.id);

    const tickets = await Promise.all(
      Array.from({ length: 10 }, (_, i) => create(booking, `Refund question number ${i}`)),
    );

    // Ten different tickets...
    expect(new Set(tickets.map((ticket) => ticket.id)).size).toBe(10);
    // ...in exactly one case.
    expect(new Set(tickets.map((ticket) => ticket.case_id)).size).toBe(1);

    const cases = await ownerPool.query("SELECT 1 FROM cases WHERE booking_id = $1", [booking.id]);
    expect(cases.rowCount).toBe(1);
  });

  it("the case stays open while any of its tickets is not closed", async () => {
    const booking = await createBooking(agency.id);
    const first = await create(booking);
    await create(booking, "Second contact about the refund");

    await closeTicket(first);
    expect((await caseRow(first.case_id)).status).toBe("open");
  });

  it("closing the last ticket closes the case, and a new contact starts a new case", async () => {
    const booking = await createBooking(agency.id);
    const first = await create(booking);
    const second = await create(booking, "Second contact about the refund");

    await closeTicket(first);
    await closeTicket(second);

    const closedCase = await caseRow(first.case_id);
    expect(closedCase.status).toBe("closed");
    expect(closedCase.closed_at).not.toBeNull();

    // Closed is final, so a new problem on the same booking is a new case.
    const later = await create(booking, "Refund still missing");
    expect(later.case_id).not.toBe(first.case_id);
    expect((await caseRow(later.case_id)).status).toBe("open");
  });

  it("a requester's case view never shows another agency", async () => {
    const other = await createAgencyWithRequester();
    const theirs = await create(other.booking, "Refund not received", other.requester);

    expect((await getCase(requester, theirs.case_id)).status).toBe(404);
    expect((await getCase(other.requester, theirs.case_id)).status).toBe(200);
    expect((await getCase(agent, theirs.case_id)).status).toBe(200);
  });

  it("returns 404 for an unknown case and for a value that is not an id", async () => {
    expect((await getCase(requester, randomUUID())).status).toBe(404);
    expect((await getCase(requester, "not-a-uuid")).status).toBe(404);
  });
});

describe("the database guards cases too", () => {
  it("refuses a second open case for the same booking", async () => {
    const booking = await createBooking(agency.id);
    await create(booking);

    await expect(
      ownerPool.query("INSERT INTO cases (booking_id, agency_id) VALUES ($1, $2)", [
        booking.id,
        agency.id,
      ]),
    ).rejects.toMatchObject({ code: "23505" }); // unique violation
  });

  it("refuses to put a ticket in a case of another booking", async () => {
    const a = await create(await createBooking(agency.id));
    const b = await create(await createBooking(agency.id));

    await expect(
      ownerPool.query("UPDATE tickets SET case_id = $2 WHERE id = $1", [a.id, b.case_id]),
    ).rejects.toMatchObject({ code: "23503" }); // foreign key violation
  });
});

describe("automatic links from text similarity", () => {
  // Makes the fake ML service give every candidate the same score.
  function similarityAnswers(score: number) {
    fakeMl.handler = (path, body) => {
      if (path !== "/similarity") return {};
      const candidates = body.candidates as { id: string }[];
      return { scores: candidates.map((candidate) => ({ id: candidate.id, score })) };
    };
  }

  it("links a new ticket to a similar recent ticket on another booking", async () => {
    const earlier = await create(await createBooking(agency.id), "Refund not received");

    similarityAnswers(0.83);
    const later = await create(await createBooking(agency.id), "Refund has not arrived");

    const links = await getLinks(requester, later.id);
    expect(links.status).toBe(200);
    const linked = links.body.items.find(
      (item: { ticket_id: string }) => item.ticket_id === earlier.id,
    );
    expect(linked).toMatchObject({ reason: "similar_text", subject: "Refund not received" });
    expect(linked.score).toBeCloseTo(0.83, 2);

    // The link is visible from the other ticket as well.
    const reverse = await getLinks(requester, earlier.id);
    expect(reverse.body.items.map((item: { ticket_id: string }) => item.ticket_id)).toContain(
      later.id,
    );
  });

  it("sends only same-intent tickets from other bookings as candidates", async () => {
    const booking = await createBooking(agency.id);
    const sameBooking = await create(booking, "Refund not received");
    const otherIntent = await create(await createBooking(agency.id), "Voucher shows wrong dates");

    similarityAnswers(0.9);
    fakeMl.calls = []; // only look at the calls made by the next create
    await create(booking, "Refund is late");

    const calls = fakeMl.callsTo("/similarity");
    expect(calls.length).toBe(1);
    const sentIds = (calls[0]!.body.candidates as { id: string }[]).map(
      (candidate) => candidate.id,
    );
    expect(sentIds).not.toContain(sameBooking.id); // same booking = same case already
    expect(sentIds).not.toContain(otherIntent.id); // a voucher ticket, not a refund
  });

  it("does not link when the similarity is below the threshold", async () => {
    await create(await createBooking(agency.id), "Refund not received");

    similarityAnswers(0.2);
    const later = await create(await createBooking(agency.id), "Refund has not arrived");

    expect((await getLinks(requester, later.id)).body.items).toEqual([]);
  });

  it("never offers another agency's tickets as candidates", async () => {
    const other = await createAgencyWithRequester();
    const theirs = await create(other.booking, "Refund not received", other.requester);

    similarityAnswers(0.95);
    const mine = await create(await createBooking(agency.id), "Refund not received");

    const sentIds = fakeMl
      .callsTo("/similarity")
      .flatMap((call) =>
        (call.body.candidates as { id: string }[]).map((candidate) => candidate.id),
      );
    expect(sentIds).not.toContain(theirs.id);

    const links = await getLinks(requester, mine.id);
    expect(links.body.items.map((item: { ticket_id: string }) => item.ticket_id)).not.toContain(
      theirs.id,
    );
  });

  it("records the link on both timelines", async () => {
    const earlier = await create(await createBooking(agency.id), "Refund not received");
    similarityAnswers(0.83);
    const later = await create(await createBooking(agency.id), "Refund has not arrived");

    const events = await ownerPool.query<{ ticket_id: string }>(
      `SELECT ticket_id FROM ticket_events
        WHERE type = 'ticket_linked' AND ticket_id IN ($1, $2)
          AND data->>'ticket_id' IN ($3, $4)`,
      [earlier.id, later.id, earlier.id, later.id],
    );
    expect(events.rows.map((row) => row.ticket_id).sort()).toEqual([earlier.id, later.id].sort());
  });

  it("the ticket is still created when the similarity call fails", async () => {
    await create(await createBooking(agency.id), "Refund not received");
    fakeMl.status = 503;

    const later = await create(await createBooking(agency.id), "Refund has not arrived");
    expect((await getLinks(requester, later.id)).body.items).toEqual([]);
  });
});

describe("manual link and unlink", () => {
  async function twoTickets() {
    const a = await create(await createBooking(agency.id), "Refund not received");
    const b = await create(await createBooking(agency.id), "Voucher shows wrong dates");
    return { a, b };
  }

  it("an agent links two tickets, and either ticket shows the other", async () => {
    const { a, b } = await twoTickets();

    const res = await link(agent, a.id, b.id);
    expect(res.status).toBe(204);

    const fromA = await getLinks(agent, a.id);
    const fromB = await getLinks(agent, b.id);
    expect(fromA.body.items).toMatchObject([{ ticket_id: b.id, reason: "manual", score: null }]);
    expect(fromB.body.items).toMatchObject([{ ticket_id: a.id, reason: "manual" }]);
  });

  it("linking the same pair again, in either direction, is a 409", async () => {
    const { a, b } = await twoTickets();
    await link(agent, a.id, b.id);

    const again = await link(agent, a.id, b.id);
    const reversed = await link(agent, b.id, a.id);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("already_linked");
    expect(reversed.status).toBe(409);
  });

  it("two agents linking the same pair at once make one link", async () => {
    const { a, b } = await twoTickets();
    const agent2 = await createUser("agent");

    const results = await Promise.all([link(agent, a.id, b.id), link(agent2, b.id, a.id)]);
    expect(results.map((res) => res.status).sort()).toEqual([204, 409]);

    const rows = await ownerPool.query(
      "SELECT 1 FROM ticket_links WHERE ticket_a IN ($1, $2) AND removed_at IS NULL",
      [a.id, b.id],
    );
    expect(rows.rowCount).toBe(1);
  });

  it("unlinking keeps the row as history and allows linking again", async () => {
    const { a, b } = await twoTickets();
    await link(agent, a.id, b.id);

    const removed = await unlink(agent, b.id, a.id); // from the other side
    expect(removed.status).toBe(204);
    expect((await getLinks(agent, a.id)).body.items).toEqual([]);

    // Nothing was deleted: the row is still there, marked as removed.
    const history = await ownerPool.query<{ removed_by: string }>(
      "SELECT removed_by FROM ticket_links WHERE ticket_a IN ($1, $2)",
      [a.id, b.id],
    );
    expect(history.rows).toEqual([{ removed_by: agent.id }]);

    expect((await unlink(agent, a.id, b.id)).status).toBe(404); // already unlinked
    expect((await link(agent, a.id, b.id)).status).toBe(204); // can be linked again
  });

  it("rejects linking a ticket to itself, to a missing ticket, or within one case", async () => {
    const booking = await createBooking(agency.id);
    const a = await create(booking);
    const sameCase = await create(booking, "Second contact about the refund");

    const self = await link(agent, a.id, a.id);
    const missing = await link(agent, a.id, randomUUID());
    const within = await link(agent, a.id, sameCase.id);

    for (const res of [self, missing, within]) {
      expect(res.status).toBe(422);
      expect(res.body.code).toBe("invalid_link");
    }
  });

  it("tickets of different agencies cannot be linked, even by staff", async () => {
    const mine = await create(await createBooking(agency.id));
    const other = await createAgencyWithRequester();
    const theirs = await create(other.booking, "Refund not received", other.requester);

    const res = await link(agent, mine.id, theirs.id);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("invalid_link");
  });

  it("a requester cannot link or unlink, but can see links", async () => {
    const { a, b } = await twoTickets();
    expect((await link(requester, a.id, b.id)).status).toBe(403);

    await link(agent, a.id, b.id);
    expect((await unlink(requester, a.id, b.id)).status).toBe(403);
    expect((await getLinks(requester, a.id)).body.items.length).toBe(1);
  });
});
