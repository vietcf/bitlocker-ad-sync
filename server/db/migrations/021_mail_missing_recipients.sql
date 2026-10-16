-- Users who should have received a mail but have no e-mail address (usernames), shown in
-- Quan tri > Log email next to the recipients.
ALTER TABLE mail_outbox ADD COLUMN missing_recipients text[] NOT NULL DEFAULT '{}';
