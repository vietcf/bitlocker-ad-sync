-- Second layer of branch isolation (the first is the app's scoped queries).
-- Node.js sets these per transaction with set_config(..., true):
--   app.all_branches = '1'        Admin HQ, auditor reports, ingest
--   app.branch_ids   = '{3,7}'    the user's branches
-- Neither set => no rows (fail closed).

CREATE FUNCTION app_all_branches() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.all_branches', true), '') = '1'
$$;

CREATE FUNCTION app_branch_ids() RETURNS int[]
LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('app.branch_ids', true), '')::int[], '{}'::int[])
$$;

ALTER TABLE computer ENABLE ROW LEVEL SECURITY;
CREATE POLICY computer_branch_scope ON computer
  FOR ALL TO app_node
  USING      (app_all_branches() OR branch_id = ANY (app_branch_ids()))
  WITH CHECK (app_all_branches() OR branch_id = ANY (app_branch_ids()));

-- A key is visible only if its computer is (the subquery is itself filtered by computer's policy).
ALTER TABLE recovery_key ENABLE ROW LEVEL SECURITY;
CREATE POLICY recovery_key_branch_scope ON recovery_key
  FOR ALL TO app_node
  USING      (EXISTS (SELECT 1 FROM computer c WHERE c.id = recovery_key.computer_id))
  WITH CHECK (EXISTS (SELECT 1 FROM computer c WHERE c.id = recovery_key.computer_id));

ALTER TABLE access_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY access_log_insert ON access_log
  FOR INSERT TO app_node WITH CHECK (true);
-- Reading the log: whole log only with all_branches; leads see their branches.
CREATE POLICY access_log_read ON access_log
  FOR SELECT TO app_node
  USING (app_all_branches() OR branch_id = ANY (app_branch_ids()));

-- The hash-chain writer needs the newest row's (id, hash) whatever the caller's scope.
-- Exposes only that pair; runs as the table owner, so RLS does not hide other branches' rows.
CREATE FUNCTION access_log_tail() RETURNS TABLE (id bigint, hash bytea)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id, hash FROM access_log ORDER BY id DESC LIMIT 1
$$;
REVOKE ALL ON FUNCTION access_log_tail() FROM PUBLIC;

-- Grants for the runtime account. No DELETE on keys/computers; log is INSERT + SELECT only.
GRANT SELECT, INSERT, UPDATE         ON branch                 TO app_node;
GRANT SELECT, INSERT, UPDATE, DELETE ON branch_ou, branch_group TO app_node;
GRANT SELECT, INSERT, UPDATE         ON computer, recovery_key  TO app_node;
GRANT SELECT, INSERT                 ON access_log              TO app_node;
GRANT SELECT, INSERT, UPDATE         ON sync_run, sync_metric, sync_alert, worker_heartbeat TO app_node;
GRANT SELECT, INSERT, UPDATE         ON app_setting             TO app_node;
GRANT SELECT, INSERT, UPDATE, DELETE ON session                 TO app_node;
GRANT EXECUTE ON FUNCTION app_all_branches(), app_branch_ids(), access_log_tail() TO app_node;
