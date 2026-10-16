-- Mail log keeps every mail the app meant to send. A mail with nobody to send it to (no Admin HQ or
-- branch user with an e-mail address) is stored as 'no_recipient' with the reason, so it shows in
-- Quan tri > Log email instead of disappearing.
ALTER TABLE mail_outbox DROP CONSTRAINT mail_outbox_status_check;
ALTER TABLE mail_outbox ADD CONSTRAINT mail_outbox_status_check
  CHECK (status IN ('pending', 'sent', 'failed', 'no_recipient'));
