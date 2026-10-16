-- Truong hop may unjoin khoi AD roi join lai: AD tao computer object moi (objectGUID moi), key cu
-- duoc day len lai voi cung Key ID. Key duoc chuyen sang may moi (khong xoa gi), lich su ghi o day.
CREATE TABLE key_owner_change (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key_id            uuid        NOT NULL REFERENCES recovery_key(key_id),
  from_computer_id  bigint      NOT NULL REFERENCES computer(id),
  to_computer_id    bigint      NOT NULL REFERENCES computer(id),
  run_id            bigint      NULL REFERENCES sync_run(id),
  reason            varchar(20) NOT NULL CHECK (reason IN ('rejoin_same_name', 'old_not_in_ad')),
  at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_key_owner_change_key  ON key_owner_change (key_id);
CREATE INDEX ix_key_owner_change_from ON key_owner_change (from_computer_id);
CREATE INDEX ix_key_owner_change_to   ON key_owner_change (to_computer_id);

-- Cung Key ID nam duoi them mot may khac (computer_id) trong khi may dang giu key van con trong AD
-- (vi du may clone tu image da bat BitLocker), hoac cung Key ID nhung mat khau khac.
-- Mot dong cho moi cap (key, may); khong bao gio xoa, chi dong lai (resolved_at).
CREATE TABLE key_duplicate (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key_id          uuid         NOT NULL REFERENCES recovery_key(key_id),
  computer_id     bigint       NOT NULL REFERENCES computer(id),
  same_password   boolean      NOT NULL,
  first_seen_run  bigint       NULL REFERENCES sync_run(id),
  detected_at     timestamptz  NOT NULL DEFAULT now(),
  last_seen_at    timestamptz  NOT NULL DEFAULT now(),
  notified_at     timestamptz  NULL,
  resolved_at     timestamptz  NULL,
  -- reviewed: Admin HQ da xem xet; gone: mot trong hai may roi AD; moved: key da chuyen sang may nay
  resolution      varchar(10)  NULL CHECK (resolution IN ('reviewed', 'gone', 'moved')),
  resolved_by     varchar(184) NULL,
  UNIQUE (key_id, computer_id)
);
CREATE INDEX ix_key_duplicate_open ON key_duplicate (resolved_at) WHERE resolved_at IS NULL;

-- Hai lop phan quyen nhu cac bang khac: thay dong neu thay duoc may lien quan.
ALTER TABLE key_owner_change ENABLE ROW LEVEL SECURITY;
CREATE POLICY key_owner_change_scope ON key_owner_change
  FOR ALL TO app_node
  USING      (EXISTS (SELECT 1 FROM computer c WHERE c.id IN (key_owner_change.from_computer_id, key_owner_change.to_computer_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM computer c WHERE c.id = key_owner_change.to_computer_id));

ALTER TABLE key_duplicate ENABLE ROW LEVEL SECURITY;
CREATE POLICY key_duplicate_scope ON key_duplicate
  FOR ALL TO app_node
  USING      (EXISTS (SELECT 1 FROM computer c WHERE c.id = key_duplicate.computer_id)
              OR EXISTS (SELECT 1 FROM recovery_key k WHERE k.key_id = key_duplicate.key_id))
  WITH CHECK (EXISTS (SELECT 1 FROM computer c WHERE c.id = key_duplicate.computer_id));

GRANT SELECT, INSERT         ON key_owner_change TO app_node;
GRANT SELECT, INSERT, UPDATE ON key_duplicate    TO app_node;
