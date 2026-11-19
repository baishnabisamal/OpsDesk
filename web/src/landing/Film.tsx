import { useCallback, useEffect, useRef, useState } from "react";

// The landing page's 15-second film: one ticket's life in OpsDesk, drawn in
// code. Three agencies write about one booking, the messages become one case,
// the intent is read, the SLA clock is worked out from the trip, routing picks
// an agent, and the change reaches every screen live.
//
// How it moves: one function, paint(t), turns a time between 0 and 15 seconds
// into the style of every element. Nothing is a CSS animation. That gives
// three things for free:
//   - the chapter buttons can jump to any moment (seek = paint once),
//   - reduced motion shows one finished still instead of the loop,
//   - a script can step through the frames one by one and record a video
//     (see FilmCapture at the bottom and tools/film.mjs).
//
// The stage is drawn at 1120 x 720 and scaled to fit. Everything that must be
// read sits between x = 150 and x = 970, so a phone can crop the edges.

export const FILM_SECONDS = 15;
const W = 1120;
const H = 720;

export const CHAPTERS = [
  { label: "Arrive", at: 0 },
  { label: "Group", at: 2.4 },
  { label: "Classify", at: 4.4 },
  { label: "Clock", at: 6.4 },
  { label: "Route", at: 9.2 },
  { label: "Live", at: 11.8 },
] as const;

// A still for reduced motion and for the first paint: routing has just chosen.
const POSTER_TIME = 11.45;

// --- Timing helpers ---------------------------------------------------------

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
/** 0 before a, 1 after b, a straight line between. */
const seg = (t: number, a: number, b: number) => clamp((t - a) / (b - a));
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
const outExpo = (p: number) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p));
const inExpo = (p: number) => (p <= 0 ? 0 : Math.pow(2, 10 * p - 10));
const inOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const outBack = (p: number) => {
  const c = 1.70158;
  return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2);
};
/** Visible between a and b: fades in over `fadeIn` seconds, out over `fadeOut`. */
const win = (t: number, a: number, b: number, fadeIn = 0.3, fadeOut = 0.3) =>
  Math.min(seg(t, a, a + fadeIn), 1 - seg(t, b - fadeOut, b));

type Look = {
  o?: number; // opacity
  x?: number; // px, from the element's own place
  y?: number;
  s?: number; // scale
  r?: number; // degrees
  sx?: number; // horizontal scale (bars, rules)
  clip?: number; // 0..1, revealed from the left
};

type Frame = { looks: Record<string, Look>; text: Record<string, string> };

// --- The script ---------------------------------------------------------------

const HEADLINES: [string, number, number, string][] = [
  ["h0", 0.1, 2.35, "Three agencies, one booking."],
  ["h1", 2.45, 4.35, "Grouped into one case."],
  ["h2", 4.45, 6.35, "Read, and sorted by intent."],
  ["h3", 6.45, 9.15, "A deadline that knows the trip."],
  ["h4", 9.25, 11.75, "The right agent, under their limit."],
  ["h5", 11.85, 13.55, "Everyone sees it, live."],
];

const CARDS = [
  {
    agency: "Skyline Travels",
    time: "09:58",
    before: "Guest wants to cancel ",
    after: ", please confirm no charge.",
    left: 150,
    top: 170,
    from: { x: -520, y: 0, r: -9 },
    rest: -3,
    start: 0.15,
    stack: { x: 245, y: 120, r: -1.5 },
    z: 3,
  },
  {
    agency: "Coastline Trips",
    time: "10:01",
    before: "Re ",
    after: ": is cancelling still free until Tuesday?",
    left: 640,
    top: 150,
    from: { x: 520, y: 0, r: 8 },
    rest: 2.5,
    start: 0.45,
    stack: { x: -231, y: 168, r: 2 },
    z: 1,
  },
  {
    agency: "Northstar Holidays",
    time: "10:02",
    before: "Customer asks us to drop ",
    after: ". Any fee?",
    left: 395,
    top: 380,
    from: { x: 0, y: 420, r: -4 },
    rest: -1.5,
    start: 0.75,
    stack: { x: 7, y: -76, r: 0.5 },
    z: 2,
  },
];

const TBOH = "TBOH1000026";

const INTENTS = [
  { label: "refund", value: 0.03 },
  { label: "amendment", value: 0.02 },
  { label: "payment", value: 0.01 },
  { label: "cancellation", value: 0.94 },
];

// SLA axis: Monday 09:00 to Tuesday 12:00 over 820 px.
const AX_LEFT = 150;
const PX_PER_HOUR = 820 / 27;
const atHour = (hoursAfterMon9: number) => AX_LEFT + hoursAfterMon9 * PX_PER_HOUR;
const X_CREATED = atHour(1); // Mon 10:00
const X_RISK = atHour(7.4); // Mon 16:24
const X_DUE = atHour(9); // Mon 18:00
const X_TUE9 = atHour(24);
const X_BUFFER = atHour(26); // Tue 11:00
const X_LCD = atHour(27); // Tue 12:00

const AGENTS = [
  { name: "Aisha", state: "online", load: "6 / 10", score: 56, why: "skill +40 · room +16" },
  { name: "Ben", state: "online", load: "0 / 10", score: 40, why: "room +40" },
  { name: "Chen", state: "offline", load: "2 / 10", score: 0, why: "" },
  { name: "Dara", state: "at limit", load: "10 / 10", score: 0, why: "" },
];

function hhmm(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = Math.floor(minutes % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function frameAt(t: number): Frame {
  const L: Record<string, Look> = {};
  const T: Record<string, string> = {};

  // Headlines: rise in, lift out.
  for (const [key, a, b] of HEADLINES) {
    L[key] = {
      o: win(t, a, b, 0.45, 0.25),
      y: (1 - outExpo(seg(t, a, a + 0.7))) * 30 - inExpo(seg(t, b - 0.25, b)) * 18,
    };
  }

  // 1-3. The three messages: fly in, pile into one case, slide aside.
  const toSide = inOut(seg(t, 4.4, 5.0));
  CARDS.forEach((card, i) => {
    const enter = outExpo(seg(t, card.start, card.start + 0.85));
    const pile = inOut(seg(t, 2.4 + i * 0.07, 3.2 + i * 0.07));
    let x = lerp(card.from.x, 0, enter) + card.stack.x * pile - 230 * toSide;
    let y = lerp(card.from.y, 0, enter) + card.stack.y * pile;
    const r = lerp(lerp(card.from.r, card.rest, enter), card.stack.r, pile);
    // The cards drop out of the picture at the end of scene 3.
    const leave = inExpo(seg(t, 6.15, 6.45));
    y += leave * 60;
    x += 0;
    L[`card${i}`] = { o: win(t, card.start, 6.45, 0.2, 0.3), x, y, r, s: lerp(1, 0.94, toSide) };
    // The booking reference in each message is underlined, one after another.
    L[`u${i}`] = { sx: outExpo(seg(t, 1.45 + i * 0.16, 1.85 + i * 0.16)) };
  });

  // 2. The booking reference, letter by letter, above the pile.
  [...TBOH].forEach((_, i) => {
    const p = seg(t, 2.85 + i * 0.04, 3.1 + i * 0.04);
    L[`tc${i}`] = { o: p, y: (1 - outExpo(p)) * 26 };
  });
  L.tok = { o: 1 - seg(t, 4.35, 4.6), y: -24 * inOut(seg(t, 4.35, 4.6)) };
  L.caseLabel = { o: win(t, 3.3, 4.4, 0.3, 0.25) };

  // 3. A scan line reads the top message; the model's scores fill in.
  L.scan = { o: win(t, 4.75, 5.6, 0.1, 0.2), y: 136 * inOut(seg(t, 4.75, 5.55)) };
  INTENTS.forEach((intent, i) => {
    const enter = seg(t, 4.75 + i * 0.08, 5.05 + i * 0.08);
    const fill = outExpo(seg(t, 4.95 + i * 0.06, 5.65));
    L[`ir${i}`] = { o: win(t, 4.75 + i * 0.08, 6.4, 0.3, 0.25), y: (1 - outExpo(enter)) * 18 };
    L[`ib${i}`] = { sx: Math.max(0.006, intent.value * fill) };
    T[`iv${i}`] = (intent.value * fill).toFixed(2);
  });
  L.iwin = { o: seg(t, 5.65, 5.85) * (1 - seg(t, 6.15, 6.4)) };
  L.itag = { o: win(t, 5.85, 6.4, 0.25, 0.25), y: (1 - outExpo(seg(t, 5.85, 6.2))) * 10 };

  // 4. The SLA clock, worked out on a time axis.
  const clockOut = 1 - seg(t, 8.95, 9.2);
  L.axis = { o: win(t, 6.5, 9.2, 0.1, 0.25), sx: outExpo(seg(t, 6.5, 7.1)) };
  L.days = { o: seg(t, 6.8, 7.1) * clockOut };
  L.block0 = { o: clockOut, sx: outExpo(seg(t, 6.9, 7.35)) };
  L.block1 = { o: clockOut, sx: outExpo(seg(t, 7.0, 7.45)) };
  L.night = { o: seg(t, 7.05, 7.4) * clockOut };
  L.created = { o: seg(t, 7.1, 7.35) * clockOut, y: (1 - outExpo(seg(t, 7.1, 7.5))) * 14 };
  L.lcd = { o: seg(t, 7.35, 7.6) * clockOut, y: (1 - outExpo(seg(t, 7.35, 7.8))) * -24 };
  L.buffer = { o: seg(t, 7.7, 7.95) * clockOut };
  const fill = inOut(seg(t, 7.6, 8.4));
  L.fill = { o: clockOut, sx: Math.max(0.001, fill) };
  L.risk = { o: seg(t, 8.22, 8.32) * clockOut };
  L.needle = {
    o: seg(t, 8.35, 8.45) * clockOut,
    y: lerp(-90, 0, outBack(seg(t, 8.35, 8.8))),
  };
  L.riskLabel = { o: seg(t, 8.6, 8.85) * clockOut };
  L.clock = { o: win(t, 6.6, 9.2, 0.35, 0.25), y: (1 - outExpo(seg(t, 6.6, 7.2))) * 24 };
  const minutes = 600 + 480 * fill;
  T.clockNum = hhmm(Math.round(minutes / 6) * 6);

  // 5. Routing: filter out who cannot take it, score who can, pick one.
  AGENTS.forEach((agent, i) => {
    const enter = seg(t, 9.3 + i * 0.09, 9.75 + i * 0.09);
    const dim = i >= 2 ? lerp(1, 0.32, seg(t, 10.2 + (i - 2) * 0.1, 10.5 + (i - 2) * 0.1)) : 1;
    L[`ag${i}`] = {
      o: win(t, 9.3 + i * 0.09, 11.8, 0.35, 0.25) * dim,
      y: (1 - outExpo(enter)) * 32,
    };
    if (i >= 2) {
      L[`strike${i}`] = { sx: outExpo(seg(t, 9.9 + (i - 2) * 0.12, 10.3 + (i - 2) * 0.12)) };
    } else {
      T[`score${i}`] = String(Math.round(agent.score * outExpo(seg(t, 10.3, 11.0))));
      L[`why${i}`] = { o: seg(t, 10.45, 10.75) };
    }
  });
  L.picked = { o: win(t, 11.0, 11.8, 0.02, 0.25), clip: inOut(seg(t, 11.0, 11.35)) };
  L.assigned = { o: win(t, 11.3, 11.8, 0.12, 0.25), s: lerp(0.6, 1, outBack(seg(t, 11.3, 11.55))) };

  // 6. Live: the status changes and both screens hear about it.
  L.ticket = {
    o: win(t, 11.85, 13.6, 0.35, 0.25),
    s: lerp(0.92, 1, outExpo(seg(t, 11.85, 12.35))),
  };
  L.pNew = { o: win(t, 11.9, 12.35, 0.2, 0.12), y: -10 * seg(t, 12.23, 12.35) };
  L.pOpen = {
    o: win(t, 12.35, 12.95, 0.12, 0.12),
    y: 10 * (1 - seg(t, 12.35, 12.47)) - 10 * seg(t, 12.83, 12.95),
  };
  L.pDone = { o: win(t, 12.95, 13.6, 0.12, 0.25), y: 10 * (1 - seg(t, 12.95, 13.07)) };
  for (let i = 0; i < 3; i += 1) {
    const p = seg(t, 12.35 + i * 0.22, 13.3 + i * 0.22);
    L[`ring${i}`] = { o: p > 0 && p < 1 ? (1 - p) * 0.85 : 0, s: lerp(0.35, 1.45, outExpo(p)) };
  }
  L.screenA = { o: win(t, 12.05, 13.6, 0.3, 0.25), x: (1 - outExpo(seg(t, 12.05, 12.5))) * -36 };
  L.screenB = { o: win(t, 12.1, 13.6, 0.3, 0.25), x: (1 - outExpo(seg(t, 12.1, 12.55))) * 36 };
  L.wireA = { sx: outExpo(seg(t, 12.4, 12.75)), o: 1 - seg(t, 13.35, 13.6) };
  L.wireB = { sx: outExpo(seg(t, 12.45, 12.8)), o: 1 - seg(t, 13.35, 13.6) };
  L.dotA = { o: seg(t, 12.7, 12.8) * (1 - seg(t, 13.35, 13.6)), s: outBack(seg(t, 12.7, 12.95)) };
  L.dotB = { o: seg(t, 12.8, 12.9) * (1 - seg(t, 13.35, 13.6)), s: outBack(seg(t, 12.8, 13.05)) };
  L.latency = { o: win(t, 12.85, 13.6, 0.2, 0.25) };

  // 7. The name.
  [..."OpsDesk"].forEach((_, i) => {
    const p = seg(t, 13.65 + i * 0.05, 14.15 + i * 0.05);
    L[`w${i}`] = { o: p, y: (1 - outExpo(p)) * 96 };
  });
  L.wdot = { s: outBack(seg(t, 14.2, 14.45)), o: seg(t, 14.2, 14.3) };
  L.wrule = { sx: outExpo(seg(t, 14.05, 14.5)) };
  L.wtag = { o: seg(t, 14.2, 14.5), y: (1 - outExpo(seg(t, 14.2, 14.6))) * 12 };

  // The loop starts and ends on an empty frame.
  L.veil = { o: Math.max(1 - seg(t, 0, 0.12), seg(t, 14.72, 15)) };

  // Corner readouts.
  const chapter = [...CHAPTERS].reverse().find((c) => t >= c.at) ?? CHAPTERS[0];
  const index = CHAPTERS.indexOf(chapter);
  T.chapter = t >= 13.6 ? "07 · OpsDesk" : `0${index + 1} · ${chapter.label}`;
  T.timecode = `00:${String(Math.floor(t)).padStart(2, "0")}.${String(Math.floor((t % 1) * 100)).padStart(2, "0")}`;
  L.playhead = { sx: t / FILM_SECONDS };

  return { looks: L, text: T };
}

function apply(el: HTMLElement, look: Look) {
  const o = look.o ?? 1;
  el.style.opacity = String(o);
  el.style.visibility = o <= 0.001 ? "hidden" : "visible";
  const parts: string[] = [];
  if (look.x !== undefined || look.y !== undefined) {
    parts.push(`translate3d(${(look.x ?? 0).toFixed(2)}px, ${(look.y ?? 0).toFixed(2)}px, 0)`);
  }
  if (look.r !== undefined) parts.push(`rotate(${look.r.toFixed(3)}deg)`);
  if (look.s !== undefined) parts.push(`scale(${look.s.toFixed(4)})`);
  if (look.sx !== undefined) parts.push(`scaleX(${look.sx.toFixed(4)})`);
  el.style.transform = parts.join(" ");
  if (look.clip !== undefined)
    el.style.clipPath = `inset(0 ${((1 - look.clip) * 100).toFixed(2)}% 0 0)`;
}

// --- The stage (pure markup; paint() moves it) --------------------------------

function useStage() {
  const nodes = useRef(new Map<string, HTMLElement>());
  const ref = useCallback(
    (key: string) => (el: HTMLElement | null) => {
      if (el) nodes.current.set(key, el);
      else nodes.current.delete(key);
    },
    [],
  );
  const paint = useCallback((t: number) => {
    const { looks, text } = frameAt(t);
    for (const [key, look] of Object.entries(looks)) {
      const el = nodes.current.get(key);
      if (el) apply(el, look);
    }
    for (const [key, value] of Object.entries(text)) {
      const el = nodes.current.get(key);
      if (el && el.textContent !== value) el.textContent = value;
    }
  }, []);
  return { ref, paint };
}

function Stage({
  r,
  hud = false,
}: {
  r: (key: string) => (el: HTMLElement | null) => void;
  hud?: boolean;
}) {
  return (
    <div className="film-stage" style={{ width: W, height: H }} aria-hidden="true">
      {HEADLINES.map(([key, , , words]) => (
        <p key={key} ref={r(key)} className="film-head">
          {words}
        </p>
      ))}

      {/* 1-3: messages */}
      {CARDS.map((card, i) => (
        <div
          key={card.agency}
          ref={r(`card${i}`)}
          className="film-card"
          style={{ left: card.left, top: card.top, zIndex: card.z }}
        >
          <div className="film-card-meta">
            <span>{card.agency}</span>
            <span>{card.time}</span>
          </div>
          <p>
            {card.before}
            <span className="film-tboh">
              {TBOH}
              <i ref={r(`u${i}`)} />
            </span>
            {card.after}
          </p>
        </div>
      ))}
      <div ref={r("scan")} className="film-scan" style={{ left: 165, top: 290 }} />

      <div ref={r("tok")} className="film-token" style={{ top: 168 }}>
        {[...TBOH].map((ch, i) => (
          <span key={i} ref={r(`tc${i}`)}>
            {ch}
          </span>
        ))}
      </div>
      <p ref={r("caseLabel")} className="film-mono film-case-label" style={{ top: 476 }}>
        Case 7de7 · 3 tickets · 3 agencies
      </p>

      {/* 3: intent scores */}
      <div className="film-intents" style={{ left: 600, top: 268 }}>
        {INTENTS.map((intent, i) => (
          <div key={intent.label} ref={r(`ir${i}`)} className="film-intent">
            <span>{intent.label}</span>
            <b>
              <i ref={r(`ib${i}`)} />
            </b>
            <em ref={r(`iv${i}`)}>0.00</em>
          </div>
        ))}
        <div ref={r("iwin")} className="film-intent film-intent-win" style={{ top: 3 * 46 }}>
          <span>cancellation</span>
          <b>
            <i style={{ transform: "scaleX(0.94)" }} />
          </b>
          <em>0.94</em>
        </div>
        <p ref={r("itag")} className="film-mono film-intent-tag">
          Above 0.60 · no review needed
        </p>
      </div>

      {/* 4: the SLA clock */}
      <div ref={r("clock")} className="film-clock" style={{ top: 150 }}>
        <p className="film-mono">SLA · normal priority · 8 business hours</p>
        <strong ref={r("clockNum")}>10:00</strong>
      </div>
      <div ref={r("axis")} className="film-axis" style={{ left: AX_LEFT, top: 486, width: 820 }} />
      <div ref={r("days")}>
        <span className="film-mono film-day" style={{ left: AX_LEFT, top: 500 }}>
          Mon
        </span>
        <span className="film-mono film-day" style={{ left: atHour(15), top: 500 }}>
          Tue
        </span>
      </div>
      <div
        ref={r("block0")}
        className="film-block"
        style={{ left: AX_LEFT, top: 446, width: atHour(9) - AX_LEFT }}
      />
      <div
        ref={r("block1")}
        className="film-block"
        style={{ left: X_TUE9, top: 446, width: X_LCD - X_TUE9 }}
      />
      <div
        ref={r("night")}
        className="film-night"
        style={{ left: X_DUE + 8, top: 466, width: X_TUE9 - X_DUE - 16 }}
      >
        <span className="film-mono">night and weekend do not count</span>
      </div>
      <div
        ref={r("fill")}
        className="film-fill"
        style={{ left: X_CREATED, top: 462, width: X_DUE - X_CREATED }}
      />
      <div
        ref={r("risk")}
        className="film-risk"
        style={{ left: X_RISK, top: 462, width: X_DUE - X_RISK }}
      />
      <div ref={r("created")} className="film-marker" style={{ left: X_CREATED, top: 420 }}>
        <span className="film-mono">Created 10:00</span>
      </div>
      <div ref={r("lcd")} className="film-flag" style={{ left: X_LCD, top: 380 }}>
        <span className="film-mono">Free cancel until Tue 12:00</span>
      </div>
      <div
        ref={r("buffer")}
        className="film-buffer"
        style={{ left: X_BUFFER, top: 520, width: X_LCD - X_BUFFER }}
      >
        <span className="film-mono">−60 min</span>
      </div>
      <div ref={r("needle")} className="film-needle" style={{ left: X_DUE, top: 360 }}>
        <span className="film-mono">Due 18:00</span>
      </div>
      <p
        ref={r("riskLabel")}
        className="film-mono film-risk-label"
        style={{ left: X_RISK, top: 530 }}
      >
        At risk from 16:24
      </p>

      {/* 5: routing */}
      <div className="film-agents" style={{ left: 210, top: 210 }}>
        {AGENTS.map((agent, i) => (
          <div key={agent.name} ref={r(`ag${i}`)} className="film-agent" style={{ top: i * 80 }}>
            <strong>{agent.name}</strong>
            <span className="film-mono">{agent.state}</span>
            <span className="film-mono">{agent.load}</span>
            {i < 2 ? (
              <>
                <em ref={r(`why${i}`)} className="film-mono">
                  {agent.why}
                </em>
                <b ref={r(`score${i}`)}>0</b>
              </>
            ) : (
              <i ref={r(`strike${i}`)} className="film-strike" />
            )}
          </div>
        ))}
        <div ref={r("picked")} className="film-agent film-agent-picked" style={{ top: 0 }}>
          <strong>Aisha</strong>
          <span className="film-mono">online</span>
          <span className="film-mono">6 / 10</span>
          <em className="film-mono">skill +40 · room +16</em>
          <b>56</b>
        </div>
        <span ref={r("assigned")} className="film-assigned film-mono">
          Assigned
        </span>
      </div>

      {/* 6: live */}
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          ref={r(`ring${i}`)}
          className="film-ring"
          style={{ left: W / 2 - 160, top: 340 - 160 }}
        />
      ))}
      <div ref={r("screenA")} className="film-screen" style={{ left: 150, top: 290 }}>
        <span className="film-mono">Agent · Aisha</span>
        <i ref={r("dotA")} />
      </div>
      <div ref={r("screenB")} className="film-screen" style={{ left: 830, top: 290 }}>
        <span className="film-mono">Agency · Skyline</span>
        <i ref={r("dotB")} />
      </div>
      <div ref={r("wireA")} className="film-wire" style={{ left: 290, top: 340, width: 40 }} />
      <div
        ref={r("wireB")}
        className="film-wire film-wire-r"
        style={{ left: 790, top: 340, width: 40 }}
      />
      <div ref={r("ticket")} className="film-ticket" style={{ left: 330, top: 262 }}>
        <p className="film-mono">{TBOH} · cancellation</p>
        <strong>Assigned to Aisha</strong>
        <div className="film-pills">
          <span ref={r("pNew")} className="film-pill">
            New
          </span>
          <span ref={r("pOpen")} className="film-pill">
            Open
          </span>
          <span ref={r("pDone")} className="film-pill film-pill-done">
            Resolved
          </span>
        </div>
      </div>
      <p ref={r("latency")} className="film-mono film-latency" style={{ top: 460 }}>
        event to both screens · 214 ms
      </p>

      {/* 7: the name */}
      <div className="film-word" style={{ top: 190 }}>
        {[..."OpsDesk"].map((ch, i) => (
          <span key={i} ref={r(`w${i}`)}>
            {ch}
          </span>
        ))}
        <i ref={r("wdot")} />
      </div>
      <div ref={r("wrule")} className="film-wrule" style={{ left: 360, top: 452, width: 400 }} />
      <p ref={r("wtag")} className="film-mono film-wtag" style={{ top: 470 }}>
        Travel operations, on time
      </p>

      {/* Corner readouts: only in the recorded video; the page has its own controls. */}
      {hud ? (
        <>
          <p ref={r("chapter")} className="film-mono film-corner" style={{ left: 150, top: 664 }}>
            01 · Arrive
          </p>
          <p
            ref={r("timecode")}
            className="film-mono film-corner film-corner-r"
            style={{ right: W - 970, top: 664 }}
          >
            00:00.00
          </p>
          <div className="film-track" style={{ left: 150, top: 652, width: 820 }}>
            <i ref={r("playhead")} />
          </div>
        </>
      ) : null}

      <div ref={r("veil")} className="film-veil" />
    </div>
  );
}

// Fits the 1120 x 720 stage into its box: by height on wide screens, and on
// narrow ones by the readable middle (820 px), letting the edges crop.
function useFit(box: React.RefObject<HTMLDivElement | null>) {
  const [scale, setScale] = useState(0.8);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      setScale(Math.min(height / H, Math.max(width / 880, width / W)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [box]);
  return scale;
}

export function Film() {
  const { ref, paint } = useStage();
  const box = useRef<HTMLDivElement>(null);
  const scale = useFit(box);
  // Reduced motion: start paused on the poster still. Read once, at mount.
  const [startAt] = useState(() =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches ? POSTER_TIME : null,
  );
  const [playing, setPlaying] = useState(startAt === null);
  const [chapter, setChapter] = useState(() => chapterIndex(startAt ?? 0));
  const time = useRef(startAt ?? 0);
  const visible = useRef(true);

  const seek = useCallback(
    (t: number) => {
      time.current = t;
      paint(t);
      setChapter(chapterIndex(t));
    },
    [paint],
  );

  useEffect(() => {
    paint(time.current);
  }, [paint]);

  // Pause while the film is off screen: no work for something nobody sees.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => {
      visible.current = entry?.isIntersecting ?? true;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (visible.current) {
        time.current = (time.current + dt) % FILM_SECONDS;
        paint(time.current);
        const index = chapterIndex(time.current);
        setChapter((current) => (current === index ? current : index));
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, paint]);

  return (
    <figure className="film">
      <div ref={box} className="film-box">
        <div className="film-fit" style={{ transform: `translate(-50%, -50%) scale(${scale})` }}>
          <Stage r={ref} />
        </div>
      </div>
      <figcaption className="film-controls lp-wrap">
        <button
          type="button"
          className="film-play"
          onClick={() => setPlaying((p) => !p)}
          aria-label={playing ? "Pause the film" : "Play the film"}
        >
          {playing ? (
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <rect x="3.5" y="3" width="3" height="10" />
              <rect x="9.5" y="3" width="3" height="10" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4.5 2.8v10.4L13 8z" />
            </svg>
          )}
        </button>
        <ol className="film-chapters" aria-label="Chapters of the film">
          {CHAPTERS.map((c, i) => (
            <li key={c.label}>
              <button
                type="button"
                aria-current={i === chapter ? "step" : undefined}
                onClick={() => seek(c.at + 0.6)}
              >
                <span className="film-chapter-n">0{i + 1}</span> {c.label}
              </button>
            </li>
          ))}
        </ol>
        <span className="sr-only">
          A 15-second film: three travel agencies write about booking {TBOH}; OpsDesk groups the
          messages into one case, reads the intent as a cancellation, sets the deadline to Monday
          18:00 from business hours and the free-cancellation date, assigns the agent with the right
          skill and room, and shows the status change on both screens live.
        </span>
      </figcaption>
    </figure>
  );
}

function chapterIndex(t: number) {
  let index = 0;
  CHAPTERS.forEach((c, i) => {
    if (t >= c.at) index = i;
  });
  return index;
}

// For recording the film as a video: the stage alone, at a fixed size, moved
// only by window.__filmSeek(t) from a script (tools/film.mjs).
export function FilmCapture() {
  const { ref, paint } = useStage();
  useEffect(() => {
    const w = window as unknown as { __filmSeek?: (t: number) => void; __filmReady?: boolean };
    w.__filmSeek = paint;
    paint(0);
    void document.fonts.ready.then(() => {
      w.__filmReady = true;
    });
  }, [paint]);
  return (
    <div className="film-capture">
      <div className="film-fit" style={{ transform: `translate(-50%, -50%) scale(${1080 / H})` }}>
        <Stage r={ref} hud />
      </div>
    </div>
  );
}
