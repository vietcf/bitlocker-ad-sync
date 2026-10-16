-- Key rotation after a reveal is no longer tracked. A key is either the machine's current key
-- (active) or has a newer key in AD (superseded). When a key was last revealed is still kept;
-- who revealed it and why stays in access_log.

UPDATE recovery_key SET status = 'superseded' WHERE status = 'rotated';
-- A revealed key is active again unless the machine already has a newer key.
UPDATE recovery_key k SET status = CASE
    WHEN EXISTS (SELECT 1 FROM recovery_key n
                  WHERE n.computer_id = k.computer_id AND n.id <> k.id AND n.ad_created_at > k.ad_created_at)
    THEN 'superseded' ELSE 'active' END
 WHERE status = 'used';

ALTER TABLE recovery_key DROP CONSTRAINT recovery_key_status_check;
ALTER TABLE recovery_key ADD CONSTRAINT recovery_key_status_check CHECK (status IN ('active', 'superseded'));

ALTER TABLE recovery_key RENAME COLUMN used_at TO last_revealed_at;
ALTER TABLE recovery_key DROP COLUMN rotation_confirmed_at;
ALTER TABLE recovery_key DROP COLUMN rotation_confirmed_by;
