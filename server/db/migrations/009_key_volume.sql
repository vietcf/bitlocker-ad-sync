-- Which encrypted volume a key belongs to (msFVE-VolumeGuid). A computer can have several volumes
-- (C:, D:...), and each volume one or more recovery keys. "superseded" now only means "this
-- volume has a newer key"; a new key for D: no longer marks C:'s key as superseded.
-- Keys stored before this column existed get their volume on the next full sync.
ALTER TABLE recovery_key ADD COLUMN volume_guid uuid NULL;
CREATE INDEX ix_key_computer_volume ON recovery_key (computer_id, volume_guid, ad_created_at DESC);
