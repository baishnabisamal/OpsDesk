-- 014: archival of old monthly partitions.
--
-- ticket_events and messages grow by millions of rows a year. Old months are
-- moved out of PostgreSQL into compressed files, one file per partition.
-- A partition is only dropped after its file has been written AND read back
-- and checked. Data is never removed before its copy is verified.

CREATE TABLE archive_manifests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name      text NOT NULL,
  partition_name  text NOT NULL UNIQUE,
  range_start     timestamptz NOT NULL,  -- included
  range_end       timestamptz NOT NULL,  -- excluded (half-open, like the partition)
  row_count       integer NOT NULL,
  sha256          text NOT NULL,         -- of the uncompressed content
  object_key      text NOT NULL,         -- where the file is in object storage
  status          text NOT NULL DEFAULT 'verified',
  created_at      timestamptz NOT NULL DEFAULT now(),
  dropped_at      timestamptz,

  CONSTRAINT archive_manifests_table_valid CHECK (table_name IN ('ticket_events', 'messages')),
  CONSTRAINT archive_manifests_range_valid CHECK (range_start < range_end),
  CONSTRAINT archive_manifests_rows_not_negative CHECK (row_count >= 0),
  CONSTRAINT archive_manifests_sha256_shape CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- verified = the file is checked, the partition still exists
  -- dropped  = the partition is gone; the file is now the only copy
  CONSTRAINT archive_manifests_status_valid CHECK (status IN ('verified', 'dropped')),
  CONSTRAINT archive_manifests_dropped_at_matches CHECK ((dropped_at IS NOT NULL) = (status = 'dropped'))
);

GRANT SELECT, INSERT, UPDATE ON archive_manifests TO opsdesk_app;

-- Staff can see which months are archived (the lookup endpoint needs it);
-- only the archive job (system) writes.
ALTER TABLE archive_manifests ENABLE ROW LEVEL SECURITY;
CREATE POLICY archive_manifests_select ON archive_manifests FOR SELECT TO opsdesk_app
  USING (app_sees_all_agencies() OR app_agency_id() IS NOT NULL);
CREATE POLICY archive_manifests_write ON archive_manifests FOR INSERT TO opsdesk_app
  WITH CHECK (app_role() = 'system');
CREATE POLICY archive_manifests_update ON archive_manifests FOR UPDATE TO opsdesk_app
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

-- ---------------------------------------------------------------------------
-- The last step: detach and drop one partition. SECURITY DEFINER, like the
-- other maintenance functions (migration 007), because the app role may not
-- drop tables. It refuses unless every safety condition holds.
-- ---------------------------------------------------------------------------

CREATE FUNCTION drop_archived_partition(p_name text, expected_rows bigint) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  parent_name  text;
  actual_rows  bigint;
BEGIN
  -- 1. It must really be a monthly partition of one of the two tables, and
  --    not the default partition (which catches everything else).
  SELECT p.relname INTO parent_name
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
   WHERE c.relname = p_name
     AND p.relname IN ('ticket_events', 'messages')
     AND p_name ~ '_\d{4}_\d{2}$';
  IF parent_name IS NULL THEN
    RAISE EXCEPTION 'not an archivable partition: %', p_name;
  END IF;

  -- 2. Its archive must be recorded and verified, for this number of rows.
  IF NOT EXISTS (SELECT 1 FROM archive_manifests
                  WHERE partition_name = p_name AND status = 'verified'
                    AND row_count = expected_rows) THEN
    RAISE EXCEPTION 'no verified archive of % with % rows', p_name, expected_rows;
  END IF;

  -- 3. Take every lock this function will need, at full strength, before
  --    doing anything, each waiting at most 200 ms (the reasoning is in
  --    migration 012).
  --
  --    Full strength matters. DROP TABLE removes the partition's foreign-key
  --    triggers from tickets and users, which needs ACCESS EXCLUSIVE on them.
  --    A first version locked them in a weaker mode and let DROP upgrade the
  --    lock later. Upgrading a lock you already hold, while other sessions
  --    hold weaker ones and wait on you, is a classic deadlock; under load the
  --    job lost every time. Taking the strongest lock first means nothing is
  --    ever upgraded.
  --
  --    The cost: reads of tickets wait for the few milliseconds the drop
  --    takes, once per archived month.
  PERFORM set_config('lock_timeout', '200ms', true);
  LOCK TABLE tickets, users IN ACCESS EXCLUSIVE MODE;
  EXECUTE format('LOCK TABLE %I IN ACCESS EXCLUSIVE MODE', parent_name);

  -- 4. Count again, under the lock. If a row arrived after the file was
  --    written, the file is incomplete: refuse, and the next run starts over.
  EXECUTE format('SELECT count(*) FROM %I', p_name) INTO actual_rows;
  IF actual_rows <> expected_rows THEN
    RAISE EXCEPTION 'partition % has % rows, the archive has %', p_name, actual_rows, expected_rows;
  END IF;

  -- 5. Only now remove it.
  EXECUTE format('ALTER TABLE %I DETACH PARTITION %I', parent_name, p_name);
  EXECUTE format('DROP TABLE %I', p_name);
  UPDATE archive_manifests SET status = 'dropped', dropped_at = now() WHERE partition_name = p_name;
END $$;

REVOKE ALL ON FUNCTION drop_archived_partition(text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION drop_archived_partition(text, bigint) TO opsdesk_app;
