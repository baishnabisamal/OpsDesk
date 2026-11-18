# 0003: Accounts and login in our own PostgreSQL, not Firebase or MongoDB

**Status:** accepted (Phase 1 login; Phase 6 sign-up, verification, reset, invitations)

## Context

Phase 6 needed real sign-up: agencies create accounts, prove their email,
reset forgotten passwords, and leads add staff. The question was whether to
hand identity to a hosted service (Firebase Authentication, Auth0, Clerk) and
whether user data should move to a document store such as MongoDB.

## Decision

Keep accounts in the same PostgreSQL database, in the `users` table that the
rest of the schema already points at.

- Passwords: argon2id hashes. Sessions: 15-minute JWT access tokens and
  single-use, rotating refresh tokens with reuse detection (Phase 1).
- Email links (verify, reset, invite): 32 random bytes; only the SHA-256 is
  stored (`auth_tokens`, migration 015); one live token per person and
  purpose; claimed with one `UPDATE ... RETURNING`, so a link works once.
- No account enumeration: sign-up, "forgot password" and "resend" answer the
  same 202 whether or not the address exists; the email says what happened.
- Staff never sign up. A lead invites them, and only to non-lead roles.

## Why not Firebase (or another hosted identity provider)

- Users are referenced by foreign keys from tickets, messages, events,
  refresh tokens and routing tables, and Row-Level Security reads the role and
  agency from the token. A hosted provider would hold identity outside the
  database, and every user would need a mirrored row kept in sync by webhooks.
- The roles (requester, agent, escalation manager, lead) and the agency of each
  user are business data with rules (a requester must have an agency; staff must
  not). Those rules are database constraints here.
- Login, refresh rotation and reuse detection are part of what this project
  demonstrates, and are tested under concurrency.
- It would add an external dependency to every request and to local
  development and CI.

A hosted provider is the right call when a product needs social login, SSO
(SAML/OIDC for enterprise customers), MFA or passkeys soon. The swap point is
small: `authenticate` in `core/auth.ts` verifies a token and builds a
`Principal`; it could verify the provider's token instead and look the user up
by its subject id.

## Why not MongoDB

The data is relational (agencies, bookings, cases, tickets, users) and the
integrity rules depend on foreign keys, unique constraints, transactions and
Row-Level Security. Splitting users into a second database would lose all of
that for the most security-sensitive table, and a ticket and its author could
no longer be written in one transaction.

## Consequences

- We own password storage and email delivery: rate limits on every public
  `/auth/*` route, argon2id, hashed tokens, and Mailpit locally.
- Not built: MFA, social login, SSO. Agency users cannot invite colleagues yet
  (only staff invitations exist).
