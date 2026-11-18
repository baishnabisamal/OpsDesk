-- 012: the partition function waits a little for its locks instead of not at all.
--
-- Migration 007 made create_month_partitions take its locks with NOWAIT, so
-- it could never be part of a deadlock. Under steady write traffic that was
-- too strict: there is almost never a moment when no transaction is writing
-- to tickets, so the job gave up every time.
--
-- Now each lock waits at most 200 ms (lock_timeout), then the attempt fails
-- with error 55P03 and the caller tries again a moment later, as before.
--
-- Why this is still safe from deadlocks: PostgreSQL only checks for a
-- deadlock after a transaction has waited deadlock_timeout (1 second by
-- default). The job takes its first lock and asks for the second straight
-- away, so any request caught in a cycle with it started waiting AFTER the
-- job did. The job gives up after 200 ms, long before that request reaches
-- its 1-second check. So the job is always the one that backs off, and a
-- user's request is never picked as the deadlock victim.
--
-- 007 is not edited: it is already applied in existing databases, and
-- migrations only ever move forward.

CREATE OR REPLACE FUNCTION create_month_partitions(parent text, months_ahead integer) RETURNS integer
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

  -- All locks up front, each waiting at most 200 ms (see the top of this file).
  -- The `true` makes the setting last only until this transaction ends.
  PERFORM set_config('lock_timeout', '200ms', true);
  LOCK TABLE tickets, users IN SHARE ROW EXCLUSIVE MODE;
  EXECUTE format('LOCK TABLE %I IN ACCESS EXCLUSIVE MODE', parent);

  FOREACH month_start IN ARRAY missing LOOP
    month_end := (month_start + interval '1 month')::date;
    child := parent || '_' || to_char(month_start, 'YYYY_MM');
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
      child, parent, month_start::text || ' 00:00:00+00', month_end::text || ' 00:00:00+00');
  END LOOP;

  RETURN cardinality(missing);
END $$;
