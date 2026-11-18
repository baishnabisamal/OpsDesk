-- 007: what the background jobs need.

-- ---------------------------------------------------------------------------
-- Dead letters: a job that failed on every retry is stored here with its
-- error, for a person to look at. Nothing fails silently.
-- ---------------------------------------------------------------------------

CREATE TABLE dead_letter_jobs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue      text NOT NULL,
  job_name   text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}',
  error      text NOT NULL,
  attempts   integer NOT NULL,
  failed_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT dead_letter_jobs_attempts_positive CHECK (attempts > 0)
);

CREATE INDEX dead_letter_jobs_newest ON dead_letter_jobs (failed_at DESC);

GRANT SELECT, INSERT ON dead_letter_jobs TO opsdesk_app;

-- Only background jobs (the system actor) write or read dead letters.
ALTER TABLE dead_letter_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY dead_letter_jobs_all ON dead_letter_jobs FOR ALL TO opsdesk_app
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

-- ---------------------------------------------------------------------------
-- Two maintenance tasks need more power than the app role has: creating
-- tables (partitions) and deleting rows (expired retry keys). Giving the app
-- role CREATE or DELETE would throw away the "owns nothing, deletes nothing"
-- rule for everything else.
--
-- Instead each task is a function marked SECURITY DEFINER: it runs with the
-- privileges of its OWNER (the migration role), not of the caller. The app
-- role may call the function and nothing else, so it can do exactly these
-- two things and no other CREATE or DELETE.
--
-- "SET search_path" pins which schema the function's table names refer to,
-- so a caller cannot trick it into touching a table of their own.
-- ---------------------------------------------------------------------------

-- Creates the monthly partitions of ONE parent table (ticket_events or
-- messages) for this month and the next `months_ahead` months, if they are
-- missing (hazard 15). Returns how many partitions it created.
--
-- Locking, and why this function never waits:
--   Creating a partition locks the parent table, AND the tables its foreign
--   keys point at (tickets, users), because the new partition gets those
--   foreign keys too. Requests take the same locks in their own order: a
--   ticket create writes tickets, then ticket_events. If this function held
--   one of the locks and waited for another, it could wait in a circle with
--   a request (a deadlock), and PostgreSQL would kill one of the two, maybe
--   the user's request.
--
--   So the function takes every lock it needs FIRST, with NOWAIT: if any of
--   them is busy it fails at once (error 55P03) instead of waiting. A
--   transaction that never waits can never be part of a deadlock. The caller
--   simply tries again a moment later. When it does get the locks, it holds
--   them only for the few milliseconds it takes to create the tables.
--
--   The LOCK statements are inside this function because they need more
--   privilege than the app role has; the function runs as its owner.
CREATE FUNCTION create_month_partitions(parent text, months_ahead integer) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  first_month  date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
  month_start  date;
  month_end    date;
  child        text;
  missing      date[] := '{}';
BEGIN
  -- The table name ends up in SQL text, so only these two are accepted.
  IF parent NOT IN ('ticket_events', 'messages') THEN
    RAISE EXCEPTION 'unknown partitioned table: %', parent;
  END IF;
  IF months_ahead < 0 OR months_ahead > 24 THEN
    RAISE EXCEPTION 'months_ahead must be between 0 and 24';
  END IF;

  -- Which months are missing? Most days the answer is "none", and then no
  -- lock is taken at all.
  FOR i IN 0..months_ahead LOOP
    month_start := (first_month + make_interval(months => i))::date;
    IF to_regclass(parent || '_' || to_char(month_start, 'YYYY_MM')) IS NULL THEN
      missing := missing || month_start;
    END IF;
  END LOOP;
  IF cardinality(missing) = 0 THEN
    RETURN 0;
  END IF;

  -- All locks up front, never waiting (see above).
  LOCK TABLE tickets, users IN SHARE ROW EXCLUSIVE MODE NOWAIT;
  EXECUTE format('LOCK TABLE %I IN ACCESS EXCLUSIVE MODE NOWAIT', parent);

  FOREACH month_start IN ARRAY missing LOOP
    month_end := (month_start + interval '1 month')::date;
    child := parent || '_' || to_char(month_start, 'YYYY_MM');
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
      child, parent, month_start::text || ' 00:00:00+00', month_end::text || ' 00:00:00+00');
  END LOOP;

  RETURN cardinality(missing);
END $$;

-- Removes retry keys older than 24 hours. After a day a retry is no longer
-- expected, and the table would otherwise grow by one row per ticket for ever.
-- Returns how many rows it removed.
CREATE FUNCTION purge_idempotency_keys() RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours';
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $$;

-- By default anyone may run a new function. Take that away, then allow only
-- the app role.
REVOKE ALL ON FUNCTION create_month_partitions(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION purge_idempotency_keys() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_month_partitions(text, integer) TO opsdesk_app;
GRANT EXECUTE ON FUNCTION purge_idempotency_keys() TO opsdesk_app;
