-- Tim may (search box): a part of the name / serial / e-mail anywhere ("contains", from 3 characters),
-- ignoring case and the separators - _ . and spaces; a Key ID from its first 4 characters.
-- pg_trgm is a trusted extension: the database owner (blk_owner) may create it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Same expression as in computers.repo.js (searchKey): must stay identical for the index to be used.
CREATE INDEX ix_computer_name_search   ON computer USING gin (regexp_replace(lower(name), '[-_.[:space:]]', '', 'g') gin_trgm_ops);
CREATE INDEX ix_computer_serial_search ON computer USING gin (regexp_replace(lower(device_serial), '[-_.[:space:]]', '', 'g') gin_trgm_ops);
CREATE INDEX ix_computer_email_search  ON computer USING gin (regexp_replace(lower(owner_email), '[-_.[:space:]]', '', 'g') gin_trgm_ops);

-- Key ID by its first characters (4 to 36): prefix search on the text form.
CREATE INDEX ix_key_id_text ON recovery_key ((key_id::text) text_pattern_ops);
