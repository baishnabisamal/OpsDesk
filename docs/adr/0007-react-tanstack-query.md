# 0007: React with TanStack Query; no CSS framework

**Status:** accepted (Phase 6)

## Context

The UI is mostly server data that other people change: queues, tickets,
timelines. It must stay fresh, survive token expiry, and show conflicts.

## Decision

React with Vite. Server data lives in TanStack Query under keys such as
`["ticket", id]`; mutations and live events only mark keys stale. WebSocket
events carry no data to paint; the API stays the single source of truth, so
visibility rules (internal notes) are never bypassed. Styling is one CSS file
with colour tokens (dark mode swaps the tokens), IBM Plex and Instrument Serif.

## Consequences

- Little hand-written state: caching, refetching, retries and paging come from
  the library.
- Cost: some data is refetched after an event instead of patched in place.
- The deliberate visual style (warm paper and ink, one signal colour) is cheap
  to keep consistent because every colour is a token.

## Alternatives turned down

- **Redux for server data:** a lot of code to rebuild what TanStack Query does.
- **Tailwind or a component kit:** fast to start, but tends toward the generic
  look the owner asked to avoid.
