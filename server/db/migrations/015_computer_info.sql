-- The hand-entered fields belong to the computer, not to each key (014 put them on recovery_key),
-- and the drive name is not kept. Machine serial and the user's e-mail: empty when the computer
-- arrives from AD, filled in by IT; sync never writes them.
ALTER TABLE computer
  ADD COLUMN device_serial   varchar(64)  NULL,
  ADD COLUMN owner_email     varchar(254) NULL,
  ADD COLUMN info_updated_at timestamptz  NULL,
  ADD COLUMN info_updated_by varchar(256) NULL;

-- Keep anything already typed on a key: per computer, the most recently edited key wins.
UPDATE computer c
   SET device_serial = k.device_serial, owner_email = k.owner_email,
       info_updated_at = k.info_updated_at, info_updated_by = k.info_updated_by
  FROM (SELECT DISTINCT ON (computer_id) computer_id, device_serial, owner_email, info_updated_at, info_updated_by
          FROM recovery_key WHERE info_updated_at IS NOT NULL
         ORDER BY computer_id, info_updated_at DESC) k
 WHERE k.computer_id = c.id;

ALTER TABLE recovery_key
  DROP COLUMN drive_label,
  DROP COLUMN device_serial,
  DROP COLUMN owner_email,
  DROP COLUMN info_updated_at,
  DROP COLUMN info_updated_by;
