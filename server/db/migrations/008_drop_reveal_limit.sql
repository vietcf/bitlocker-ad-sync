-- No limit on how many keys a user may reveal any more: every reveal is still logged, and
-- reveals outside working hours or on sensitive machines still raise an alert.
DELETE FROM app_setting WHERE key IN ('reveal.limit_per_hour', 'reveal.limit_per_day');
DROP FUNCTION IF EXISTS reveal_counts(text);
