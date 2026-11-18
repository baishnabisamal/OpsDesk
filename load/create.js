import http from "k6/http";
import { check } from "k6";
import { AGENCY_SLUGS, auth, BASE, login, pick, summary } from "./lib.js";

// README target: ticket create p95 under 300 ms, with classify, link and
// route included. The design load is 50,000 tickets a day, about 0.6 per
// second on average; 5 per second is a busy peak with room to spare.

export const options = {
  scenarios: {
    creates: {
      executor: "constant-arrival-rate",
      rate: Number(__ENV.RATE || 5),
      timeUnit: "1s",
      duration: __ENV.DURATION || "60s",
      preAllocatedVUs: 10,
      maxVUs: 100,
    },
  },
  thresholds: {
    "http_req_duration{kind:create}": ["p(95)<300"],
    "http_req_failed{kind:create}": ["rate<0.01"],
  },
  summaryTrendStats: ["med", "p(95)", "p(99)", "max"],
};

const SUBJECTS = [
  [
    "Guest arrived, hotel has no booking",
    "The hotel cannot find the reservation. Guest is at reception.",
  ],
  [
    "Please cancel this booking",
    "The client changed plans; please cancel before the free cancellation ends.",
  ],
  [
    "Refund not received",
    "The booking was cancelled two weeks ago and the refund has not arrived.",
  ],
  ["Change the guest name", "Please change the lead guest name on the booking."],
  ["Voucher shows the wrong dates", "The voucher has the wrong check-in date."],
];

// Every agency user raises tickets on their own agency's bookings, found the
// same way the app would: their tickets, then each ticket's case.
export function setup() {
  return AGENCY_SLUGS.map((slug) => {
    const token = login(`user1@${slug}.test`);
    const tickets = http.get(`${BASE}/api/v1/tickets?limit=50`, auth(token)).json("items");
    const caseIds = [...new Set(tickets.map((ticket) => ticket.case_id))];
    const tbohs = caseIds.map(
      (id) => http.get(`${BASE}/api/v1/cases/${id}`, auth(token)).json("booking").tboh,
    );
    return { token, tbohs };
  }).filter((agency) => agency.tbohs.length > 0);
}

export default function (agencies) {
  const agency = pick(agencies);
  const [subject, body] = pick(SUBJECTS);
  const res = http.post(
    `${BASE}/api/v1/tickets`,
    JSON.stringify({ tboh: pick(agency.tbohs), subject, body, priority: "normal" }),
    {
      ...auth(agency.token, {
        "Content-Type": "application/json",
        // Unique per request: these are new tickets, not retries.
        "Idempotency-Key": `load-${__VU}-${__ITER}-${Date.now()}`,
      }),
      tags: { kind: "create", name: "POST /tickets" },
    },
  );
  check(res, { "status is 201": (r) => r.status === 201 });
}

export function handleSummary(data) {
  return summary(data, "var/load/create-summary.json");
}
