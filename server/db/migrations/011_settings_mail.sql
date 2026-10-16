-- Settings screen: SMTP, notifications, feature switches, and a mail outbox.
--
-- Every e-mail is written to mail_outbox first; a job sends what is due, retries failures with
-- back-off, and deletes old rows after mail.retention_days. Nothing in an e-mail is ever a key.

CREATE TABLE mail_outbox (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind             varchar(32)  NOT NULL,              -- alert | new_objects | test
  recipients       text[]       NOT NULL,
  subject          varchar(300) NOT NULL,
  body             text         NOT NULL,
  status           varchar(12)  NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts         int          NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz  NOT NULL DEFAULT now(),
  last_error       varchar(500) NULL,
  created_at       timestamptz  NOT NULL DEFAULT now(),
  sent_at          timestamptz  NULL
);
CREATE INDEX ix_mail_outbox_due     ON mail_outbox (next_attempt_at) WHERE status = 'pending';
CREATE INDEX ix_mail_outbox_created ON mail_outbox (created_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON mail_outbox TO app_node;

-- The run that first stored a computer / key: "new in this run" for notifications.
ALTER TABLE computer     ADD COLUMN first_seen_run bigint NULL;
ALTER TABLE recovery_key ADD COLUMN first_seen_run bigint NULL;
CREATE INDEX ix_computer_first_seen ON computer (first_seen_run) WHERE first_seen_run IS NOT NULL;
CREATE INDEX ix_key_first_seen      ON recovery_key (first_seen_run) WHERE first_seen_run IS NOT NULL;

INSERT INTO app_setting (key, value) VALUES
  -- SMTP server. password holds "enc:v1:..." (AES-256-GCM), never plain text.
  ('mail.smtp', '{"enabled": false, "host": "", "port": 587, "security": "starttls", "username": "", "password": null,
                  "from": "bitlocker-keys@corp.local", "rejectUnauthorized": true, "appUrl": ""}'),
  ('mail.retention_days', '90'),
  ('notify.alerts',      '{"enabled": true, "admins": true, "extra": []}'),
  ('notify.new_objects', '{"computers": false, "keys": false, "branchUsers": true, "admins": true, "skipFirstFull": true, "maxItems": 100}'),
  ('feature.manual_sync',   'true'),
  ('feature.audit_export',  'true'),
  ('feature.reveal_alerts', 'true')
ON CONFLICT (key) DO NOTHING;
