# Demo script

A 10-minute walk through OpsDesk for an interview or a review. Each part
shows one idea, says what to point at, and names the test that proves it.

## Before you start (once)

```sh
make setup          # .env and dependencies
make up             # PostgreSQL, Redis, Mailpit
make migrate seed   # schema and demo data (password for every demo account: Password123!)
make ml-setup ml-train   # optional: the intent model
```

Start these in five terminals, then open http://localhost:5173:

```sh
make dev        # API, port 3000
make worker     # outbox relay, email, SLA scan, routing retry, nightly jobs
make realtime   # WebSocket gateway, port 3001
make web        # React app, port 5173
make ml-dev     # optional: ML service, port 8001
```

Mailpit (every email the system sends) is at http://localhost:8025.

## 1. Sign up as a new agency (2 min)

1. On the sign-in page click **Create an account**. Fill in an agency name, your
   name, an email and a password of 10+ characters.
2. Try to sign in straight away: it refuses with **Confirm your email first**
   and offers to send the link again.
3. Open Mailpit, open "Confirm your email for OpsDesk", click the link. You are
   signed in, as a user of the new agency, and see no other agency's tickets.

Point at:

- The token is after `#` in the link, so it never reaches a server log, and
  the page removes it from the address bar.
- Sign up again with the same email: the same "check your email" answer, and
  Mailpit gets "You already have an account". A stranger cannot find out which
  addresses have accounts.
- Decision record [0003](adr/0003-own-auth-in-postgres.md): why accounts live in
  PostgreSQL and not Firebase or MongoDB.
- Tests: `api/tests/integration/accounts.test.ts` (10 simultaneous sign-ups
  with one email create one account; a link opened twice at once works once).

## 2. An agency raises a ticket (1 min)

Sign out, then use the demo button **Travel agency user**. Click **Raise a
ticket**, write "Guest at reception, hotel has no booking TBOH1000026", choose
Urgent, send.

Point at:

- The ticket lands with an intent (from the model or the keyword rules), an SLA
  deadline from priority, check-in and the free-cancellation date, and joins
  the open case of that booking.
- The form keeps one Idempotency-Key: a double click creates one ticket
  (test: 10 simultaneous retries create 1 ticket).

## 3. Two agents, one ticket: live updates and conflicts (3 min)

Open two browser windows side by side: **Team lead** in one, **Escalation
manager** in the other (a private window keeps the sessions apart). Open the
same ticket in both.

1. Change the priority in one window. The other updates by itself, well under
   a second later (outbox, Redis Stream, Socket.IO; the dot says **Live**).
2. Stop the realtime gateway (`Ctrl+C` in its terminal), so one window can no
   longer hear about changes. Change the priority in the other window, then
   change it again in this one: the banner **Someone else changed this ticket
   first** appears, the latest version is on screen, and **Apply my change
   again** saves on top of it.

Point at:

- The `v12` next to the buttons: every change sends `If-Match: "12"`.
- The screen changed before the server answered (optimistic UI), and went back
  when the server refused.
- Decision records [0004](adr/0004-transactional-outbox.md),
  [0005](adr/0005-optimistic-locking.md). Tests: 12 simultaneous edits, 1 wins
  (`workflow.test.ts`); `web/src/api/mutations.test.tsx`.

## 4. Internal notes never leak (1 min)

As staff, switch the composer to **Internal note** (it turns into a yellow pad)
and add one. Open the same ticket as the agency user: the note is not there.

Point at: the database hides internal rows from requesters (Row-Level
Security), so no endpoint can leak them, including the WebSocket gateway.
Test: `messages.test.ts`.

## 5. Queues, routing and SLA (1 min)

As the agent, open **Triage**, **My queue**, **Escalations**. Rows are ordered
by SLA deadline; the clock and bar turn ochre (at risk) and brick (breached).
Use `j` / `k` and Enter.

Point at: the partial indexes behind each queue, and the routing test (100
simultaneous creates never exceed an agent's cap or assign twice).

## 6. Leads: team, insights, export (1 min)

As **Team lead**: **Team** lists everyone with their load; invite someone by
email and accept the invitation from Mailpit. **Insights and export**: weekly
themes and a streaming CSV export (100,000 rows in 4.8 s with flat memory).

## 7. The numbers (1 min)

```sh
make load       # k6: 50 reads/s and 5 creates/s over 200,000 tickets
make contract   # Schemathesis: thousands of generated requests, no 500
make test       # 815 API tests and 24 web tests
```

Results are in [load-test.md](load-test.md). Read p95 was 10.9 ms against a
150 ms target; create p95 68.9 ms against 300 ms. The single API process
saturates at about 1,700 reads per second on a laptop.
