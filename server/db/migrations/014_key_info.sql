-- Information IT adds to a key by hand (empty when the key arrives from AD): the drive's name,
-- the machine's serial number and the e-mail of the person using it. Sync never writes these.
ALTER TABLE recovery_key
  ADD COLUMN drive_label     varchar(64)  NULL,
  ADD COLUMN device_serial   varchar(64)  NULL,
  ADD COLUMN owner_email     varchar(254) NULL,
  ADD COLUMN info_updated_at timestamptz  NULL,
  ADD COLUMN info_updated_by varchar(256) NULL;
