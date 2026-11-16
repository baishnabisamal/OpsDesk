-- 002: the application role, its privileges, and Row-Level Security.
--
-- Migrations run as the owner, who bypasses RLS. The API logs in as
-- opsdesk_app, which owns nothing and is NOBYPASSRLS, so every query it runs
-- is filtered by the policies below.

-- The role's password is not in this file. scripts/migrate.ts sets it from
-- the APP_DB_PASSWORD setting after the migrations have run.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opsdesk_app') THEN
    CREATE ROLE opsdesk_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO opsdesk_app;

-- ---------------------------------------------------------------------------
-- Privileges: only what the app needs. No DELETE on anything.
-- ---------------------------------------------------------------------------

GRANT SELECT ON
  regions, agencies, teams, suppliers, users, bookings,
  tickets, ticket_events, messages, idempotency_keys, refresh_tokens
  TO opsdesk_app;

GRANT INSERT, UPDATE ON tickets TO opsdesk_app;
GRANT INSERT, UPDATE ON idempotency_keys TO opsdesk_app;
GRANT INSERT, UPDATE ON refresh_tokens TO opsdesk_app;

-- Append-only: INSERT but no UPDATE, so history cannot be rewritten.
GRANT INSERT ON ticket_events TO opsdesk_app;
GRANT INSERT ON messages TO opsdesk_app;

-- The app only adds outbox rows. Reading and marking them published is the
-- relay's job and is granted in Phase 4.
GRANT INSERT ON outbox TO opsdesk_app;

-- ---------------------------------------------------------------------------
-- Who is asking? tx() sets these three settings at the start of every
-- transaction. They are transaction-local, so they vanish at commit and a
-- pooled connection cannot carry one user's identity into the next request.
--
-- When a setting is missing, current_setting(..., true) gives NULL or ''.
-- nullif turns both into NULL, and a NULL comparison matches no rows:
-- forgetting to set identity shows nothing, not everything.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app_role() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.role', true), '') $$;

CREATE FUNCTION app_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION app_agency_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.agency_id', true), '')::uuid $$;

-- Staff and background jobs see every agency.
CREATE FUNCTION app_sees_all_agencies() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT app_role() IN ('agent', 'escalation_manager', 'lead', 'system') $$;

-- ---------------------------------------------------------------------------
-- Policies. USING filters the rows a query can see or change;
-- WITH CHECK is applied to the new row of an INSERT or UPDATE.
-- ---------------------------------------------------------------------------

ALTER TABLE agencies ENABLE ROW LEVEL SECURITY;
CREATE POLICY agencies_select ON agencies FOR SELECT TO opsdesk_app
  USING (app_sees_all_agencies() OR id = app_agency_id());

-- A requester sees people in their own agency, and staff (agency_id is null)
-- so the author of a reply can be shown.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_select ON users FOR SELECT TO opsdesk_app
  USING (app_sees_all_agencies() OR agency_id = app_agency_id() OR
         (app_agency_id() IS NOT NULL AND agency_id IS NULL));

ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
CREATE POLICY bookings_select ON bookings FOR SELECT TO opsdesk_app
  USING (app_sees_all_agencies() OR agency_id = app_agency_id());

ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
CREATE POLICY tickets_all ON tickets FOR ALL TO opsdesk_app
  USING (app_sees_all_agencies() OR agency_id = app_agency_id())
  WITH CHECK (app_sees_all_agencies() OR agency_id = app_agency_id());

-- Requesters see and write only public rows of their own agency.
-- Internal notes are hidden here, in the database, so no endpoint can leak them.
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY messages_all ON messages FOR ALL TO opsdesk_app
  USING (app_sees_all_agencies() OR (agency_id = app_agency_id() AND visibility = 'public'))
  WITH CHECK (app_sees_all_agencies() OR (agency_id = app_agency_id() AND visibility = 'public'));

ALTER TABLE ticket_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY ticket_events_all ON ticket_events FOR ALL TO opsdesk_app
  USING (app_sees_all_agencies() OR (agency_id = app_agency_id() AND visibility = 'public'))
  WITH CHECK (app_sees_all_agencies() OR (agency_id = app_agency_id() AND visibility = 'public'));

-- A retry key belongs to the user who sent it.
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY idempotency_keys_all ON idempotency_keys FOR ALL TO opsdesk_app
  USING (user_id = app_user_id())
  WITH CHECK (user_id = app_user_id());

-- Login and refresh run as the system actor, before any user is known.
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY refresh_tokens_all ON refresh_tokens FOR ALL TO opsdesk_app
  USING (app_role() = 'system')
  WITH CHECK (app_role() = 'system');

-- regions, teams and suppliers are plain reference data with nothing
-- agency-specific in them, so they have no policy.
-- outbox has no policy either: the app can only INSERT into it, never read it.
