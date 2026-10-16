-- When a computer was first recorded in this system (keys already have first_synced_at).
-- Shown next to the AD creation date, and used by the "appeared between" filter of Tim may.
ALTER TABLE computer ADD COLUMN first_seen_at timestamptz NULL;

-- Existing rows: the start of the run that first stored them, else their oldest key's recording
-- time, else now (the best we know).
UPDATE computer c
   SET first_seen_at = coalesce(
         (SELECT r.started_at FROM sync_run r WHERE r.id = c.first_seen_run),
         (SELECT min(k.first_synced_at) FROM recovery_key k WHERE k.computer_id = c.id),
         now());

ALTER TABLE computer ALTER COLUMN first_seen_at SET DEFAULT now();
ALTER TABLE computer ALTER COLUMN first_seen_at SET NOT NULL;
CREATE INDEX ix_computer_first_seen_at ON computer (first_seen_at);
CREATE INDEX ix_computer_ad_created_at ON computer (ad_created_at);
