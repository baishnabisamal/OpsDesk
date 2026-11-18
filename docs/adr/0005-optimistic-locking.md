# 0005: Optimistic locking with `version` and `If-Match`

**Status:** accepted (Phase 1; UI in Phase 6)

## Context

Two agents can edit the same ticket at the same time. The later save must not
silently erase the earlier one (a "lost update").

## Decision

Every ticket has a `version`. `GET` returns it as an `ETag`; every change
sends it back in `If-Match`. The update runs `WHERE id = $1 AND version = $2`
and increments the version. No match means someone else changed it first: 409
`version_conflict`. A missing header is 428.

In the web app, a change is shown at once (optimistic UI). On a conflict the
screen rolls back, loads the latest ticket, and offers "Apply my change again"
on top of it or "Keep theirs".

## Consequences

- No locks are held while a person thinks; conflicts are rare and cheap.
- The user always sees why a change did not happen.
- Tested: 12 simultaneous edits, exactly 1 wins (Phase 1); the conflict banner
  and retry in a real browser (Phase 6).

## Alternatives turned down

- **Last write wins:** silent data loss.
- **Pessimistic locks while a ticket is open on screen:** locks left behind by
  closed tabs, and agents blocking each other.
