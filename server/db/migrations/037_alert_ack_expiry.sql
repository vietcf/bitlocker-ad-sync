-- "Da xu ly" nay co han nhu "Bo qua": het han ma dieu kien con thi bao lai (cai dat alerts.ack_reopen_days, mac dinh 30 ngay).
-- Canh bao da xu ly truoc day duoc tinh han tu luc bam.
UPDATE sync_alert SET snoozed_until = acked_at + interval '30 days'
 WHERE resolved_at IS NULL AND acked_at IS NOT NULL AND snoozed_until IS NULL;
