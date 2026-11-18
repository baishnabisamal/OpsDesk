# 0004: Transactional outbox, relayed to a Redis Stream

**Status:** accepted (Phase 4)

## Context

A state change must reach browsers (WebSocket) and email. Publishing to Redis
inside the request is a "dual write": the database commit can succeed and the
publish fail (or the reverse), and the event is lost or invented.

## Decision

Every state change inserts an `outbox` row in the same transaction as the
change itself. A relay process claims unpublished rows (lease), publishes them
to the Redis Stream `opsdesk:events`, then marks them published. Consumers (the
WebSocket gateway, the email worker) read the stream.

## Consequences

- A committed change always produces its event, possibly twice (at-least-once).
  Consumers deduplicate: the gateway by `event_id`, email by a fixed Message-ID
  and a deliveries table.
- Events arrive after commit, with a small delay (measured: under 2 s to a
  browser; about 220 ms in the Phase 6 browser test).
- Account emails do NOT use the outbox: they contain a raw token, and the
  database only stores token hashes. They are sent after commit instead.

## Alternatives turned down

- **Publish after commit, no outbox:** a crash between commit and publish
  silently drops the event.
- **Kafka:** the same pattern with much more to run, for six writes a second.
