-- 005: SLA policies, regional holidays, and the SLA columns on tickets.

-- ---------------------------------------------------------------------------
-- How much time each priority gets
-- ---------------------------------------------------------------------------

CREATE TABLE sla_policies (
  priority             text PRIMARY KEY,
  target_minutes       integer NOT NULL,
  -- false = the clock also runs at night and on weekends
  business_hours_only  boolean NOT NULL,

  CONSTRAINT sla_policies_priority_valid CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  CONSTRAINT sla_policies_target_positive CHECK (target_minutes > 0)
);

INSERT INTO sla_policies (priority, target_minutes, business_hours_only) VALUES
  ('urgent', 120,  false),  -- 2 hours, day or night
  ('high',   240,  true),   -- 4 business hours
  ('normal', 480,  true),   -- 8 business hours
  ('low',    1440, true);   -- 24 business hours, almost 3 working days

-- ---------------------------------------------------------------------------
-- Days a region does not work. A holiday is a calendar date, not an instant.
-- ---------------------------------------------------------------------------

CREATE TABLE region_holidays (
  region_code  text NOT NULL REFERENCES regions (code) ON DELETE RESTRICT,
  holiday      date NOT NULL,
  name         text NOT NULL,
  PRIMARY KEY (region_code, holiday)
);

GRANT SELECT ON sla_policies, region_holidays TO opsdesk_app;

-- ---------------------------------------------------------------------------
-- SLA columns on tickets: nullable first, backfill, then NOT NULL.
-- ---------------------------------------------------------------------------

ALTER TABLE tickets
  ADD COLUMN sla_due_at        timestamptz,  -- the deadline
  ADD COLUMN sla_at_risk_at    timestamptz,  -- from here the ticket is "at risk"
  ADD COLUMN sla_state         text NOT NULL DEFAULT 'on_track',
  ADD COLUMN sla_paused_at     timestamptz,  -- set only while status is pending
  ADD COLUMN sla_paused_total  integer NOT NULL DEFAULT 0;  -- seconds, never a float

-- Backfill for tickets that already exist. The real rule (business hours,
-- holidays, travel deadline) lives in the application and cannot run here,
-- so old tickets get the simple version: created_at plus the policy's
-- minutes of plain clock time. New tickets get the real rule.
UPDATE tickets t
   SET sla_due_at     = t.created_at + make_interval(mins => p.target_minutes),
       sla_at_risk_at = t.created_at + make_interval(mins => p.target_minutes) * 0.8,
       sla_paused_at  = CASE WHEN t.status = 'pending' THEN t.updated_at END
  FROM sla_policies p
 WHERE p.priority = t.priority;

ALTER TABLE tickets
  ALTER COLUMN sla_due_at SET NOT NULL,
  ALTER COLUMN sla_at_risk_at SET NOT NULL,
  ADD CONSTRAINT tickets_sla_state_valid CHECK (sla_state IN ('on_track', 'at_risk', 'breached')),
  ADD CONSTRAINT tickets_sla_at_risk_before_due CHECK (sla_at_risk_at <= sla_due_at),
  -- The clock is paused exactly while the ticket waits on the requester.
  ADD CONSTRAINT tickets_sla_paused_only_when_pending
    CHECK ((sla_paused_at IS NOT NULL) = (status = 'pending')),
  ADD CONSTRAINT tickets_sla_paused_total_not_negative CHECK (sla_paused_total >= 0);

-- What the SLA scanner asks every minute: "which running tickets are due?"
-- Only tickets whose clock is running are in the index.
CREATE INDEX tickets_sla_due ON tickets (sla_due_at)
  WHERE status IN ('new', 'open') AND sla_state <> 'breached';

-- ---------------------------------------------------------------------------
-- A new kind of timeline event
-- ---------------------------------------------------------------------------

ALTER TABLE ticket_events DROP CONSTRAINT ticket_events_type_valid;
ALTER TABLE ticket_events ADD CONSTRAINT ticket_events_type_valid CHECK (type IN
  ('ticket_created', 'ticket_updated', 'status_changed', 'ticket_assigned', 'message_added',
   'intent_overridden', 'ticket_linked', 'ticket_unlinked', 'sla_state_changed'));
