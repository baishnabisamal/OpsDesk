# 0006: ML as a separate stateless Python service that may fail

**Status:** accepted (Phase 2)

## Context

Intent classification and text similarity are best done with Python's ML
libraries. Ticket creation must keep working when that code is slow or down.

## Decision

A small FastAPI service answers questions about text (`/classify`,
`/similarity`, `/themes/cluster`). It has no database access and owns no data.
The Node client has a short timeout and a circuit breaker; on failure the
ticket gets the rule-based intent (or `other`) and `needs_review = true`.

## Consequences

- Creation never waits long on the model. Load test: the ML call adds about
  21 ms to create's p95 (68.5 ms with it, 47.5 ms without).
- The model is trained on synthetic data; its macro-F1 shows the pipeline
  works, not real-world accuracy.

## Alternatives turned down

- **Model inside the Node process:** weaker libraries, and a heavy model would
  share the API's CPU.
- **A hosted LLM API per ticket:** cost, latency and an external dependency on
  the write path.
