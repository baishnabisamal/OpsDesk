# 0001: One Node codebase (modular monolith), not microservices

**Status:** accepted (Phase 0)

## Context

The design load is 50,000 tickets a day: about 0.6 writes per second on
average. Most features need several things to change together (a ticket, its
timeline entry, the event that announces it).

## Decision

One Node.js codebase owns every write. The API, the WebSocket gateway and the
workers are separate processes started from the same code. Inside, the code
keeps hard module boundaries: `routes` parse, `services` change state,
`domain` holds pure rules, `db` runs transactions.

## Consequences

- One database transaction can cover everything that must change together.
  With separate services this needs a saga or two-phase commit.
- One deploy, one log stream, one place to debug.
- Cost: one failure domain. A slow endpoint shares the process with fast
  ones; slow work therefore goes to workers.
- The load test (Phase 6) found the single API process saturates at about
  1,700 reads per second on a laptop. That is about 3,000 times the average
  design load; the next step would be running several API processes behind a
  load balancer, which the stateless API already allows.

## Alternatives turned down

- **Microservices** (tickets, routing, notifications): network calls and
  distributed transactions in place of function calls, for no gain at this load.
