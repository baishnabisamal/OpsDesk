-- 004: cases (all tickets about one booking) and links between tickets.

-- ---------------------------------------------------------------------------
-- Cases
-- ---------------------------------------------------------------------------

CREATE TABLE cases (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid NOT NULL,
  agency_id   uuid NOT NULL REFERENCES agencies (id) ON DELETE RESTRICT,
  status      text NOT NULL DEFAULT 'open',
  created_at  timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz,

  -- The case's agency must be the booking's agency.
  CONSTRAINT cases_booking_same_agency
    FOREIGN KEY (booking_id, agency_id) REFERENCES bookings (id, agency_id) ON DELETE RESTRICT,
  -- Lets a ticket point at (case_id, booking_id), so a ticket can only be in
  -- a case that is about its own booking.
  CONSTRAINT cases_id_booking_unique UNIQUE (id, booking_id),
  CONSTRAINT cases_status_valid CHECK (status IN ('open', 'closed')),
  CONSTRAINT cases_closed_at_matches_status CHECK ((closed_at IS NOT NULL) = (status = 'closed'))
);

-- At most ONE OPEN case per booking (hazard 6). A plain unique index would
-- also forbid a second case after the first one closed. This index only
-- contains open cases, so only they are forced to be unique.
CREATE UNIQUE INDEX cases_one_open_per_booking ON cases (booking_id) WHERE status = 'open';

CREATE INDEX cases_booking ON cases (booking_id);

-- ---------------------------------------------------------------------------
-- tickets.case_id, added in three safe steps:
--   1. add the column as nullable
--   2. backfill: give every existing ticket a case
--   3. only then make it NOT NULL
-- Adding it as NOT NULL in one go would fail on the rows that already exist.
-- ---------------------------------------------------------------------------

ALTER TABLE tickets ADD COLUMN case_id uuid;

-- One case per booking that has tickets. It is closed only if every one of
-- its tickets is already closed.
INSERT INTO cases (booking_id, agency_id, status, created_at, closed_at)
SELECT booking_id,
       agency_id,
       CASE WHEN bool_and(status = 'closed') THEN 'closed' ELSE 'open' END,
       min(created_at),
       CASE WHEN bool_and(status = 'closed') THEN max(closed_at) END
  FROM tickets
 GROUP BY booking_id, agency_id;

UPDATE tickets t
   SET case_id = c.id
  FROM cases c
 WHERE c.booking_id = t.booking_id;

ALTER TABLE tickets
  ALTER COLUMN case_id SET NOT NULL,
  ADD CONSTRAINT tickets_case_same_booking
    FOREIGN KEY (case_id, booking_id) REFERENCES cases (id, booking_id) ON DELETE RESTRICT;

CREATE INDEX tickets_case ON tickets (case_id, created_at);

-- ---------------------------------------------------------------------------
-- Links: two tickets on DIFFERENT bookings that are about the same problem.
-- (Tickets on the same booking need no link: they share a case.)
-- ---------------------------------------------------------------------------

CREATE TABLE ticket_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- A link has no direction, so the pair is always stored smaller id first.
  -- Then (A, B) and (B, A) are the same row and cannot both exist.
  ticket_a    uuid NOT NULL,
  ticket_b    uuid NOT NULL,
  agency_id   uuid NOT NULL,
  reason      text NOT NULL,
  score       real,           -- text similarity, for automatic links
  created_by  uuid REFERENCES users (id) ON DELETE RESTRICT,  -- null = automatic
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Business data is never deleted: unlinking fills these in instead.
  removed_at  timestamptz,
  removed_by  uuid REFERENCES users (id) ON DELETE RESTRICT,

  CONSTRAINT ticket_links_ordered CHECK (ticket_a < ticket_b),
  -- Both tickets must belong to the link's agency, so a link can never join
  -- two different agencies.
  CONSTRAINT ticket_links_a_same_agency
    FOREIGN KEY (ticket_a, agency_id) REFERENCES tickets (id, agency_id) ON DELETE RESTRICT,
  CONSTRAINT ticket_links_b_same_agency
    FOREIGN KEY (ticket_b, agency_id) REFERENCES tickets (id, agency_id) ON DELETE RESTRICT,
  CONSTRAINT ticket_links_reason_valid CHECK (reason IN ('similar_text', 'manual')),
  CONSTRAINT ticket_links_score_range CHECK (score BETWEEN 0 AND 1),
  CONSTRAINT ticket_links_removed_together
    CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);

-- One ACTIVE link per pair. A removed link stays as history and does not
-- stop the pair being linked again.
CREATE UNIQUE INDEX ticket_links_one_active ON ticket_links (ticket_a, ticket_b)
  WHERE removed_at IS NULL;

CREATE INDEX ticket_links_by_b ON ticket_links (ticket_b) WHERE removed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Privileges and Row-Level Security
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON cases TO opsdesk_app;
GRANT SELECT, INSERT, UPDATE ON ticket_links TO opsdesk_app;

ALTER TABLE cases ENABLE ROW LEVEL SECURITY;
CREATE POLICY cases_all ON cases FOR ALL TO opsdesk_app
  USING (app_sees_all_agencies() OR agency_id = app_agency_id())
  WITH CHECK (app_sees_all_agencies() OR agency_id = app_agency_id());

ALTER TABLE ticket_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY ticket_links_all ON ticket_links FOR ALL TO opsdesk_app
  USING (app_sees_all_agencies() OR agency_id = app_agency_id())
  WITH CHECK (app_sees_all_agencies() OR agency_id = app_agency_id());

-- ---------------------------------------------------------------------------
-- Two more kinds of timeline event
-- ---------------------------------------------------------------------------

ALTER TABLE ticket_events DROP CONSTRAINT ticket_events_type_valid;
ALTER TABLE ticket_events ADD CONSTRAINT ticket_events_type_valid CHECK (type IN
  ('ticket_created', 'ticket_updated', 'status_changed', 'ticket_assigned', 'message_added',
   'intent_overridden', 'ticket_linked', 'ticket_unlinked'));
