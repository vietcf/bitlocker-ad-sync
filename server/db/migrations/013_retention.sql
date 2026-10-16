-- Data retention (Quan tri > Luu tru): how long the access log, sync history and mail are kept.
--
-- access_log stays append-only for the app: app_node still has no DELETE on it, and the trigger
-- still refuses UPDATE/TRUNCATE. Old rows can only go through purge_access_log(), which deletes
-- the OLDEST rows (a prefix of the hash chain, never a gap) and records a checkpoint with the hash
-- of the last deleted row, so the rest of the chain can still be verified from that point.

CREATE TABLE access_log_purge (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  purged_at   timestamptz  NOT NULL DEFAULT now(),
  purged_by   varchar(256) NOT NULL,
  before_at   timestamptz  NOT NULL,             -- rows older than this were deleted
  up_to_id    bigint       NOT NULL,             -- last deleted id
  rows        bigint       NOT NULL,
  last_hash   bytea        NOT NULL CHECK (octet_length(last_hash) = 32)
);
GRANT SELECT ON access_log_purge TO app_node;

CREATE OR REPLACE FUNCTION access_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Only purge_access_log() sets this, and only it (as the table owner) can DELETE.
  IF TG_OP = 'DELETE' AND current_setting('blk.access_log_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'access_log is append-only';
END $$;

CREATE FUNCTION purge_access_log(p_days int, p_by varchar) RETURNS TABLE (deleted bigint, up_to_id bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cutoff timestamptz := now() - make_interval(days => p_days);
  v_upto   bigint;
  v_hash   bytea;
  v_rows   bigint;
BEGIN
  IF p_days IS NULL OR p_days < 365 THEN
    RAISE EXCEPTION 'access_log retention must be at least 365 days';
  END IF;
  -- Same lock as the writers: nobody chains onto the tail while the head is cut.
  PERFORM pg_advisory_xact_lock(hashtext('access_log_chain'));
  -- Never delete the newest row: the chain needs a tail to continue from.
  SELECT max(l.id) INTO v_upto FROM access_log l
   WHERE l.at < v_cutoff AND l.id < (SELECT max(id) FROM access_log);
  IF v_upto IS NULL THEN
    RETURN QUERY SELECT 0::bigint, NULL::bigint;
    RETURN;
  END IF;
  SELECT l.hash INTO v_hash FROM access_log l WHERE l.id = v_upto;
  PERFORM set_config('blk.access_log_purge', 'on', true);
  DELETE FROM access_log WHERE id <= v_upto;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM set_config('blk.access_log_purge', 'off', true);
  INSERT INTO access_log_purge (purged_by, before_at, up_to_id, rows, last_hash)
  VALUES (p_by, v_cutoff, v_upto, v_rows, v_hash);
  RETURN QUERY SELECT v_rows, v_upto;
END $$;
REVOKE ALL ON FUNCTION purge_access_log(int, varchar) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_access_log(int, varchar) TO app_node;

-- Sync history: old runs, their metrics and resolved alerts may be deleted by the retention job.
GRANT DELETE ON sync_run, sync_metric, sync_alert TO app_node;

INSERT INTO app_setting (key, value) VALUES
  ('retention.access_log_days', 'null'),   -- null = keep forever (default); otherwise >= 365
  ('retention.sync_days', '180')            -- sync runs, metrics, resolved alerts; >= 30
ON CONFLICT (key) DO NOTHING;
