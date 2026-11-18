-- 015: self-service accounts. Agencies sign up, prove their email address,
-- reset forgotten passwords; leads invite staff. (Phase 6)
--
-- Accounts stay in PostgreSQL, next to everything they protect: users are
-- referenced by foreign keys from tickets, messages, events and RLS. A second
-- user store (Firebase, MongoDB) would split that and lose the foreign keys.

-- NULL = the person has not proved they own this email address yet.
ALTER TABLE users ADD COLUMN email_verified_at timestamptz;

-- Everyone who existed before this migration was created by an admin or the
-- seed, so they count as verified.
UPDATE users SET email_verified_at = created_at;

-- ---------------------------------------------------------------------------
-- Single-use tokens sent by email: verify an address, reset a password,
-- accept an invitation. Like refresh tokens, only the SHA-256 hash is stored,
-- so a leaked table cannot be used to take over accounts.
-- ---------------------------------------------------------------------------
CREATE TABLE auth_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  purpose     text NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,  -- set when used, or when a newer token replaces it
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT auth_tokens_purpose_valid
    CHECK (purpose IN ('verify_email', 'reset_password', 'invite')),
  CONSTRAINT auth_tokens_expiry_after_creation CHECK (expires_at > created_at)
);

-- At most one live token per person and purpose: asking for a new link
-- retires the old one, so an old email cannot be used after a newer one.
CREATE UNIQUE INDEX auth_tokens_one_live
  ON auth_tokens (user_id, purpose) WHERE used_at IS NULL;

-- ---------------------------------------------------------------------------
-- Privileges and policies. Account changes are the system's work (nobody is
-- logged in during sign-up or a reset), so only the system actor may write.
-- A lead's invitation is checked in the service, which then writes as system.
-- ---------------------------------------------------------------------------
GRANT INSERT ON agencies TO opsdesk_app;
GRANT INSERT ON users TO opsdesk_app;
-- Column-level: the app can change these fields of a user and nothing else.
GRANT UPDATE (password_hash, email_verified_at) ON users TO opsdesk_app;
GRANT SELECT, INSERT, UPDATE ON auth_tokens TO opsdesk_app;

CREATE POLICY agencies_insert ON agencies FOR INSERT TO opsdesk_app
  WITH CHECK (app_role() = 'system');

CREATE POLICY users_insert ON users FOR INSERT TO opsdesk_app
  WITH CHECK (app_role() = 'system');

CREATE POLICY users_update ON users FOR UPDATE TO opsdesk_app
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE auth_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY auth_tokens_all ON auth_tokens FOR ALL TO opsdesk_app
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
