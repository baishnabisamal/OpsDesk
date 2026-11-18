-- 013: weekly themes, precomputed.
--
-- The insights page asks "what were tickets about this week?". Working that
-- out on every page view would mean counting and clustering thousands of
-- tickets each time. Instead a nightly job computes it once and stores the
-- answer here: a precomputed aggregate.
--
-- One row per week. The job REPLACES the row (upsert), so running it twice
-- gives the same result, and it never needs to delete anything.

CREATE TABLE theme_weekly (
  week_start     date PRIMARY KEY,  -- the Monday (UTC) the week starts on
  ticket_count   integer NOT NULL,
  -- [{ intent, count, sample_ticket_ids }], biggest first
  intents        jsonb NOT NULL,
  -- [{ label, terms, size, sample_ticket_ids }] from the ML service, or null
  -- when it could not be reached (the intent counts are still useful)
  clusters       jsonb,
  computed_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT theme_weekly_is_monday CHECK (extract(isodow FROM week_start) = 1),
  CONSTRAINT theme_weekly_count_not_negative CHECK (ticket_count >= 0)
);

GRANT SELECT, INSERT, UPDATE ON theme_weekly TO opsdesk_app;

-- Insights are for staff (the API further limits them to leads). Sample
-- ticket ids from every agency are in here, so agencies must not read it.
ALTER TABLE theme_weekly ENABLE ROW LEVEL SECURITY;
CREATE POLICY theme_weekly_all ON theme_weekly FOR ALL TO opsdesk_app
  USING (app_sees_all_agencies()) WITH CHECK (app_sees_all_agencies());
