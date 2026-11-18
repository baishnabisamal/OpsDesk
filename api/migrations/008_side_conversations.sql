-- 008: side conversations: email threads between staff and outside parties
-- (usually the hotel or supplier) attached to a ticket.
--
-- The key design point: the RECIPIENTS belong to the conversation, stored in
-- side_participants. They are not worked out from whoever owns the ticket.
-- So when the ticket moves to another agent or team, the supplier thread
-- keeps going to the same people, and replies still find their way back.

CREATE TABLE side_conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   uuid NOT NULL,
  agency_id   uuid NOT NULL,
  subject     text NOT NULL,
  status      text NOT NULL DEFAULT 'open',
  created_by  uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT side_conversations_ticket_same_agency
    FOREIGN KEY (ticket_id, agency_id) REFERENCES tickets (id, agency_id) ON DELETE RESTRICT,
  -- Lets messages point at (side_conversation_id, ticket_id).
  CONSTRAINT side_conversations_id_ticket_unique UNIQUE (id, ticket_id),
  CONSTRAINT side_conversations_subject_length CHECK (char_length(subject) BETWEEN 1 AND 200),
  CONSTRAINT side_conversations_status_valid CHECK (status IN ('open', 'closed'))
);

CREATE INDEX side_conversations_by_ticket ON side_conversations (ticket_id, created_at);

-- The people outside OpsDesk on the thread. One row per address per
-- conversation; the address is stored lower-cased so "Res@Hotel.com" and
-- "res@hotel.com" are the same participant.
CREATE TABLE side_participants (
  side_conversation_id  uuid NOT NULL REFERENCES side_conversations (id) ON DELETE RESTRICT,
  email                 text NOT NULL,
  name                  text,  -- optional display name
  added_at              timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (side_conversation_id, email),
  CONSTRAINT side_participants_email_lower CHECK (email = lower(email)),
  CONSTRAINT side_participants_email_shape CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

-- What was written in the thread, in both directions. Append-only.
CREATE TABLE side_messages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  side_conversation_id  uuid NOT NULL,
  ticket_id             uuid NOT NULL,
  direction             text NOT NULL,
  author_id             uuid REFERENCES users (id) ON DELETE RESTRICT,  -- staff, outbound only
  from_email            text,                                            -- inbound only
  body                  text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT side_messages_conversation_same_ticket
    FOREIGN KEY (side_conversation_id, ticket_id)
    REFERENCES side_conversations (id, ticket_id) ON DELETE RESTRICT,
  CONSTRAINT side_messages_direction_valid CHECK (direction IN ('outbound', 'inbound')),
  -- Outbound messages have a staff author; inbound ones have a sender address.
  CONSTRAINT side_messages_author_matches_direction CHECK (
    (direction = 'outbound' AND author_id IS NOT NULL AND from_email IS NULL) OR
    (direction = 'inbound' AND author_id IS NULL AND from_email IS NOT NULL)),
  CONSTRAINT side_messages_body_length CHECK (char_length(body) BETWEEN 1 AND 20000)
);

CREATE INDEX side_messages_by_conversation ON side_messages (side_conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- Privileges and Row-Level Security. Supplier threads are internal: agencies
-- never see them, so every policy is staff (and system) only.
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON side_conversations TO opsdesk_app;
GRANT SELECT, INSERT ON side_participants TO opsdesk_app;
GRANT SELECT, INSERT ON side_messages TO opsdesk_app;  -- no UPDATE: append-only

ALTER TABLE side_conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY side_conversations_all ON side_conversations FOR ALL TO opsdesk_app
  USING (app_sees_all_agencies()) WITH CHECK (app_sees_all_agencies());

ALTER TABLE side_participants ENABLE ROW LEVEL SECURITY;
CREATE POLICY side_participants_all ON side_participants FOR ALL TO opsdesk_app
  USING (app_sees_all_agencies()) WITH CHECK (app_sees_all_agencies());

ALTER TABLE side_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY side_messages_all ON side_messages FOR ALL TO opsdesk_app
  USING (app_sees_all_agencies()) WITH CHECK (app_sees_all_agencies());

-- ---------------------------------------------------------------------------
-- New timeline events. They are internal: an agency's timeline does not show
-- that staff are talking to the hotel.
-- ---------------------------------------------------------------------------

ALTER TABLE ticket_events DROP CONSTRAINT ticket_events_type_valid;
ALTER TABLE ticket_events ADD CONSTRAINT ticket_events_type_valid CHECK (type IN
  ('ticket_created', 'ticket_updated', 'status_changed', 'ticket_assigned', 'message_added',
   'intent_overridden', 'ticket_linked', 'ticket_unlinked', 'sla_state_changed',
   'side_conversation_started', 'side_message_added'));
