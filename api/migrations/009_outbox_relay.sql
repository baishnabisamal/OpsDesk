-- 009: what the outbox relay needs.

-- A short lease. The relay claims a batch of rows (sets claimed_until), then
-- publishes them to Redis with NO transaction open, then marks them
-- published. If it dies in between, the lease runs out and another run picks
-- the rows up again. So no row is ever lost; at worst it is published twice,
-- which consumers handle by ignoring event ids they have already seen.
ALTER TABLE outbox ADD COLUMN claimed_until timestamptz;

-- Until now the app could only add outbox rows. The relay (system actor)
-- also reads them and marks them published.
GRANT SELECT, UPDATE ON outbox TO opsdesk_app;

-- Row-Level Security: anyone may ADD an event (every state change does), but
-- only the system actor may read or update the queue. Event payloads hold ids
-- from every agency, so a request must never be able to read them.
ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;

CREATE POLICY outbox_insert ON outbox FOR INSERT TO opsdesk_app
  WITH CHECK (true);
CREATE POLICY outbox_select ON outbox FOR SELECT TO opsdesk_app
  USING (app_role() = 'system');
CREATE POLICY outbox_update ON outbox FOR UPDATE TO opsdesk_app
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
