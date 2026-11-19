import { useEffect, useRef } from "react";

// A quiet moving background for the pages where no ticket work happens (the
// landing page and the signed-out account pages). It draws the system at
// work: queues as lanes, tickets as slips travelling along them, routing as a
// slip changing lane, a resolved ticket leaving a tick, and the hour lines of
// the SLA clock drifting past. About one slip in nine is at risk (signal).
//
// It is a fixed canvas behind the page, so it keeps running while the page
// scrolls; scrolling only shifts the lanes a little (parallax). It stops when
// the tab is hidden, and with reduced motion it paints one still frame.
// Everything is faint on purpose: text on top must keep its contrast.

type Slip = {
  lane: number; // current lane index
  toLane: number; // lane it is moving to (routing)
  laneT: number; // 0..1 progress of the lane change
  x: number;
  speed: number; // px per second
  endX: number; // where it resolves
  risk: boolean;
  label: string | null;
  fading: number; // 0 while travelling, then 0..1 as it resolves
};

type Tick = { x: number; y: number; age: number };

const LANE_GAP = 72;
const HOUR_GAP = 132;
// Measured: the darkest point (an at-risk slip) keeps landing-page body text at
// 7.7:1 or more. Raise these only after measuring again.
const ALPHA = { lane: 0.045, hour: 0.04, slip: 0.055, label: 0.07, risk: 0.14, tick: 0.12 };

function rgb(hex: string): [number, number, number] {
  const h = hex.trim().replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h.slice(0, 6);
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const smooth = (p: number) => p * p * (3 - 2 * p);

export function OpsBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let lanes = 0;
    let ink: [number, number, number] = [28, 26, 22];
    let signal: [number, number, number] = [217, 72, 15];
    let slips: Slip[] = [];
    let ticks: Tick[] = [];
    let clock = 0; // seconds since start, drives the hour lines
    // A fixed-seed random generator: the same picture on every load.
    let seed = 7;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };

    const readColours = () => {
      const style = getComputedStyle(canvas);
      ink = rgb(style.getPropertyValue("--ink") || "#1c1a16");
      signal = rgb(style.getPropertyValue("--signal") || "#d9480f");
    };

    const newSlip = (anywhere: boolean): Slip => {
      const lane = Math.floor(random() * lanes);
      const n = 1000000 + Math.floor(random() * 60);
      return {
        lane,
        toLane: lane,
        laneT: 1,
        x: anywhere ? random() * width : -60 - random() * 200,
        speed: 14 + random() * 30,
        endX: width * (0.45 + random() * 0.6),
        risk: random() < 0.11,
        label: random() < 0.35 ? `TBOH${n}` : null,
        fading: 0,
      };
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      lanes = Math.ceil(height / LANE_GAP) + 2;
      const wanted = Math.round((width * height) / 30000);
      slips = slips.filter((s) => s.lane < lanes);
      while (slips.length < wanted) slips.push(newSlip(true));
      slips.length = Math.min(slips.length, wanted);
    };

    const step = (dt: number) => {
      clock += dt;
      for (const slip of slips) {
        if (slip.fading > 0) {
          slip.fading += dt / 0.6;
          continue;
        }
        slip.x += slip.speed * dt;
        if (slip.laneT < 1) slip.laneT = Math.min(1, slip.laneT + dt / 1.4);
        else if (slip.lane !== slip.toLane) slip.lane = slip.toLane;
        // Routing: now and then a slip moves to a neighbouring queue.
        if (slip.laneT >= 1 && random() < dt * 0.05) {
          const to = slip.lane + (random() < 0.5 ? -1 : 1) * (1 + Math.floor(random() * 2));
          if (to >= 0 && to < lanes) {
            slip.toLane = to;
            slip.laneT = 0;
          }
        }
        if (slip.x >= slip.endX) slip.fading = 0.0001;
      }
      for (const tick of ticks) tick.age += dt;
      ticks = ticks.filter((t) => t.age < 2.4);
      slips = slips.map((slip) => {
        if (slip.fading >= 1) {
          ticks.push({ x: slip.x + 13, y: laneY(slip), age: 0 });
          return newSlip(false);
        }
        return slip;
      });
    };

    let scrollShift = 0;
    const laneY = (slip: Slip) => {
      const from = slip.lane * LANE_GAP;
      const to = slip.toLane * LANE_GAP;
      return from + (to - from) * smooth(slip.laneT) + LANE_GAP / 2 - scrollShift;
    };

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      const [ir, ig, ib] = ink;
      const [sr, sg, sb] = signal;
      const inkA = (a: number) => `rgba(${ir},${ig},${ib},${a})`;

      // Hour lines of the clock, drifting left.
      ctx.fillStyle = inkA(ALPHA.hour);
      const offset = (clock * 9) % HOUR_GAP;
      for (let x = -offset; x < width; x += HOUR_GAP) ctx.fillRect(Math.round(x), 0, 1, height);

      // Queue lanes.
      ctx.fillStyle = inkA(ALPHA.lane);
      for (let i = 0; i < lanes; i += 1) {
        const y = Math.round(i * LANE_GAP + LANE_GAP / 2 - scrollShift + 7);
        ctx.fillRect(0, y, width, 1);
      }

      // Slips.
      ctx.font = '500 10px "IBM Plex Mono", ui-monospace, monospace';
      ctx.textBaseline = "bottom";
      for (const slip of slips) {
        const y = laneY(slip);
        if (y < -20 || y > height + 20) continue;
        const fade = 1 - Math.min(1, slip.fading);
        ctx.fillStyle = slip.risk
          ? `rgba(${sr},${sg},${sb},${ALPHA.risk * fade})`
          : inkA(ALPHA.slip * fade);
        ctx.beginPath();
        ctx.roundRect(slip.x, y, 26, 8, 2);
        ctx.fill();
        if (slip.label) {
          ctx.fillStyle = inkA(ALPHA.label * fade);
          ctx.fillText(slip.label, slip.x, y - 3);
        }
      }

      // Ticks where tickets were resolved.
      ctx.lineWidth = 1.5;
      for (const tick of ticks) {
        const a = ALPHA.tick * (1 - tick.age / 2.4);
        ctx.strokeStyle = inkA(a);
        ctx.beginPath();
        ctx.moveTo(tick.x - 4, tick.y + 4);
        ctx.lineTo(tick.x - 1, tick.y + 7);
        ctx.lineTo(tick.x + 5, tick.y);
        ctx.stroke();
      }
    };

    const onScroll = () => {
      scrollShift = (window.scrollY * 0.12) % LANE_GAP;
    };

    readColours();
    resize();
    onScroll();

    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => {
      readColours();
      draw();
    };
    scheme.addEventListener("change", onScheme);
    window.addEventListener("resize", resize);
    window.addEventListener("scroll", onScroll, { passive: true });

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    if (reduced) {
      // One still frame, as if the system had been running for a while.
      for (let i = 0; i < 400; i += 1) step(0.05);
      draw();
    } else {
      let last = performance.now();
      const tick = (now: number) => {
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        if (!document.hidden) {
          step(dt);
          draw();
        }
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    }

    return () => {
      cancelAnimationFrame(frame);
      scheme.removeEventListener("change", onScheme);
      window.removeEventListener("resize", resize);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  return <canvas ref={canvasRef} className="ops-backdrop" aria-hidden="true" />;
}
