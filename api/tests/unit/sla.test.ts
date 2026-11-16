import fc from "fast-check";
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  addBusinessMinutes,
  BUSINESS_END_HOUR,
  BUSINESS_START_HOUR,
  computeSla,
  isWorse,
  MIN_RESPONSE_MINUTES,
  slaState,
  TRAVEL_BUFFER_MINUTES,
  travelDeadline,
  type BusinessCalendar,
} from "../../src/domain/sla.js";

const BERLIN: BusinessCalendar = { timeZone: "Europe/Berlin", holidays: new Set() };

// Builds an instant from a local wall-clock time in a zone.
function local(iso: string, zone = "Europe/Berlin"): Date {
  return DateTime.fromISO(iso, { zone }).toJSDate();
}

function localText(date: Date, zone = "Europe/Berlin"): string {
  return DateTime.fromJSDate(date, { zone }).toFormat("yyyy-MM-dd HH:mm");
}

const MINUTE = 60_000;

// ---------------------------------------------------------------------------
// Examples: easy to read, one situation each
// ---------------------------------------------------------------------------

describe("addBusinessMinutes (examples)", () => {
  // 16 November 2026 is a Monday.
  it("adds time inside one working day", () => {
    const due = addBusinessMinutes(local("2026-11-16T10:00"), 120, BERLIN);
    expect(localText(due)).toBe("2026-11-16 12:00");
  });

  it("carries over to the next morning when the day runs out", () => {
    // 17:00 + 2h = 1h today, then 1h tomorrow from 09:00.
    const due = addBusinessMinutes(local("2026-11-16T17:00"), 120, BERLIN);
    expect(localText(due)).toBe("2026-11-17 10:00");
  });

  it("starts counting at opening time for a ticket raised at night", () => {
    const due = addBusinessMinutes(local("2026-11-16T22:30"), 60, BERLIN);
    expect(localText(due)).toBe("2026-11-17 10:00");
  });

  it("starts counting at opening time for a ticket raised before work", () => {
    const due = addBusinessMinutes(local("2026-11-16T06:00"), 60, BERLIN);
    expect(localText(due)).toBe("2026-11-16 10:00");
  });

  it("skips the weekend", () => {
    // Friday 17:00 + 2h = Monday 10:00.
    const due = addBusinessMinutes(local("2026-11-20T17:00"), 120, BERLIN);
    expect(localText(due)).toBe("2026-11-23 10:00");
  });

  it("skips a holiday", () => {
    const calendar = { ...BERLIN, holidays: new Set(["2026-11-17"]) };
    const due = addBusinessMinutes(local("2026-11-16T17:00"), 120, calendar);
    expect(localText(due)).toBe("2026-11-18 10:00");
  });

  it("spans several days: 24 business hours is almost three working days", () => {
    // 9 business hours per day. Mon 09:00 + 24h = Wed 15:00.
    const due = addBusinessMinutes(local("2026-11-16T09:00"), 24 * 60, BERLIN);
    expect(localText(due)).toBe("2026-11-18 15:00");
  });

  it("uses the region's clock, not UTC", () => {
    // 07:30 UTC is 11:30 in Dubai (UTC+4): inside office hours there.
    const dubai = { timeZone: "Asia/Dubai", holidays: new Set<string>() };
    const due = addBusinessMinutes(new Date("2026-11-16T07:30:00Z"), 60, dubai);
    expect(due.toISOString()).toBe("2026-11-16T08:30:00.000Z");
  });

  it("is right across a daylight-saving change", () => {
    // Clocks in Berlin go forward on Sunday 28 March 2027. Friday 17:00 + 2h
    // must still be Monday 10:00 local time, although Monday is UTC+2.
    const due = addBusinessMinutes(local("2027-03-26T17:00"), 120, BERLIN);
    expect(localText(due)).toBe("2027-03-29 10:00");
    expect(due.toISOString()).toBe("2027-03-29T08:00:00.000Z");
  });
});

describe("computeSla (examples)", () => {
  const farAway = { checkInAt: local("2027-06-10T14:00"), lcdAt: local("2027-06-01T12:00") };
  const normal = { targetMinutes: 480, businessHoursOnly: true };
  const urgent = { targetMinutes: 120, businessHoursOnly: false };

  it("uses the priority's business time when the trip is far away", () => {
    const result = computeSla({
      createdAt: local("2026-11-16T10:00"),
      policy: normal,
      calendar: BERLIN,
      ...farAway,
    });
    // 8 business hours from Mon 10:00 ends exactly at closing time, 18:00.
    expect(localText(result.dueAt)).toBe("2026-11-16 18:00");
    expect(result.basis).toBe("policy");
  });

  it("an urgent ticket's clock runs through the night", () => {
    const result = computeSla({
      createdAt: local("2026-11-16T23:00"),
      policy: urgent,
      calendar: BERLIN,
      ...farAway,
    });
    expect(localText(result.dueAt)).toBe("2026-11-17 01:00");
  });

  it("is pulled forward when check-in is close", () => {
    // Normal priority would allow until tomorrow, but the guest arrives at 16:00 today.
    const result = computeSla({
      createdAt: local("2026-11-16T12:00"),
      policy: normal,
      calendar: BERLIN,
      checkInAt: local("2026-11-16T16:00"),
      lcdAt: local("2026-11-10T12:00"), // already passed, so it is ignored
    });
    expect(localText(result.dueAt)).toBe("2026-11-16 15:00"); // check-in minus 60 min
    expect(result.basis).toBe("travel_deadline");
  });

  it("is pulled forward by the free-cancellation cut-off when that comes first", () => {
    const result = computeSla({
      createdAt: local("2026-11-16T12:00"),
      policy: normal,
      calendar: BERLIN,
      checkInAt: local("2026-11-20T14:00"),
      lcdAt: local("2026-11-16T15:00"),
    });
    expect(localText(result.dueAt)).toBe("2026-11-16 14:00");
    expect(result.basis).toBe("travel_deadline");
  });

  it("still gives a minimum response time when the guest is almost there", () => {
    const createdAt = local("2026-11-16T12:00");
    const result = computeSla({
      createdAt,
      policy: normal,
      calendar: BERLIN,
      checkInAt: local("2026-11-16T12:20"),
      lcdAt: local("2026-11-10T12:00"),
    });
    expect(result.dueAt.getTime()).toBe(createdAt.getTime() + MIN_RESPONSE_MINUTES * MINUTE);
    expect(result.basis).toBe("minimum");
  });

  it("ignores travel dates that are both in the past", () => {
    const result = computeSla({
      createdAt: local("2026-11-16T10:00"),
      policy: normal,
      calendar: BERLIN,
      checkInAt: local("2026-11-01T14:00"),
      lcdAt: local("2026-10-20T12:00"),
    });
    expect(result.basis).toBe("policy");
  });

  it("puts the at-risk moment at the last fifth of the time", () => {
    const createdAt = local("2026-11-16T10:00");
    const result = computeSla({ createdAt, policy: urgent, calendar: BERLIN, ...farAway });
    // 120 minutes in total, so at risk for the last 24.
    expect(result.atRiskAt.getTime()).toBe(createdAt.getTime() + 96 * MINUTE);
  });
});

describe("slaState", () => {
  const atRiskAt = new Date("2026-11-16T10:00:00Z");
  const dueAt = new Date("2026-11-16T11:00:00Z");

  it.each([
    ["2026-11-16T09:59:59Z", "on_track"],
    ["2026-11-16T10:00:00Z", "at_risk"],
    ["2026-11-16T10:59:59Z", "at_risk"],
    ["2026-11-16T11:00:00Z", "breached"],
    ["2026-11-17T00:00:00Z", "breached"],
  ])("at %s the state is %s", (now, expected) => {
    expect(slaState(new Date(now), atRiskAt, dueAt)).toBe(expected);
  });

  it("knows which state is worse", () => {
    expect(isWorse("at_risk", "on_track")).toBe(true);
    expect(isWorse("breached", "at_risk")).toBe(true);
    expect(isWorse("at_risk", "breached")).toBe(false);
    expect(isWorse("on_track", "on_track")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Properties: statements that must hold for EVERY input.
// fast-check invents hundreds of inputs per property and, if one breaks the
// statement, shrinks it to the smallest failing case.
// ---------------------------------------------------------------------------

const ZONES = ["Europe/Berlin", "Asia/Dubai", "Asia/Singapore", "America/New_York", "UTC"];

// Any instant in 2026 to 2028, to the minute. That range crosses many
// daylight-saving changes, weekends, and year ends.
const anyInstant = fc
  .integer({ min: Date.UTC(2026, 0, 1) / MINUTE, max: Date.UTC(2028, 11, 31) / MINUTE })
  .map((minutes) => new Date(minutes * MINUTE));

// A calendar with a random zone and up to 20 random holidays.
const anyCalendar = fc
  .record({
    timeZone: fc.constantFrom(...ZONES),
    holidayOffsets: fc.array(fc.integer({ min: 0, max: 1095 }), { maxLength: 20 }),
  })
  .map(({ timeZone, holidayOffsets }) => ({
    timeZone,
    holidays: new Set(
      holidayOffsets.map((days) => DateTime.utc(2026, 1, 1).plus({ days }).toISODate()!),
    ),
  }));

const anyMinutes = fc.integer({ min: 0, max: 3 * 24 * 60 });

const anyPolicy = fc.record({
  targetMinutes: fc.integer({ min: 15, max: 2 * 24 * 60 }),
  businessHoursOnly: fc.boolean(),
});

// Travel dates from 10 days before the ticket to 60 days after it.
const anyOffsetMinutes = fc.integer({ min: -10 * 24 * 60, max: 60 * 24 * 60 });

describe("addBusinessMinutes (properties)", () => {
  it("the result is never before the start", () => {
    fc.assert(
      fc.property(anyInstant, anyMinutes, anyCalendar, (start, minutes, calendar) => {
        expect(addBusinessMinutes(start, minutes, calendar).getTime()).toBeGreaterThanOrEqual(
          start.getTime(),
        );
      }),
    );
  });

  it("the result is always inside office hours on a working day", () => {
    fc.assert(
      fc.property(anyInstant, anyMinutes, anyCalendar, (start, minutes, calendar) => {
        const result = DateTime.fromJSDate(addBusinessMinutes(start, minutes, calendar), {
          zone: calendar.timeZone,
        });
        const minuteOfDay = result.hour * 60 + result.minute;

        expect(result.weekday).toBeLessThanOrEqual(5);
        expect(calendar.holidays.has(result.toISODate()!)).toBe(false);
        expect(minuteOfDay).toBeGreaterThanOrEqual(BUSINESS_START_HOUR * 60);
        expect(minuteOfDay).toBeLessThanOrEqual(BUSINESS_END_HOUR * 60);
      }),
    );
  });

  it("asking for more time never gives an earlier answer", () => {
    fc.assert(
      fc.property(anyInstant, anyMinutes, anyMinutes, anyCalendar, (start, a, b, calendar) => {
        const less = addBusinessMinutes(start, Math.min(a, b), calendar);
        const more = addBusinessMinutes(start, Math.max(a, b), calendar);
        expect(more.getTime()).toBeGreaterThanOrEqual(less.getTime());
      }),
    );
  });

  it("adding in two steps equals adding in one", () => {
    fc.assert(
      fc.property(anyInstant, anyMinutes, anyMinutes, anyCalendar, (start, a, b, calendar) => {
        const twoSteps = addBusinessMinutes(addBusinessMinutes(start, a, calendar), b, calendar);
        const oneStep = addBusinessMinutes(start, a + b, calendar);
        expect(twoSteps.getTime()).toBe(oneStep.getTime());
      }),
    );
  });
});

// Phase 3 gate: the SLA property holds for generated inputs.
describe("computeSla (properties)", () => {
  const anySlaInput = fc
    .record({
      createdAt: anyInstant,
      policy: anyPolicy,
      calendar: anyCalendar,
      checkInOffset: anyOffsetMinutes,
      lcdGap: fc.integer({ min: 0, max: 30 * 24 * 60 }),
    })
    .map(({ createdAt, policy, calendar, checkInOffset, lcdGap }) => {
      const checkInAt = new Date(createdAt.getTime() + checkInOffset * MINUTE);
      // Free cancellation always ends at or before check-in, as the database requires.
      const lcdAt = new Date(checkInAt.getTime() - lcdGap * MINUTE);
      return { createdAt, policy, calendar, checkInAt, lcdAt };
    });

  it("the deadline is never after the travel deadline minus the buffer", () => {
    fc.assert(
      fc.property(anySlaInput, (input) => {
        const { dueAt } = computeSla(input);
        const deadline = travelDeadline(input.createdAt, input.checkInAt, input.lcdAt);
        if (deadline === null) return; // both dates passed: nothing to protect

        // The one allowed exception is the minimum response time, when the
        // trip is so close that "deadline minus buffer" has already gone.
        const latestAllowed = Math.max(
          deadline.getTime() - TRAVEL_BUFFER_MINUTES * MINUTE,
          input.createdAt.getTime() + MIN_RESPONSE_MINUTES * MINUTE,
        );
        expect(dueAt.getTime()).toBeLessThanOrEqual(latestAllowed);
      }),
      { numRuns: 1000 },
    );
  });

  it("the deadline is never later than the priority alone would allow", () => {
    fc.assert(
      fc.property(anySlaInput, (input) => {
        const withTravel = computeSla(input);
        const policyOnly = computeSla({
          ...input,
          // Travel dates in the past switch the travel rule off.
          checkInAt: new Date(0),
          lcdAt: new Date(0),
        });
        expect(withTravel.dueAt.getTime()).toBeLessThanOrEqual(policyOnly.dueAt.getTime());
      }),
      { numRuns: 500 },
    );
  });

  it("a ticket always gets at least the minimum response time", () => {
    fc.assert(
      fc.property(anySlaInput, (input) => {
        const { dueAt } = computeSla(input);
        const minimum = input.createdAt.getTime() + MIN_RESPONSE_MINUTES * MINUTE;
        expect(dueAt.getTime()).toBeGreaterThanOrEqual(minimum);
      }),
      { numRuns: 500 },
    );
  });

  it("created < at-risk moment < deadline, always in that order", () => {
    fc.assert(
      fc.property(anySlaInput, (input) => {
        const { dueAt, atRiskAt } = computeSla(input);
        expect(atRiskAt.getTime()).toBeGreaterThan(input.createdAt.getTime());
        expect(atRiskAt.getTime()).toBeLessThan(dueAt.getTime());
      }),
      { numRuns: 500 },
    );
  });

  it("the same input always gives the same answer", () => {
    fc.assert(
      fc.property(anySlaInput, (input) => {
        expect(computeSla(input)).toEqual(computeSla(input));
      }),
    );
  });
});
