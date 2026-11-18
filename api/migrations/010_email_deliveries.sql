-- 010: one row per email sent (or being sent): a side message to one recipient.

CREATE TABLE email_deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  side_message_id  uuid NOT NULL REFERENCES side_messages (id) ON DELETE RESTRICT,
  recipient        text NOT NULL,
  -- The SMTP Message-ID header, fixed before the first try. A retry sends
  -- the very same id, so a mail client can recognise a repeat.
  message_id       text NOT NULL UNIQUE,
  status           text NOT NULL DEFAULT 'sending',
  attempts         integer NOT NULL DEFAULT 1,
  claimed_at       timestamptz,  -- when a worker last took it; a lease
  sent_at          timestamptz,
  last_error       text,

  -- Hazard 11: the same message can never be delivered twice to one person,
  -- because only one row can exist for the pair. A worker must claim this
  -- row before it sends.
  CONSTRAINT email_deliveries_once_per_recipient UNIQUE (side_message_id, recipient),
  CONSTRAINT email_deliveries_status_valid CHECK (status IN ('sending', 'sent')),
  CONSTRAINT email_deliveries_sent_at_matches_status CHECK ((sent_at IS NOT NULL) = (status = 'sent')),
  CONSTRAINT email_deliveries_attempts_positive CHECK (attempts > 0),
  CONSTRAINT email_deliveries_recipient_lower CHECK (recipient = lower(recipient))
);

GRANT SELECT, INSERT, UPDATE ON email_deliveries TO opsdesk_app;

-- Only the email worker (system actor) touches deliveries.
ALTER TABLE email_deliveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY email_deliveries_all ON email_deliveries FOR ALL TO opsdesk_app
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
