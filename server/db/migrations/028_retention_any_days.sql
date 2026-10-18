-- Giu nhat ky truy cap bao nhieu ngay do Admin HQ tu chon (truoc day toi thieu 365 ngay): tu 1 ngay tro len.
-- Hai bao ve van con: khong bao gio xoa dong moi nhat, moi lan xoa luu lai moc hash de phan con lai van kiem chung duoc.
CREATE OR REPLACE FUNCTION purge_access_log(p_days int, p_by varchar) RETURNS TABLE (deleted bigint, up_to_id bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cutoff timestamptz := now() - make_interval(days => p_days);
  v_upto   bigint;
  v_hash   bytea;
  v_rows   bigint;
BEGIN
  IF p_days IS NULL OR p_days < 1 THEN
    RAISE EXCEPTION 'access_log retention must be at least 1 day';
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
