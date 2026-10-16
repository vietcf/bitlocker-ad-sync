-- Sign-in with the user's Active Directory password over LDAPS, for authentication only.
-- Who may do what stays in this app: a person can sign in with their AD password only if an
-- admin created their user here first. AD-group -> role mapping is therefore not used: removed.

DROP TABLE branch_group;

-- Users are no longer only "local": rename for clarity.
ALTER TABLE local_user RENAME TO app_user;
ALTER TABLE local_user_grant RENAME TO user_grant;
ALTER INDEX ux_local_user_username RENAME TO ux_app_user_username;

-- ldap  = password checked by Active Directory (username = sAMAccountName), nothing stored here;
-- local = password hash stored here (e.g. a break-glass admin for when AD is unreachable).
ALTER TABLE app_user ADD COLUMN auth_source varchar(8) NOT NULL DEFAULT 'local'
  CHECK (auth_source IN ('local', 'ldap'));
ALTER TABLE app_user ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE app_user ADD CONSTRAINT app_user_password_for_local
  CHECK (auth_source = 'ldap' OR password_hash IS NOT NULL);

-- The AD account's objectGUID, bound at the first successful sign-in and checked on every later
-- one: a deleted-and-recreated account with the same name (a different person) cannot take over.
ALTER TABLE app_user ADD COLUMN ad_object_guid uuid NULL;
ALTER TABLE app_user ADD COLUMN ad_linked_at timestamptz NULL;
CREATE UNIQUE INDEX ux_app_user_ad_guid ON app_user (ad_object_guid) WHERE ad_object_guid IS NOT NULL;
