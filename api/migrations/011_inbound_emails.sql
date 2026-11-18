-- 011: emails that arrive through the inbound webhook (supplier replies).

CREATE TABLE inbound_emails (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The mail provider's own id for the email. Hazard 12: providers retry
  -- webhooks, so the same email can be posted twice. This UNIQUE makes the
  -- second post a no-op instead of a second reply in the thread.
  provider_message_id   text NOT NULL UNIQUE,
  from_email            text NOT NULL,
  to_email              text NOT NULL,
  subject               text NOT NULL DEFAULT '',
  body                  text NOT NULL,
  status                text NOT NULL,
  -- Why it could not be placed in a thread. Kept, never thrown away, so a
  -- person can look at it.
  quarantine_reason     text,
  side_conversation_id  uuid REFERENCES side_conversations (id) ON DELETE RESTRICT,
  side_message_id       uuid UNIQUE REFERENCES side_messages (id) ON DELETE RESTRICT,
  received_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT inbound_emails_status_valid CHECK (status IN ('accepted', 'quarantined')),
  CONSTRAINT inbound_emails_accepted_has_thread
    CHECK (status <> 'accepted' OR side_conversation_id IS NOT NULL),
  CONSTRAINT inbound_emails_quarantine_has_reason
    CHECK ((status = 'quarantined') = (quarantine_reason IS NOT NULL)),
  CONSTRAINT inbound_emails_provider_id_length CHECK (char_length(provider_message_id) BETWEEN 1 AND 300)
);

CREATE INDEX inbound_emails_quarantined ON inbound_emails (received_at DESC)
  WHERE status = 'quarantined';

-- side_message_id is filled in right after the message is written, in the
-- same transaction, so the app needs UPDATE as well.
GRANT SELECT, INSERT, UPDATE ON inbound_emails TO opsdesk_app;

-- The webhook runs as the system actor; nobody else reads raw inbound mail.
ALTER TABLE inbound_emails ENABLE ROW LEVEL SECURITY;
CREATE POLICY inbound_emails_all ON inbound_emails FOR ALL TO opsdesk_app
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
