-- E-mail of each app user, set by Admin HQ (required on the user form). AD users whose e-mail is
-- still empty get their AD "mail" attribute at their next sign-in. Not unique: one person may
-- have an AD account and a break-glass local account.
ALTER TABLE app_user ADD COLUMN email varchar(254) NULL;
