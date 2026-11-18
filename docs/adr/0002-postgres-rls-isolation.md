# 0002: PostgreSQL is the source of truth; Row-Level Security isolates agencies

**Status:** accepted (Phase 1)

## Context

Many travel agencies share one system. Agency A must never see Agency B's
tickets, on any endpoint, including ones written later by someone in a hurry.

## Decision

All business data lives in PostgreSQL. The API connects as `opsdesk_app`, a
role that owns nothing and cannot bypass Row-Level Security. Every query runs
inside `tx(principal, fn)`, which sets the caller's role and agency with
transaction-local `set_config`. Policies on each table filter rows by those
settings. Hidden and missing rows are both a 404.

## Consequences

- A forgotten `WHERE agency_id = ...` cannot leak data: the database adds it.
- Settings are transaction-local, so a pooled connection cannot carry one
  user's identity into the next request.
- Cost: every query needs a transaction, and system work done during a
  requester's request (routing, load counters) has to switch identity
  explicitly (`asSystem`).

## Alternatives turned down

- **Filtering in application code only:** one missed filter is a data leak.
- **A database per agency:** strong isolation, but migrations, pooling and
  staff queries across agencies all get much harder.
