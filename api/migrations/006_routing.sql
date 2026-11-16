-- 006: what routing needs to know about agents, and a record of each decision.

-- ---------------------------------------------------------------------------
-- Presence: is the agent online, and how many tickets do they hold?
-- One row per agent. Only agents get a row; managers and leads are not capped.
-- ---------------------------------------------------------------------------

CREATE TABLE agent_presence (
  user_id     uuid PRIMARY KEY REFERENCES users (id) ON DELETE RESTRICT,
  is_online   boolean NOT NULL DEFAULT false,
  -- How many live tickets (open, pending, escalated) are assigned to them.
  -- It changes only in the same transaction as the assignment it counts.
  open_count  integer NOT NULL DEFAULT 0,
  max_open    integer NOT NULL DEFAULT 5,
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT agent_presence_max_positive CHECK (max_open > 0),
  -- The backstop for hazard 4: even if the application had a bug, the
  -- database refuses to put an agent above their limit or below zero.
  CONSTRAINT agent_presence_count_in_range CHECK (open_count BETWEEN 0 AND max_open)
);

-- ---------------------------------------------------------------------------
-- Shifts: when an agent works, in their region's LOCAL time.
-- ---------------------------------------------------------------------------

CREATE TABLE agent_shifts (
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  weekday       smallint NOT NULL,  -- 1 = Monday ... 7 = Sunday
  start_minute  smallint NOT NULL,  -- minutes after midnight, 540 = 09:00
  end_minute    smallint NOT NULL,  -- not included, 1080 = 18:00

  PRIMARY KEY (user_id, weekday, start_minute),
  CONSTRAINT agent_shifts_weekday_valid CHECK (weekday BETWEEN 1 AND 7),
  -- A shift stays inside one day. A night shift is stored as two rows.
  CONSTRAINT agent_shifts_minutes_valid
    CHECK (start_minute >= 0 AND end_minute <= 1440 AND start_minute < end_minute)
);

-- ---------------------------------------------------------------------------
-- Skills: which intents an agent is good at.
-- ---------------------------------------------------------------------------

CREATE TABLE agent_skills (
  user_id  uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  intent   text NOT NULL,

  PRIMARY KEY (user_id, intent),
  CONSTRAINT agent_skills_intent_valid CHECK (intent IN
    ('booking_not_found', 'cancellation', 'amendment', 'refund', 'voucher', 'payment', 'other'))
);

-- ---------------------------------------------------------------------------
-- Routing decisions: who got the ticket, and why. Append-only.
-- ---------------------------------------------------------------------------

CREATE TABLE routing_decisions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   uuid NOT NULL,
  agency_id   uuid NOT NULL,
  outcome     text NOT NULL,
  chosen_id   uuid REFERENCES users (id) ON DELETE RESTRICT,
  -- The ranked candidates with their scores and reasons, and the agents that
  -- were filtered out with the reason for each.
  details     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT routing_decisions_ticket_same_agency
    FOREIGN KEY (ticket_id, agency_id) REFERENCES tickets (id, agency_id) ON DELETE RESTRICT,
  CONSTRAINT routing_decisions_outcome_valid CHECK (outcome IN ('assigned', 'no_candidate')),
  CONSTRAINT routing_decisions_chosen_matches_outcome
    CHECK ((chosen_id IS NOT NULL) = (outcome = 'assigned'))
);

CREATE INDEX routing_decisions_by_ticket ON routing_decisions (ticket_id, created_at);

-- ---------------------------------------------------------------------------
-- Privileges and Row-Level Security. All of this is staff-only: an agency
-- never sees who is online or why a ticket went to a particular agent.
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON agent_presence TO opsdesk_app;
GRANT SELECT ON agent_shifts, agent_skills TO opsdesk_app;
GRANT SELECT, INSERT ON routing_decisions TO opsdesk_app;

ALTER TABLE agent_presence ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_presence_all ON agent_presence FOR ALL TO opsdesk_app
  USING (app_sees_all_agencies()) WITH CHECK (app_sees_all_agencies());

ALTER TABLE agent_shifts ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_shifts_select ON agent_shifts FOR SELECT TO opsdesk_app
  USING (app_sees_all_agencies());

ALTER TABLE agent_skills ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_skills_select ON agent_skills FOR SELECT TO opsdesk_app
  USING (app_sees_all_agencies());

ALTER TABLE routing_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY routing_decisions_all ON routing_decisions FOR ALL TO opsdesk_app
  USING (app_sees_all_agencies()) WITH CHECK (app_sees_all_agencies());

-- ---------------------------------------------------------------------------
-- Indexes for the queue views (README section 7). Each is partial: closed
-- and resolved tickets are most of the table but are never in a queue.
-- ---------------------------------------------------------------------------

-- Triage: live tickets nobody owns, most urgent deadline first.
CREATE INDEX tickets_triage ON tickets (sla_due_at, id)
  WHERE assignee_id IS NULL AND status IN ('new', 'open');

-- My queue.
CREATE INDEX tickets_assignee_queue ON tickets (assignee_id, sla_due_at, id)
  WHERE status IN ('open', 'pending', 'escalated');

-- A region's queue, and a team's queue.
CREATE INDEX tickets_region_queue ON tickets (region_code, sla_due_at, id)
  WHERE status IN ('new', 'open', 'pending', 'escalated');
CREATE INDEX tickets_team_queue ON tickets (team_id, sla_due_at, id)
  WHERE status IN ('new', 'open', 'pending', 'escalated');

-- One intent's queue.
CREATE INDEX tickets_intent_queue ON tickets (intent, sla_due_at, id)
  WHERE status IN ('new', 'open', 'pending', 'escalated');

-- Escalations.
CREATE INDEX tickets_escalated_queue ON tickets (sla_due_at, id) WHERE status = 'escalated';

-- The "my tickets" index from migration 001 is replaced by tickets_assignee_queue.
DROP INDEX tickets_assignee_live;
