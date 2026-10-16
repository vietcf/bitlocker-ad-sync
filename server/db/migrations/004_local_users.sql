-- Temporary sign-in with accounts stored in this database (before OIDC is wired up).
-- Roles are granted per branch, exactly like branch_group does for AD groups,
-- so the rest of the app sees the same kind of grants whichever sign-in is used.

CREATE TABLE local_user (
  id                    int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username              varchar(128) NOT NULL,
  display_name          varchar(256) NOT NULL,
  password_hash         text NOT NULL,
  is_active             boolean NOT NULL DEFAULT true,
  must_change_password  boolean NOT NULL DEFAULT true,
  failed_attempts       int NOT NULL DEFAULT 0,
  locked_until          timestamptz NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  password_changed_at   timestamptz NOT NULL DEFAULT now(),
  last_login_at         timestamptz NULL
);
CREATE UNIQUE INDEX ux_local_user_username ON local_user (lower(username));

CREATE TABLE local_user_grant (
  user_id    int NOT NULL REFERENCES local_user(id) ON DELETE CASCADE,
  branch_id  int NULL REFERENCES branch(id) ON DELETE CASCADE,   -- NULL = all branches
  role       varchar(16) NOT NULL CHECK (role IN ('it', 'lead', 'admin', 'auditor')),
  UNIQUE NULLS NOT DISTINCT (user_id, branch_id, role)
);

-- Users are disabled, never deleted, so the audit log keeps pointing at real accounts.
GRANT SELECT, INSERT, UPDATE         ON local_user       TO app_node;
GRANT SELECT, INSERT, UPDATE, DELETE ON local_user_grant TO app_node;
