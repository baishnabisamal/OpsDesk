-- 003: where a ticket's intent came from, and a log of human corrections.

-- ---------------------------------------------------------------------------
-- New ticket columns
-- ---------------------------------------------------------------------------

-- Tickets that already exist were labelled by the person who created them,
-- so they are backfilled as 'manual'. The default exists only for that
-- backfill and is dropped straight after: from now on the application must
-- always say where an intent came from.
ALTER TABLE tickets
  ADD COLUMN intent_source      text NOT NULL DEFAULT 'manual',
  ADD COLUMN intent_confidence  real,     -- the model's probability, 0 to 1
  ADD COLUMN model_version      text,     -- which model made the prediction
  ADD COLUMN needs_review       boolean NOT NULL DEFAULT false;

ALTER TABLE tickets ALTER COLUMN intent_source DROP DEFAULT;

ALTER TABLE tickets
  -- rule: a keyword rule fired.  model: the ML service answered.
  -- manual: a person chose it.   fallback: neither rule nor model, so 'other'.
  ADD CONSTRAINT tickets_intent_source_valid
    CHECK (intent_source IN ('rule', 'model', 'manual', 'fallback')),
  ADD CONSTRAINT tickets_intent_confidence_range
    CHECK (intent_confidence BETWEEN 0 AND 1),
  -- Confidence and model version exist exactly when the model chose the intent.
  ADD CONSTRAINT tickets_model_fields_match_source
    CHECK ((intent_source = 'model') = (model_version IS NOT NULL)
       AND (intent_source = 'model') = (intent_confidence IS NOT NULL)),
  ADD CONSTRAINT tickets_fallback_is_other
    CHECK (intent_source <> 'fallback' OR intent = 'other');

-- The review queue: tickets whose intent a person should check. Few tickets
-- are flagged, so a partial index keeps this tiny.
CREATE INDEX tickets_needs_review ON tickets (created_at DESC, id DESC) WHERE needs_review;

-- ---------------------------------------------------------------------------
-- Overrides: every time a person corrects (or confirms) an intent.
-- This is the future training data: the text plus the label a human chose.
-- ---------------------------------------------------------------------------

CREATE TABLE intent_overrides (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id      uuid NOT NULL,
  agency_id      uuid NOT NULL,
  from_intent    text NOT NULL,
  to_intent      text NOT NULL,
  from_source    text NOT NULL,  -- what the person was correcting: rule, model...
  model_version  text,           -- set when they corrected a model prediction
  overridden_by  uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT intent_overrides_ticket_same_agency
    FOREIGN KEY (ticket_id, agency_id) REFERENCES tickets (id, agency_id) ON DELETE RESTRICT,
  CONSTRAINT intent_overrides_from_intent_valid CHECK (from_intent IN
    ('booking_not_found', 'cancellation', 'amendment', 'refund', 'voucher', 'payment', 'other')),
  CONSTRAINT intent_overrides_to_intent_valid CHECK (to_intent IN
    ('booking_not_found', 'cancellation', 'amendment', 'refund', 'voucher', 'payment', 'other')),
  CONSTRAINT intent_overrides_from_source_valid
    CHECK (from_source IN ('rule', 'model', 'manual', 'fallback'))
);

CREATE INDEX intent_overrides_by_ticket ON intent_overrides (ticket_id, created_at);

-- Append-only, and for staff only: requesters never see how a ticket was
-- classified internally.
GRANT SELECT, INSERT ON intent_overrides TO opsdesk_app;

ALTER TABLE intent_overrides ENABLE ROW LEVEL SECURITY;
CREATE POLICY intent_overrides_all ON intent_overrides FOR ALL TO opsdesk_app
  USING (app_sees_all_agencies())
  WITH CHECK (app_sees_all_agencies());

-- ---------------------------------------------------------------------------
-- A new kind of timeline event. A CHECK cannot be edited, so the old one is
-- dropped and a new one added, in this same transaction.
-- ---------------------------------------------------------------------------

ALTER TABLE ticket_events DROP CONSTRAINT ticket_events_type_valid;
ALTER TABLE ticket_events ADD CONSTRAINT ticket_events_type_valid CHECK (type IN
  ('ticket_created', 'ticket_updated', 'status_changed', 'ticket_assigned', 'message_added',
   'intent_overridden'));
