-- Helpers the app needs regardless of the caller's branch scope.

-- Reveal rate limit: counts one user's reveals across ALL branches (RLS would hide
-- rows outside the current scope). Returns counts only, never rows.
CREATE FUNCTION reveal_counts(p_user_sid text)
RETURNS TABLE (last_hour int, last_day int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*) FILTER (WHERE at > now() - interval '1 hour')::int,
         count(*)::int
    FROM access_log
   WHERE user_sid = p_user_sid AND action = 'reveal' AND at > now() - interval '1 day'
$$;
REVOKE ALL ON FUNCTION reveal_counts(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reveal_counts(text) TO app_node;

-- Speeds up the count above and the "views per user" report.
CREATE INDEX ix_log_action_user_at ON access_log (action, user_sid, at);

-- A manual sync request from Admin HQ, picked up by the worker on its next heartbeat.
INSERT INTO app_setting (key, value) VALUES ('sync.requested', 'null') ON CONFLICT DO NOTHING;

-- A quarantined run keeps what it would have applied (deletions, USN) until Admin HQ decides.
ALTER TABLE sync_run ADD COLUMN pending jsonb NULL;
ALTER TABLE sync_run ADD COLUMN keys_seen int NULL;
ALTER TABLE sync_run ADD COLUMN anomalies jsonb NULL;
ALTER TABLE sync_run ADD COLUMN keys_empty_pwd int NOT NULL DEFAULT 0;
-- Computers not seen by a full run (last_seen_run < run id) are marked deleted in AD.
CREATE INDEX ix_computer_last_seen ON computer (last_seen_run) WHERE deleted_in_ad_at IS NULL;
