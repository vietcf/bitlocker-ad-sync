-- Core schema. Runs as blk_owner. See design doc "Thiet ke chi tiet" > DDL.

CREATE TABLE branch (
  id          int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        varchar(16)  NOT NULL UNIQUE,
  name        varchar(128) NOT NULL,
  is_active   boolean      NOT NULL DEFAULT true
);

-- A branch owns one or more root OUs; computers in sub-OUs belong to it too.
-- root_dn is stored lower-cased so suffix matching is case-insensitive.
CREATE TABLE branch_ou (
  branch_id   int  NOT NULL REFERENCES branch(id) ON DELETE CASCADE,
  root_dn     text NOT NULL UNIQUE CHECK (root_dn = lower(root_dn))
);

-- AD group (by SID, survives renames) -> branch + role. branch_id NULL = all branches.
CREATE TABLE branch_group (
  id            int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ad_group_sid  varchar(184) NOT NULL,
  label         varchar(256) NULL,          -- display only, e.g. GG-BLK-CN-HN
  branch_id     int NULL REFERENCES branch(id) ON DELETE CASCADE,
  role          varchar(16) NOT NULL CHECK (role IN ('it', 'lead', 'admin', 'auditor')),
  UNIQUE NULLS NOT DISTINCT (ad_group_sid, branch_id, role)
);
CREATE INDEX ix_branch_group_sid ON branch_group (ad_group_sid);

CREATE TABLE computer (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  object_guid         uuid         NOT NULL UNIQUE,
  name                varchar(64)  NOT NULL,
  dns_name            varchar(255) NULL,
  distinguished_name  text         NOT NULL,
  branch_id           int NULL REFERENCES branch(id),   -- NULL = not mapped, Admin HQ only
  os                  varchar(128) NULL,
  when_changed        timestamptz  NULL,
  ad_created_at       timestamptz  NULL,
  last_seen_run       bigint       NULL,
  deleted_in_ad_at    timestamptz  NULL
);
CREATE INDEX ix_computer_name   ON computer (lower(name) text_pattern_ops);
CREATE INDEX ix_computer_branch ON computer (branch_id);
CREATE INDEX ix_computer_dn     ON computer (lower(distinguished_name));

CREATE TABLE recovery_key (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  computer_id            bigint NOT NULL REFERENCES computer(id),
  key_id                 uuid   NOT NULL UNIQUE,
  key_id_prefix          char(8) GENERATED ALWAYS AS (upper(left(key_id::text, 8))) STORED,
  recovery_password      char(55) NOT NULL CHECK (recovery_password ~ '^[0-9]{6}(-[0-9]{6}){7}$'),
  ad_created_at          timestamptz NOT NULL,
  first_synced_at        timestamptz NOT NULL DEFAULT now(),
  status                 varchar(12) NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'used', 'superseded', 'rotated')),
  used_at                timestamptz NULL,
  rotation_confirmed_at  timestamptz NULL,
  rotation_confirmed_by  varchar(184) NULL
);
CREATE INDEX ix_key_prefix   ON recovery_key (key_id_prefix);
CREATE INDEX ix_key_computer ON recovery_key (computer_id, ad_created_at DESC);

-- Append-only, hash-chained. Never contains a recovery password.
CREATE TABLE access_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at           timestamptz  NOT NULL DEFAULT now(),
  user_sid     varchar(184) NOT NULL,
  user_upn     varchar(256) NOT NULL,
  action       varchar(32)  NOT NULL,
  computer_id  bigint NULL,
  key_id       uuid   NULL,
  branch_id    int    NULL,
  reason       varchar(64)  NULL,
  reason_note  varchar(500) NULL,
  ticket_no    varchar(64)  NULL,
  client_ip    varchar(45)  NULL,
  user_agent   varchar(256) NULL,
  detail       jsonb  NULL,
  prev_hash    bytea  NOT NULL CHECK (octet_length(prev_hash) = 32),
  hash         bytea  NOT NULL CHECK (octet_length(hash) = 32)
);
CREATE INDEX ix_log_user   ON access_log (user_sid, at);
CREATE INDEX ix_log_branch ON access_log (branch_id, at);
CREATE INDEX ix_log_at     ON access_log (at);

CREATE FUNCTION access_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'access_log is append-only';
END $$;
CREATE TRIGGER trg_access_log_immutable
  BEFORE UPDATE OR DELETE ON access_log
  FOR EACH ROW EXECUTE FUNCTION access_log_immutable();
CREATE TRIGGER trg_access_log_no_truncate
  BEFORE TRUNCATE ON access_log
  FOR EACH STATEMENT EXECUTE FUNCTION access_log_immutable();

CREATE TABLE sync_run (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz NULL,
  mode            varchar(5)  NOT NULL CHECK (mode IN ('full', 'delta')),
  dc_name         varchar(255) NOT NULL,
  since_usn       bigint NOT NULL DEFAULT 0,
  highest_usn     bigint NULL,
  computers_seen  int NULL,
  keys_added      int NULL,
  errors          int NULL,
  error_code      varchar(32) NULL,
  status          varchar(12) NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running', 'success', 'quarantined', 'failed', 'aborted')),
  ack_by          varchar(184) NULL,
  ack_decision    varchar(8) NULL CHECK (ack_decision IN ('accept', 'reject')),
  ack_at          timestamptz NULL
);
-- At most one run in progress.
CREATE UNIQUE INDEX ux_sync_run_running ON sync_run ((true)) WHERE status = 'running';

CREATE TABLE sync_metric (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id            bigint NOT NULL REFERENCES sync_run(id),
  branch_id         int NULL,             -- NULL = whole system
  computers_seen    int NOT NULL,
  computers_in_db   int NOT NULL,
  keys_seen         int NOT NULL,
  keys_expected     int NOT NULL,
  keys_empty_pwd    int NOT NULL,
  new_computers_7d  int NOT NULL,
  new_without_key   int NOT NULL,
  pct_no_key        numeric(5,2) NOT NULL,
  dc_highest_usn    bigint NULL,
  UNIQUE NULLS NOT DISTINCT (run_id, branch_id)
);

CREATE TABLE sync_alert (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type              varchar(48) NOT NULL,
  severity          varchar(8)  NOT NULL CHECK (severity IN ('high', 'medium')),
  opened_at         timestamptz NOT NULL DEFAULT now(),
  last_notified_at  timestamptz NULL,
  resolved_at       timestamptz NULL,
  detail            jsonb NOT NULL DEFAULT '{}'
);
-- One open alert per type: repeats update it instead of piling up.
CREATE UNIQUE INDEX ux_sync_alert_open ON sync_alert (type) WHERE resolved_at IS NULL;

CREATE TABLE worker_heartbeat (
  worker_id            varchar(64) PRIMARY KEY,
  at                   timestamptz NOT NULL DEFAULT now(),
  version              varchar(32) NULL,
  dc_name              varchar(255) NULL,
  ldap_ok              boolean NULL,
  last_error_code      varchar(32) NULL,
  queue_len            int NULL,
  dc_cert_expires_at   timestamptz NULL,
  canary_value         timestamptz NULL
);

-- Tunable thresholds and options (rate limits, anomaly thresholds, reasons list...).
CREATE TABLE app_setting (
  key    varchar(64) PRIMARY KEY,
  value  jsonb NOT NULL
);

-- express-session store (connect-pg-simple layout).
CREATE TABLE session (
  sid     varchar NOT NULL PRIMARY KEY,
  sess    json NOT NULL,
  expire  timestamp(6) NOT NULL
);
CREATE INDEX ix_session_expire ON session (expire);
