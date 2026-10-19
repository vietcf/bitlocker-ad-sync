-- Bo chuoi hash cua nhat ky truy cap: nhat ky van chi them (trigger chan UPDATE/DELETE/TRUNCATE), khong con ky HMAC.
-- Mot ham nho tra id dong vua ghi (currval theo phien) thay cho access_log_tail().
CREATE FUNCTION access_log_last_id() RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT currval(pg_get_serial_sequence('access_log', 'id'))
$$;
REVOKE ALL ON FUNCTION access_log_last_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION access_log_last_id() TO app_node;

DROP FUNCTION access_log_tail();
ALTER TABLE access_log DROP COLUMN prev_hash, DROP COLUMN hash;
ALTER TABLE access_log_purge DROP COLUMN last_hash;

-- Xoa nhat ky cu theo han luu tru: khong con moc hash, van khong bao gio xoa dong moi nhat.
CREATE OR REPLACE FUNCTION purge_access_log(p_days int, p_by varchar) RETURNS TABLE (deleted bigint, up_to_id bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cutoff timestamptz := now() - make_interval(days => p_days);
  v_upto   bigint;
  v_rows   bigint;
BEGIN
  IF p_days IS NULL OR p_days < 1 THEN
    RAISE EXCEPTION 'access_log retention must be at least 1 day';
  END IF;
  SELECT max(l.id) INTO v_upto FROM access_log l
   WHERE l.at < v_cutoff AND l.id < (SELECT max(id) FROM access_log);
  IF v_upto IS NULL THEN
    RETURN QUERY SELECT 0::bigint, NULL::bigint;
    RETURN;
  END IF;
  PERFORM set_config('blk.access_log_purge', 'on', true);
  DELETE FROM access_log WHERE id <= v_upto;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM set_config('blk.access_log_purge', 'off', true);
  INSERT INTO access_log_purge (purged_by, before_at, up_to_id, rows) VALUES (p_by, v_cutoff, v_upto, v_rows);
  RETURN QUERY SELECT v_rows, v_upto;
END $$;

-- Canh bao cu ve chuoi hash khong con y nghia: dong cac canh bao dang mo, bo gio kiem tra hang ngay.
UPDATE sync_alert SET resolved_at = now() WHERE type = 'audit_chain_broken' AND resolved_at IS NULL;
DELETE FROM app_setting WHERE key = 'jobs.chain_check_time';
