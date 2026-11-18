# Load test results

Measured with k6 by `make load` (`tools/load.sh`, scripts in `load/`) on
2026-11-19, on the development laptop (Apple Silicon MacBook Air), against a
throwaway database with the demo seed plus 200,000 tickets (95% closed
history, 5% live in triage). One API process, PostgreSQL and Redis in Docker,
the ML service running, so every create includes a real classify call.

The load is **open** (k6 `constant-arrival-rate`): requests start on schedule
whether or not earlier ones have finished, like independent users. A closed
loop would slow down with the server and hide the problem.

## Phase 6 gate: met

| Target (README section 3)                                | Load                          | Measured p95 | p99     | Errors |
| -------------------------------------------------------- | ----------------------------- | ------------ | ------- | ------ |
| Reads p95 under 150 ms at 50 requests/s                  | 50/s for 60 s, 3,012 requests | **10.9 ms**  | 14.5 ms | 0%     |
| Create p95 under 300 ms (classify, link, route included) | 5/s for 60 s, 352 requests    | **68.9 ms**  | 80.8 ms | 0%     |

Reads are a working-day mix: triage, my queue and escalation queues, the
ticket list, full-text search, a ticket, its timeline, and an agency user's
list.

### Per endpoint at 50 reads/s

| Endpoint                                   | p50     | p95     |
| ------------------------------------------ | ------- | ------- |
| `GET /tickets/:id`                         | 4.5 ms  | 6.3 ms  |
| `GET /queues/mine`                         | 4.9 ms  | 6.8 ms  |
| `GET /queues/escalations`                  | 4.9 ms  | 6.8 ms  |
| `GET /tickets/:id/timeline`                | 5.8 ms  | 7.6 ms  |
| `GET /tickets`                             | 5.8 ms  | 8.0 ms  |
| `GET /tickets` (agency user, RLS filtered) | 6.3 ms  | 8.6 ms  |
| `GET /queues/triage` (10,000 live tickets) | 7.3 ms  | 9.8 ms  |
| `GET /tickets?q=refund` (full-text search) | 12.8 ms | 15.6 ms |

Search is the slowest read, as expected: it ranks matches over 200,000 rows.

## Finding the limit

| Target rate                  | Achieved    | Read p95 | Create rate | Create p95 |
| ---------------------------- | ----------- | -------- | ----------- | ---------- |
| 50 reads/s, 5 creates/s      | 49.8/s      | 11.5 ms  | 5.8/s       | 68.5 ms    |
| 400 reads/s, 40 creates/s    | 397/s       | 6.3 ms   | 40.5/s      | 38.8 ms    |
| 3,000 reads/s, 150 creates/s | **1,733/s** | 126.9 ms | 139/s       | 796 ms     |

At 3,000 requests per second the API could not keep up: it served about
1,730 per second and every request queued. **Where the bottleneck is:** every
endpoint slowed by the same amount, including the trivial `GET /tickets/:id`.
A database bottleneck would hurt the heavy queries (search, triage) first;
an equal slowdown everywhere points at the one thing all requests share, the
single Node.js process (one event loop on one CPU core). Next steps if that
load were real: run several API processes (the API keeps no state in memory),
then a read replica for the queue views.

Latencies at 400/s were lower than at 50/s. The most likely reason is the
laptop's CPU staying at full clock speed under steady load (not measured);
either way, treat differences of a few milliseconds as noise.

## What the ML call costs

|                                                                        | Create p95 |
| ---------------------------------------------------------------------- | ---------- |
| With the ML service (classify + similarity calls)                      | 68.5 ms    |
| Without (`NO_ML=1`: connection refused, rules fallback, breaker opens) | 47.5 ms    |

About 21 ms of a create is the model. The rest is the database work:
idempotency key, booking lookup, case find-or-create, SLA maths, routing under
row locks, the ticket, its event and its outbox row, in one transaction.

## Caveats

- One laptop runs everything, including k6. A server with separate machines
  would behave differently; these numbers show the design has a large margin,
  not what production would see.
- The design load is 50,000 tickets a day (about 0.6 creates per second on
  average). The test ran at 8 times the read target and about 70 times the
  average create rate before anything got slow.
- 200,000 tickets is about four days of the design load. A year would be about
  18 million; the queue indexes are partial (live tickets only), so queue reads
  should not grow with history, but this was not measured at that size.
