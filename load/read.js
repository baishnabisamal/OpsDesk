import http from "k6/http";
import { check } from "k6";
import { AGENCY_SLUGS, auth, BASE, login, pick, summary } from "./lib.js";

// README target: reads p95 under 150 ms at 50 requests per second.
//
// "constant-arrival-rate" starts 50 requests every second whatever happens.
// A closed loop ("each user waits for its answer, then sends the next")
// would slow down when the server slows down, and hide the problem; this
// keeps the load fixed, like real users who do not wait for each other.

const ENDPOINTS = [
  "GET /queues/triage",
  "GET /queues/mine",
  "GET /queues/escalations",
  "GET /tickets",
  "GET /tickets?q=",
  "GET /tickets/:id",
  "GET /tickets/:id/timeline",
  "GET /tickets (agency)",
];

export const options = {
  scenarios: {
    reads: {
      executor: "constant-arrival-rate",
      rate: Number(__ENV.RATE || 50),
      timeUnit: "1s",
      duration: __ENV.DURATION || "60s",
      preAllocatedVUs: 20,
      maxVUs: 200,
    },
  },
  thresholds: {
    "http_req_duration{kind:read}": ["p(95)<150"],
    "http_req_failed{kind:read}": ["rate<0.01"],
    // One line per endpoint in the summary (k6 only reports a tag's numbers
    // when a threshold mentions it), so the slowest one stands out.
    ...Object.fromEntries(ENDPOINTS.map((name) => [`http_req_duration{name:${name}}`, ["max>=0"]])),
  },
  summaryTrendStats: ["med", "p(95)", "p(99)", "max"],
};

// What a working day looks like: agents mostly look at queues and tickets.
export function setup() {
  const staff = ["agent1.eu", "agent2.eu", "agent1.amer", "manager.eu", "lead.eu"].map((name) =>
    login(`${name}@opsdesk.test`),
  );
  const requesters = AGENCY_SLUGS.map((slug) => login(`user1@${slug}.test`));
  const list = http.get(`${BASE}/api/v1/tickets?limit=100`, auth(staff[4]));
  const ticketIds = list.json("items").map((ticket) => ticket.id);
  return { staff, requesters, ticketIds };
}

function get(path, token, name) {
  const res = http.get(`${BASE}${path}`, { ...auth(token), tags: { kind: "read", name } });
  check(res, { "status is 200": (r) => r.status === 200 });
}

export default function (data) {
  const roll = Math.random();
  const staff = pick(data.staff);
  if (roll < 0.15) get("/api/v1/queues/triage", staff, "GET /queues/triage");
  else if (roll < 0.3) get("/api/v1/queues/mine", staff, "GET /queues/mine");
  else if (roll < 0.4) get("/api/v1/queues/escalations", staff, "GET /queues/escalations");
  else if (roll < 0.55) get("/api/v1/tickets?limit=20", staff, "GET /tickets");
  else if (roll < 0.6) get("/api/v1/tickets?q=refund&limit=20", staff, "GET /tickets?q=");
  else if (roll < 0.8) get(`/api/v1/tickets/${pick(data.ticketIds)}`, staff, "GET /tickets/:id");
  else if (roll < 0.9)
    get(`/api/v1/tickets/${pick(data.ticketIds)}/timeline`, staff, "GET /tickets/:id/timeline");
  else get("/api/v1/tickets?limit=20", pick(data.requesters), "GET /tickets (agency)");
}

export function handleSummary(data) {
  return summary(data, "var/load/read-summary.json");
}
