import http from "k6/http";

// Shared by both load tests. Runs against the throwaway database that
// tools/load.sh seeds, never against dev data.

export const BASE = __ENV.BASE_URL || "http://127.0.0.1:3300";
export const PASSWORD = "Password123!";

// The seeded agencies (api/scripts/seed.ts), each with user1@<slug>.test.
export const AGENCY_SLUGS = [
  "skyline-travels",
  "globe-trotters",
  "sunrise-holidays",
  "atlas-tours",
  "bluewave-trips",
];

export function login(email) {
  const res = http.post(
    `${BASE}/api/v1/auth/login`,
    JSON.stringify({ email, password: PASSWORD }),
    {
      headers: { "Content-Type": "application/json" },
      tags: { name: "setup" },
    },
  );
  if (res.status !== 200) throw new Error(`login ${email}: ${res.status} ${res.body}`);
  return res.json("access_token");
}

export function auth(token, extra = {}) {
  return { headers: { Authorization: `Bearer ${token}`, ...extra } };
}

export function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

// Prints the numbers that matter in plain words, and saves the full summary.
export function summary(data, file) {
  const lines = [];
  for (const [name, metric] of Object.entries(data.metrics)) {
    if (!name.startsWith("http_req_duration{") && name !== "http_req_duration") continue;
    const v = metric.values;
    lines.push(
      `${name.padEnd(48)} p50 ${v.med.toFixed(1)} ms   p95 ${v["p(95)"].toFixed(1)} ms   p99 ${v["p(99)"].toFixed(1)} ms   max ${v.max.toFixed(1)} ms`,
    );
  }
  const reqs = data.metrics.http_reqs.values;
  const failed = data.metrics.http_req_failed.values.rate;
  lines.push(
    `requests ${reqs.count} (${reqs.rate.toFixed(1)}/s), failed ${(failed * 100).toFixed(2)}%`,
  );
  return { stdout: lines.sort().join("\n") + "\n", [file]: JSON.stringify(data, null, 2) };
}
