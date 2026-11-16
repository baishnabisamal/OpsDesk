-- 001: core tables for Phase 1.
-- Rules followed here (README section 8):
--   every reference is a foreign key with an explicit ON DELETE rule,
--   NOT NULL unless absence has a meaning,
--   CHECK for closed value sets and cross-column rules,
--   all instants are timestamptz.

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------

CREATE TABLE regions (
  code       text PRIMARY KEY,
  name       text NOT NULL,
  time_zone  text NOT NULL  -- business hours depend on it (used from Phase 3)
);

INSERT INTO regions (code, name, time_zone) VALUES
  ('MEA',  'Middle East and Africa', 'Asia/Dubai'),
  ('EU',   'Europe',                 'Europe/Berlin'),
  ('APAC', 'Asia Pacific',           'Asia/Singapore'),
  ('AMER', 'Americas',               'America/New_York');

CREATE TABLE agencies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,  -- deactivate, never delete
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL UNIQUE,
  region_code  text NOT NULL REFERENCES regions (code) ON DELETE RESTRICT
);

CREATE TABLE suppliers (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code  text NOT NULL UNIQUE,
  name  text NOT NULL
);

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL,
  password_hash  text NOT NULL,
  full_name      text NOT NULL,
  role           text NOT NULL,
  agency_id      uuid REFERENCES agencies (id) ON DELETE RESTRICT,
  team_id        uuid REFERENCES teams (id) ON DELETE RESTRICT,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT users_role_valid
    CHECK (role IN ('requester', 'agent', 'escalation_manager', 'lead')),
  -- A requester must belong to an agency; staff must not.
  CONSTRAINT users_agency_matches_role
    CHECK ((role = 'requester') = (agency_id IS NOT NULL)),
  -- Only staff can be in a support team.
  CONSTRAINT users_team_only_for_staff
    CHECK (role <> 'requester' OR team_id IS NULL)
);

-- Emails are unique ignoring case: A@x.com and a@x.com are the same person.
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

-- ---------------------------------------------------------------------------
-- Bookings
-- ---------------------------------------------------------------------------

CREATE TABLE bookings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tboh             text NOT NULL UNIQUE,
  agency_id        uuid NOT NULL REFERENCES agencies (id) ON DELETE RESTRICT,
  supplier_id      uuid NOT NULL REFERENCES suppliers (id) ON DELETE RESTRICT,
  region_code      text NOT NULL REFERENCES regions (code) ON DELETE RESTRICT,
  hotel_name       text NOT NULL,
  check_in_date    date NOT NULL,          -- a calendar date at the hotel
  hotel_time_zone  text NOT NULL,          -- turns that date into an instant
  lcd_at           timestamptz NOT NULL,   -- last free cancellation, exact instant
  amount           numeric(12,2) NOT NULL,
  currency         char(3) NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT bookings_amount_not_negative CHECK (amount >= 0),
  CONSTRAINT bookings_currency_upper CHECK (currency = upper(currency)),
  -- Free cancellation cannot end after the check-in day is over.
  CONSTRAINT bookings_lcd_before_check_in
    CHECK (lcd_at < ((check_in_date + 1)::timestamp AT TIME ZONE hotel_time_zone)),
  -- Lets tickets point at (id, agency_id) so their agency copy cannot be wrong.
  CONSTRAINT bookings_id_agency_unique UNIQUE (id, agency_id)
);

-- ---------------------------------------------------------------------------
-- Tickets
-- ---------------------------------------------------------------------------

CREATE TABLE tickets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id     uuid NOT NULL REFERENCES agencies (id) ON DELETE RESTRICT,
  booking_id    uuid NOT NULL,
  requester_id  uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,

  subject       text NOT NULL,
  body          text NOT NULL,
  -- Kept up to date by PostgreSQL itself; the subject counts more than the body.
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', subject), 'A') ||
    setweight(to_tsvector('english', body), 'B')
  ) STORED,

  intent        text NOT NULL DEFAULT 'other',
  priority      text NOT NULL DEFAULT 'normal',

  status        text NOT NULL DEFAULT 'new',
  assignee_id   uuid REFERENCES users (id) ON DELETE RESTRICT,  -- null = unassigned
  team_id       uuid REFERENCES teams (id) ON DELETE RESTRICT,

  -- Copied from the booking at create so lists can sort without a join.
  check_in_at   timestamptz NOT NULL,
  lcd_at        timestamptz NOT NULL,
  region_code   text NOT NULL REFERENCES regions (code) ON DELETE RESTRICT,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  closed_at     timestamptz,

  version       integer NOT NULL DEFAULT 1,  -- optimistic locking

  -- The ticket's agency must be the booking's agency.
  CONSTRAINT tickets_booking_same_agency
    FOREIGN KEY (booking_id, agency_id) REFERENCES bookings (id, agency_id) ON DELETE RESTRICT,
  -- Lets messages and events point at (id, agency_id).
  CONSTRAINT tickets_id_agency_unique UNIQUE (id, agency_id),

  CONSTRAINT tickets_subject_length CHECK (char_length(subject) BETWEEN 1 AND 200),
  CONSTRAINT tickets_body_length CHECK (char_length(body) BETWEEN 1 AND 10000),
  CONSTRAINT tickets_intent_valid CHECK (intent IN
    ('booking_not_found', 'cancellation', 'amendment', 'refund', 'voucher', 'payment', 'other')),
  CONSTRAINT tickets_priority_valid CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  CONSTRAINT tickets_status_valid CHECK (status IN
    ('new', 'open', 'pending', 'escalated', 'resolved', 'closed')),
  CONSTRAINT tickets_new_has_no_assignee CHECK (status <> 'new' OR assignee_id IS NULL),
  CONSTRAINT tickets_resolved_at_matches_status
    CHECK ((resolved_at IS NOT NULL) = (status IN ('resolved', 'closed'))),
  CONSTRAINT tickets_closed_at_matches_status
    CHECK ((closed_at IS NOT NULL) = (status = 'closed')),
  CONSTRAINT tickets_version_positive CHECK (version >= 1)
);

-- Indexes follow the queries (README section 7).
-- An agency's tickets, newest first, paged:
CREATE INDEX tickets_agency_newest ON tickets (agency_id, created_at DESC, id DESC);
-- Staff list across all agencies, newest first, paged:
CREATE INDEX tickets_newest ON tickets (created_at DESC, id DESC);
-- All tickets on a booking:
CREATE INDEX tickets_booking ON tickets (booking_id);
-- "My tickets": only live ones, so the index stays small.
CREATE INDEX tickets_assignee_live ON tickets (assignee_id, created_at DESC)
  WHERE status NOT IN ('resolved', 'closed');
-- Text search:
CREATE INDEX tickets_search ON tickets USING gin (search_vector);

-- ---------------------------------------------------------------------------
-- Timeline (append-only, partitioned by month)
-- ---------------------------------------------------------------------------

CREATE TABLE ticket_events (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  ticket_id   uuid NOT NULL,
  agency_id   uuid NOT NULL,  -- copy, so RLS checks one column without a join
  actor_id    uuid REFERENCES users (id) ON DELETE RESTRICT,  -- null = system
  type        text NOT NULL,
  visibility  text NOT NULL DEFAULT 'public',
  data        jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),

  -- PostgreSQL requires the partition key in the primary key.
  PRIMARY KEY (id, created_at),
  CONSTRAINT ticket_events_ticket_same_agency
    FOREIGN KEY (ticket_id, agency_id) REFERENCES tickets (id, agency_id) ON DELETE RESTRICT,
  CONSTRAINT ticket_events_type_valid CHECK (type IN
    ('ticket_created', 'ticket_updated', 'status_changed', 'ticket_assigned', 'message_added')),
  CONSTRAINT ticket_events_visibility_valid CHECK (visibility IN ('public', 'internal'))
) PARTITION BY RANGE (created_at);

CREATE INDEX ticket_events_by_ticket ON ticket_events (ticket_id, created_at);

-- ---------------------------------------------------------------------------
-- Messages (append-only, partitioned by month)
-- ---------------------------------------------------------------------------

CREATE TABLE messages (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  ticket_id   uuid NOT NULL,
  agency_id   uuid NOT NULL,
  author_id   uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  visibility  text NOT NULL,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (id, created_at),
  CONSTRAINT messages_ticket_same_agency
    FOREIGN KEY (ticket_id, agency_id) REFERENCES tickets (id, agency_id) ON DELETE RESTRICT,
  CONSTRAINT messages_visibility_valid CHECK (visibility IN ('public', 'internal')),
  CONSTRAINT messages_body_length CHECK (char_length(body) BETWEEN 1 AND 10000)
) PARTITION BY RANGE (created_at);

CREATE INDEX messages_by_ticket ON messages (ticket_id, created_at);

-- Monthly partitions: this month and the next three, for both tables.
-- Ranges are half-open: from the 1st (included) to the next 1st (excluded).
-- A daily job will keep creating months ahead (Phase 3). Until then, and as a
-- safety net afterwards, the default partition catches every other date.
DO $$
DECLARE
  month_start date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
  month_end   date;
  suffix      text;
BEGIN
  FOR i IN 0..3 LOOP
    month_end := (month_start + interval '1 month')::date;
    suffix := to_char(month_start, 'YYYY_MM');
    EXECUTE format(
      'CREATE TABLE ticket_events_%s PARTITION OF ticket_events FOR VALUES FROM (%L) TO (%L)',
      suffix, month_start::text || ' 00:00:00+00', month_end::text || ' 00:00:00+00');
    EXECUTE format(
      'CREATE TABLE messages_%s PARTITION OF messages FOR VALUES FROM (%L) TO (%L)',
      suffix, month_start::text || ' 00:00:00+00', month_end::text || ' 00:00:00+00');
    month_start := month_end;
  END LOOP;
END $$;

CREATE TABLE ticket_events_default PARTITION OF ticket_events DEFAULT;
CREATE TABLE messages_default PARTITION OF messages DEFAULT;

-- ---------------------------------------------------------------------------
-- Outbox: events waiting to be published (the relay arrives in Phase 4)
-- ---------------------------------------------------------------------------

CREATE TABLE outbox (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id     uuid NOT NULL REFERENCES tickets (id) ON DELETE RESTRICT,
  event_type    text NOT NULL,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz  -- null = not published yet
);

-- Only unpublished rows are indexed, so the index stays tiny.
CREATE INDEX outbox_unpublished ON outbox (id) WHERE published_at IS NULL;

-- ---------------------------------------------------------------------------
-- Idempotency keys: one row per client retry key
-- ---------------------------------------------------------------------------

CREATE TABLE idempotency_keys (
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  key            text NOT NULL,
  request_hash   text NOT NULL,  -- same key + different body = client bug
  status_code    integer,        -- filled in before the creating transaction commits
  response_body  jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (user_id, key),
  CONSTRAINT idempotency_keys_key_length CHECK (char_length(key) BETWEEN 1 AND 200)
);

-- ---------------------------------------------------------------------------
-- Refresh tokens: login sessions
-- ---------------------------------------------------------------------------

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- CASCADE: a session token has no meaning without its user.
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  family_id   uuid NOT NULL,         -- all tokens that came from one login
  token_hash  text NOT NULL UNIQUE,  -- SHA-256 of the token; the token is never stored
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,           -- set once; makes the token single-use
  revoked_at  timestamptz
);

CREATE INDEX refresh_tokens_family ON refresh_tokens (family_id);
