import { fileURLToPath } from "node:url";
import { config } from "../src/core/config.js";
import { hashPassword } from "../src/services/authService.js";
import { ownerClient } from "./migrate.js";

// Demo data generator. Run with `make seed`.
//
// Deterministic: it produces exactly the same rows, with the same ids, every
// time. Two things make that true:
//   1. "Random" choices come from a small generator that starts from a fixed
//      number (the seed), so it always gives the same sequence.
//   2. Dates are counted from a fixed base date, never from the current time.
//
// It is also safe to run twice: every INSERT has ON CONFLICT DO NOTHING, and
// since the ids are the same each run, the second run adds nothing.
//
// It connects as the owner role and writes rows directly, like a data import.
// The API itself never does this; it goes through the services.

export const SEED_PASSWORD = "Password123!";
const BASE_DATE = new Date("2026-11-15T00:00:00Z");

const COUNTS = { agencies: 5, suppliers: 6, bookings: 40, tickets: 80 };

// --- A tiny seeded random number generator (mulberry32) --------------------
// Same seed in, same numbers out. Math.random() cannot do that.
function createRandom(seed: number) {
  let state = seed;
  return function random(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 20261115;
let random = createRandom(SEED);

// Whole number from min to max, both included.
function randomInt(min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

// A UUID built from the seeded generator, so ids repeat between runs.
function seededUuid(): string {
  let hex = "";
  for (let i = 0; i < 32; i++) hex += Math.floor(random() * 16).toString(16);
  // Positions 12 and 16 mark it as a version 4 UUID.
  const chars = hex.split("");
  chars[12] = "4";
  chars[16] = "8";
  const h = chars.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function minutesBefore(date: Date, minutes: number): Date {
  return new Date(date.getTime() - minutes * 60_000);
}

function minutesAfter(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

// --- The raw material -------------------------------------------------------

const REGIONS = [
  { code: "MEA", hotelTimeZone: "Asia/Dubai", hotels: ["Marina Bay Suites", "Desert Rose Hotel"] },
  { code: "EU", hotelTimeZone: "Europe/Berlin", hotels: ["Hotel Lindenhof", "Alpenblick Resort"] },
  { code: "APAC", hotelTimeZone: "Asia/Singapore", hotels: ["Orchid Garden Hotel", "Harbour Inn"] },
  { code: "AMER", hotelTimeZone: "America/New_York", hotels: ["Hudson Park Hotel", "The Liberty"] },
] as const;

const AGENCY_NAMES = [
  "Skyline Travels",
  "Globe Trotters",
  "Sunrise Holidays",
  "Atlas Tours",
  "BlueWave Trips",
];

const SUPPLIER_NAMES = [
  "HotelBeds",
  "StayDirect",
  "RoomsXML",
  "LodgeLink",
  "InnConnect",
  "BedBank One",
];

const FIRST_NAMES = [
  "Aarav",
  "Meera",
  "Rohan",
  "Sara",
  "Omar",
  "Lena",
  "Kenji",
  "Maria",
  "David",
  "Priya",
];
const LAST_NAMES = [
  "Sharma",
  "Khan",
  "Müller",
  "Tan",
  "Garcia",
  "Patel",
  "Rossi",
  "Nair",
  "Silva",
  "Das",
];

// One or two ticket texts per intent.
const TICKET_TEXTS = [
  {
    intent: "booking_not_found",
    subject: "Booking not found at hotel",
    body: "The guest is at reception and the hotel cannot find the booking.",
  },
  {
    intent: "booking_not_found",
    subject: "Hotel says no reservation exists",
    body: "The hotel has no record under the guest name. Please reconfirm.",
  },
  {
    intent: "cancellation",
    subject: "Please cancel this booking",
    body: "The client no longer needs the room. Please cancel free of charge.",
  },
  {
    intent: "amendment",
    subject: "Change of guest name",
    body: "The lead guest name is spelled wrong. Please correct it.",
  },
  {
    intent: "amendment",
    subject: "Need to change the stay dates",
    body: "The guest wants to arrive one day later. Is that possible?",
  },
  {
    intent: "refund",
    subject: "Refund not received",
    body: "The booking was cancelled 10 days ago and the refund has not arrived.",
  },
  {
    intent: "refund",
    subject: "Refund amount is lower than expected",
    body: "We were refunded less than the amount paid. Please check.",
  },
  {
    intent: "voucher",
    subject: "Voucher shows wrong dates",
    body: "The voucher shows different dates from our confirmation.",
  },
  {
    intent: "payment",
    subject: "Charged twice for one booking",
    body: "Our card statement shows two charges for this booking.",
  },
  {
    intent: "other",
    subject: "Late check-out request",
    body: "Can the guest have a late check-out until 4 pm?",
  },
] as const;

const AGENT_REPLIES = [
  "We are checking this with the hotel and will update you shortly.",
  "The hotel has confirmed. Please ask the guest to try again.",
  "Could you send us the confirmation email you received?",
];
const REQUESTER_REPLIES = [
  "Any update on this?",
  "Thank you, please keep us posted.",
  "The guest is still waiting.",
];
const INTERNAL_NOTES = [
  "Called the hotel, waiting for the duty manager.",
  "Supplier confirmed by email.",
];

// Listed more than once = more likely to be picked.
const STATUSES = [
  "new",
  "new",
  "new",
  "new",
  "new",
  "new",
  "open",
  "open",
  "open",
  "open",
  "open",
  "open",
  "pending",
  "pending",
  "escalated",
  "resolved",
  "resolved",
  "resolved",
  "closed",
  "closed",
] as const;

const PRIORITIES = ["low", "normal", "normal", "normal", "high", "high", "urgent"] as const;

// --- The seeding itself ------------------------------------------------------

type SeedUser = { id: string; name: string };

export async function seed(log: (line: string) => void = console.log) {
  // Start the sequence from the beginning on every call, so calling seed()
  // twice in one process gives the same ids both times.
  random = createRandom(SEED);

  if (config.nodeEnv === "production") {
    throw new Error("Refusing to load demo data in production.");
  }

  const passwordHash = await hashPassword(SEED_PASSWORD);
  const client = ownerClient();
  await client.connect();

  try {
    // All or nothing: a failure half way leaves the database untouched.
    await client.query("BEGIN");

    const insertUser = async (
      email: string,
      name: string,
      role: string,
      agencyId: string | null,
      teamId: string | null,
    ): Promise<SeedUser> => {
      const id = seededUuid();
      await client.query(
        `INSERT INTO users (id, email, password_hash, full_name, role, agency_id, team_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
        [id, email, passwordHash, name, role, agencyId, teamId],
      );
      return { id, name };
    };

    const randomName = () => `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;

    // Teams and staff: one team per region with a lead, a manager and 3 agents.
    const agentsByRegion = new Map<string, { teamId: string; agents: SeedUser[] }>();
    for (const region of REGIONS) {
      const teamId = seededUuid();
      const short = region.code.toLowerCase();
      await client.query(
        "INSERT INTO teams (id, name, region_code) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        [teamId, `${region.code} Support`, region.code],
      );
      await insertUser(`lead.${short}@opsdesk.test`, randomName(), "lead", null, teamId);
      await insertUser(
        `manager.${short}@opsdesk.test`,
        randomName(),
        "escalation_manager",
        null,
        teamId,
      );
      const agents: SeedUser[] = [];
      for (let n = 1; n <= 3; n++) {
        agents.push(
          await insertUser(`agent${n}.${short}@opsdesk.test`, randomName(), "agent", null, teamId),
        );
      }
      agentsByRegion.set(region.code, { teamId, agents });
    }

    // Agencies, each with two requesters.
    const agencies: { id: string; requesters: SeedUser[] }[] = [];
    for (const name of AGENCY_NAMES.slice(0, COUNTS.agencies)) {
      const id = seededUuid();
      const slug = name.toLowerCase().replaceAll(" ", "-");
      await client.query(
        "INSERT INTO agencies (id, slug, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        [id, slug, name],
      );
      const requesters: SeedUser[] = [];
      for (let n = 1; n <= 2; n++) {
        requesters.push(
          await insertUser(`user${n}@${slug}.test`, randomName(), "requester", id, null),
        );
      }
      agencies.push({ id, requesters });
    }

    const supplierIds: string[] = [];
    for (const [index, name] of SUPPLIER_NAMES.slice(0, COUNTS.suppliers).entries()) {
      const id = seededUuid();
      await client.query(
        "INSERT INTO suppliers (id, code, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        [id, `SUP${String(index + 1).padStart(3, "0")}`, name],
      );
      supplierIds.push(id);
    }

    // Bookings. Check-in is 5 to 120 days after the base date, and free
    // cancellation ends 2 to 14 days before check-in.
    const bookings: { id: string; agency: (typeof agencies)[number]; region: string }[] = [];
    for (let n = 1; n <= COUNTS.bookings; n++) {
      const id = seededUuid();
      const agency = pick(agencies);
      const region = pick(REGIONS);
      const checkIn = minutesAfter(BASE_DATE, randomInt(5, 120) * 24 * 60);
      const lcdAt = minutesBefore(checkIn, randomInt(2, 14) * 24 * 60);
      await client.query(
        `INSERT INTO bookings (id, tboh, agency_id, supplier_id, region_code, hotel_name,
                               check_in_date, hotel_time_zone, lcd_at, amount, currency, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT DO NOTHING`,
        [
          id,
          `TBOH${String(1000000 + n)}`,
          agency.id,
          pick(supplierIds),
          region.code,
          pick(region.hotels),
          checkIn.toISOString().slice(0, 10), // just the date part
          region.hotelTimeZone,
          lcdAt,
          // Money as a string with two decimals, never a float.
          `${randomInt(80, 2500)}.${String(randomInt(0, 99)).padStart(2, "0")}`,
          pick(["USD", "EUR", "AED", "SGD"]),
          minutesBefore(BASE_DATE, randomInt(30, 60) * 24 * 60),
        ],
      );
      bookings.push({ id, agency, region: region.code });
    }

    // Tickets, each with its timeline and a few messages.
    for (let n = 1; n <= COUNTS.tickets; n++) {
      const id = seededUuid();
      const booking = pick(bookings);
      const requester = pick(booking.agency.requesters);
      const text = pick(TICKET_TEXTS);
      const status = pick(STATUSES);
      const team = agentsByRegion.get(booking.region)!;
      const assignee = status === "new" ? null : pick(team.agents);

      // Each ticket was created some time in the 20 days before the base date.
      const createdAt = minutesBefore(BASE_DATE, randomInt(60, 20 * 24 * 60));
      const assignedAt = minutesAfter(createdAt, randomInt(5, 45));
      const finishedAt = minutesAfter(assignedAt, randomInt(30, 600));
      const isDone = status === "resolved" || status === "closed";
      const lastChange = status === "new" ? createdAt : status === "open" ? assignedAt : finishedAt;

      // The case of this booking, created the first time the booking gets a
      // ticket. Its id is worked out from the booking id, so it is the same
      // on every run.
      await client.query(
        `INSERT INTO cases (id, booking_id, agency_id, created_at)
         SELECT md5('case:' || b.id::text)::uuid, b.id, b.agency_id, b.created_at
           FROM bookings b
          WHERE b.id = $1 AND NOT EXISTS (SELECT 1 FROM cases WHERE booking_id = b.id)
         ON CONFLICT DO NOTHING`,
        [booking.id],
      );

      await client.query(
        `INSERT INTO tickets (id, agency_id, booking_id, case_id, requester_id, subject, body, intent, intent_source,
                              priority, status, assignee_id, team_id, check_in_at, lcd_at, region_code,
                              created_at, updated_at, resolved_at, closed_at, version)
         SELECT $1, b.agency_id, b.id,
                (SELECT id FROM cases WHERE booking_id = b.id ORDER BY created_at, id LIMIT 1),
                $3, $4, $5, $6, 'manual', $7, $8, $9, $10,
                (b.check_in_date + time '14:00') AT TIME ZONE b.hotel_time_zone, b.lcd_at,
                b.region_code, $11, $12, $13, $14, $15
           FROM bookings b WHERE b.id = $2
         ON CONFLICT DO NOTHING`,
        [
          id,
          booking.id,
          requester.id,
          text.subject,
          text.body,
          text.intent,
          pick(PRIORITIES),
          status,
          assignee?.id ?? null,
          assignee ? team.teamId : null,
          createdAt,
          lastChange,
          isDone ? finishedAt : null,
          status === "closed" ? minutesAfter(finishedAt, 60) : null,
          status === "new" ? 1 : status === "open" ? 2 : 3,
        ],
      );

      const addEvent = (
        actorId: string | null,
        type: string,
        data: object,
        at: Date,
        visibility = "public",
      ) =>
        client.query(
          `INSERT INTO ticket_events (id, ticket_id, agency_id, actor_id, type, visibility, data, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
          [
            seededUuid(),
            id,
            booking.agency.id,
            actorId,
            type,
            visibility,
            JSON.stringify(data),
            at,
          ],
        );

      const addMessage = async (authorId: string, visibility: string, body: string, at: Date) => {
        const messageId = seededUuid();
        await client.query(
          `INSERT INTO messages (id, ticket_id, agency_id, author_id, visibility, body, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
          [messageId, id, booking.agency.id, authorId, visibility, body, at],
        );
        await addEvent(authorId, "message_added", { message_id: messageId }, at, visibility);
      };

      await addEvent(requester.id, "ticket_created", { intent: text.intent }, createdAt);

      if (assignee) {
        await addEvent(assignee.id, "ticket_assigned", { from: null, to: assignee.id }, assignedAt);
        await addEvent(assignee.id, "status_changed", { from: "new", to: "open" }, assignedAt);
        await addMessage(assignee.id, "public", pick(AGENT_REPLIES), minutesAfter(assignedAt, 5));
        if (random() < 0.5) {
          await addMessage(
            requester.id,
            "public",
            pick(REQUESTER_REPLIES),
            minutesAfter(assignedAt, 15),
          );
        }
        if (random() < 0.4) {
          await addMessage(
            assignee.id,
            "internal",
            pick(INTERNAL_NOTES),
            minutesAfter(assignedAt, 20),
          );
        }
        if (status !== "open") {
          const reached = status === "closed" ? "resolved" : status;
          await addEvent(assignee.id, "status_changed", { from: "open", to: reached }, finishedAt);
        }
        if (status === "closed") {
          const closedAt = minutesAfter(finishedAt, 60);
          await addEvent(
            requester.id,
            "status_changed",
            { from: "resolved", to: "closed" },
            closedAt,
          );
        }
      }
    }

    // A case whose tickets are all closed is closed too.
    await client.query(
      `UPDATE cases c
          SET status = 'closed',
              closed_at = (SELECT max(closed_at) FROM tickets WHERE case_id = c.id)
        WHERE c.status = 'open'
          AND c.booking_id IN (SELECT id FROM bookings WHERE tboh LIKE 'TBOH1______')
          AND EXISTS (SELECT 1 FROM tickets WHERE case_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM tickets WHERE case_id = c.id AND status <> 'closed')`,
    );

    await client.query("COMMIT");
    log(
      `seeded ${COUNTS.agencies} agencies, ${COUNTS.bookings} bookings, ${COUNTS.tickets} tickets. ` +
        `Log in as agent1.eu@opsdesk.test or user1@skyline-travels.test, password ${SEED_PASSWORD}`,
    );
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}

// Run only when started directly (npm run seed), not when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await seed();
}
