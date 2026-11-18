# Decision records

One short record per decision that shaped the system: the situation, what
was chosen, what it costs, and what was turned down. A record is not edited
after the fact; a changed decision gets a new record that replaces the old.

| # | Decision |
|---|---|
| [0001](0001-modular-monolith.md) | One Node codebase (modular monolith), not microservices |
| [0002](0002-postgres-rls-isolation.md) | PostgreSQL is the source of truth; Row-Level Security isolates agencies |
| [0003](0003-own-auth-in-postgres.md) | Accounts and login in our own PostgreSQL, not Firebase or MongoDB |
| [0004](0004-transactional-outbox.md) | Transactional outbox, relayed to a Redis Stream |
| [0005](0005-optimistic-locking.md) | Optimistic locking with `version` and `If-Match` |
| [0006](0006-ml-service-with-fallback.md) | ML as a separate stateless Python service that may fail |
| [0007](0007-react-tanstack-query.md) | React with TanStack Query; no CSS framework |
