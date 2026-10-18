import { hashPassword } from './password.js';

// Users of this app and their per-branch roles. Every person is created here by an admin;
// they then sign in with their Active Directory password over LDAPS (auth_source 'ldap',
// username = sAMAccountName) or with a password stored here (auth_source 'local').
// Not under RLS: holds no keys.

import { LOCKOUT_DEFAULTS } from './lockout.js';

/** Stable identifier of a user in the audit log. */
export const userSid = (id) => `user:${id}`;

const LOGIN_COLUMNS = `id, username, display_name, auth_source, password_hash, is_active, must_change_password, ad_object_guid,
            totp_required, totp_enrolled_at, (locked_until IS NOT NULL AND locked_until > now()) AS is_locked`;

export async function findForLogin(db, username) {
  const { rows } = await db.query(`SELECT ${LOGIN_COLUMNS} FROM app_user WHERE lower(username) = lower($1)`, [username]);
  return rows[0] ?? null;
}

/** Same as findForLogin, by id (second sign-in step). */
export async function findForLoginById(db, id) {
  const { rows } = await db.query(`SELECT ${LOGIN_COLUMNS} FROM app_user WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

// ---- two-step sign-in (TOTP) -------------------------------------------------------------------

/** { totp_required, totp_secret (encrypted), totp_enrolled_at, totp_last_step } */
export async function getTotp(db, id) {
  const { rows } = await db.query(
    'SELECT totp_required, totp_secret, totp_enrolled_at, totp_last_step FROM app_user WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

/** Stores a new (encrypted) secret, not confirmed yet: the user scans it and types a first code. */
export async function setPendingTotpSecret(db, id, encrypted) {
  await db.query(
    'UPDATE app_user SET totp_secret = $2, totp_enrolled_at = NULL, totp_last_step = NULL WHERE id = $1',
    [id, encrypted],
  );
}

/**
 * Records a used code step: only if it is newer than the last one (a code works once).
 * enroll: the first code confirms the secret. Returns false when the step was already used.
 */
export async function useTotpStep(db, id, step, { enroll = false } = {}) {
  const { rowCount } = await db.query(
    `UPDATE app_user
        SET totp_last_step = $2, totp_enrolled_at = CASE WHEN $3 THEN now() ELSE totp_enrolled_at END
      WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)`,
    [id, step, enroll],
  );
  return rowCount === 1;
}

/** Turns two-step sign-in on or off. Off (or a reset) forgets the secret: a new QR code next time. */
export async function setTotpRequired(db, id, required) {
  await db.query(
    `UPDATE app_user SET totp_required = $2,
            totp_secret = CASE WHEN $2 THEN totp_secret ELSE NULL END,
            totp_enrolled_at = CASE WHEN $2 THEN totp_enrolled_at ELSE NULL END,
            totp_last_step = CASE WHEN $2 THEN totp_last_step ELSE NULL END
      WHERE id = $1`,
    [id, required],
  );
}

/** Forgets the user's authenticator (lost phone): they scan a new QR code at the next sign-in. */
export async function resetTotp(db, id) {
  await db.query('UPDATE app_user SET totp_secret = NULL, totp_enrolled_at = NULL, totp_last_step = NULL WHERE id = $1', [id]);
}

/** Local accounts only: must (or need not) change the password at the next sign-in. */
export async function setMustChangePassword(db, id, mustChange) {
  await db.query(`UPDATE app_user SET must_change_password = $2 WHERE id = $1 AND auth_source = 'local'`, [id, mustChange]);
}

/** First AD sign-in: remember which AD account this user is (its objectGUID never changes). */
export async function bindAdGuid(db, id, guid) {
  await db.query(
    `UPDATE app_user SET ad_object_guid = $2, ad_linked_at = now() WHERE id = $1 AND ad_object_guid IS NULL`,
    [id, guid],
  );
}

/** Forget the bound AD account (e.g. the person's AD account was recreated). */
export async function unlinkAd(db, id) {
  await db.query(`UPDATE app_user SET ad_object_guid = NULL, ad_linked_at = NULL WHERE id = $1`, [id]);
}

/**
 * Counts a wrong password; locks the account on the policy's maxAttempts-th (for lockMinutes, 0 = until
 * Admin HQ unlocks it). Does nothing when the lockout is off, or for an Admin HQ account when the policy
 * excludes them. Returns true if now locked.
 */
export async function recordFailure(db, id, policy = LOCKOUT_DEFAULTS) {
  if (!policy.enabled) return false;
  if (!policy.applyToAdmin) {
    const { rows: admin } = await db.query(`SELECT 1 FROM user_grant WHERE user_id = $1 AND role = 'admin' LIMIT 1`, [id]);
    if (admin.length) return false;
  }
  const { rows } = await db.query(
    `UPDATE app_user
        SET failed_attempts = CASE WHEN failed_attempts + 1 >= $2 THEN 0 ELSE failed_attempts + 1 END,
            locked_until    = CASE WHEN failed_attempts + 1 < $2 THEN locked_until
                                   WHEN $3::int = 0 THEN 'infinity'::timestamptz
                                   ELSE now() + make_interval(mins => $3::int) END
      WHERE id = $1
      RETURNING locked_until IS NOT NULL AND locked_until > now() AS locked`,
    [id, policy.maxAttempts, policy.lockMinutes],
  );
  return rows[0]?.locked ?? false;
}

export async function recordSuccess(db, id) {
  await db.query(`UPDATE app_user SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`, [id]);
}

const GRANTS_JSON = `coalesce(json_agg(json_build_object('branchId', g.branch_id, 'role', g.role, 'branchCode', b.code)
                       ORDER BY g.role, b.code) FILTER (WHERE g.role IS NOT NULL), '[]')`;

/** Active user + grants (inactive branches dropped), or null if missing/disabled. */
export async function loadPrincipal(db, id) {
  const { rows } = await db.query(
    `SELECT u.id, u.username, u.display_name, u.email, u.auth_source, u.must_change_password,
            coalesce(json_agg(json_build_object('branchId', g.branch_id, 'role', g.role))
                       FILTER (WHERE g.role IS NOT NULL AND (g.branch_id IS NULL OR b.is_active)), '[]') AS grants
       FROM app_user u
       LEFT JOIN user_grant g ON g.user_id = u.id
       LEFT JOIN branch b ON b.id = g.branch_id
      WHERE u.id = $1 AND u.is_active
      GROUP BY u.id`,
    [id],
  );
  return rows[0] ?? null;
}

export async function getPasswordHash(db, id) {
  const { rows } = await db.query('SELECT password_hash FROM app_user WHERE id = $1', [id]);
  return rows[0]?.password_hash ?? null;
}

export async function setPassword(db, id, passwordHash, { mustChange }) {
  await db.query(
    `UPDATE app_user
        SET password_hash = $2, must_change_password = $3, password_changed_at = now(),
            failed_attempts = 0, locked_until = NULL
      WHERE id = $1`,
    [id, passwordHash, mustChange],
  );
}

/**
 * Creates a user with grants [{ branchId, role }]. Returns the new id.
 * LDAP users have no password here and never a forced password change.
 */
export async function createUser(db, { username, displayName, email = null, authSource = 'local', passwordHash = null, mustChange = true, totpRequired = false, grants = [] }) {
  const { rows } = await db.query(
    `INSERT INTO app_user (username, display_name, email, auth_source, password_hash, must_change_password, totp_required)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [username, displayName, email, authSource, authSource === 'ldap' ? null : passwordHash, authSource === 'ldap' ? false : mustChange, totpRequired],
  );
  await replaceGrants(db, rows[0].id, grants);
  return rows[0].id;
}

export async function replaceGrants(db, userId, grants) {
  await db.query('DELETE FROM user_grant WHERE user_id = $1', [userId]);
  for (const g of grants) {
    await db.query(
      `INSERT INTO user_grant (user_id, branch_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [userId, g.branchId, g.role],
    );
  }
}

const USER_COLUMNS = `u.id, u.username, u.display_name, u.email, u.auth_source, u.is_active, u.must_change_password, u.last_login_at,
  u.ad_object_guid, u.ad_linked_at, (u.locked_until IS NOT NULL AND u.locked_until > now()) AS is_locked,
  (u.locked_until = 'infinity') AS lock_permanent,
  u.totp_required, u.totp_enrolled_at`;

export async function listUsers(db) {
  const { rows } = await db.query(
    `SELECT ${USER_COLUMNS}, ${GRANTS_JSON} AS grants
       FROM app_user u
       LEFT JOIN user_grant g ON g.user_id = u.id
       LEFT JOIN branch b ON b.id = g.branch_id
      GROUP BY u.id
      ORDER BY lower(u.username)`,
  );
  return rows;
}

export async function getUser(db, id) {
  const { rows } = await db.query(
    `SELECT ${USER_COLUMNS}, ${GRANTS_JSON} AS grants
       FROM app_user u
       LEFT JOIN user_grant g ON g.user_id = u.id
       LEFT JOIN branch b ON b.id = g.branch_id
      WHERE u.id = $1
      GROUP BY u.id`,
    [id],
  );
  return rows[0] ?? null;
}

export async function updateUser(db, id, { displayName, email, isActive }) {
  await db.query('UPDATE app_user SET display_name = $2, email = $3, is_active = $4 WHERE id = $1', [id, displayName, email, isActive]);
}

/** Fills an AD user's e-mail from AD's "mail" attribute, only while it is still empty. */
export async function fillEmailIfEmpty(db, id, email) {
  await db.query('UPDATE app_user SET email = $2 WHERE id = $1 AND email IS NULL', [id, email.toLowerCase()]);
}

/** Switches how a user signs in. To 'ldap': the stored password is removed. To 'local': `passwordHash` is set. */
export async function setAuthSource(db, id, authSource, passwordHash = null) {
  await db.query(
    `UPDATE app_user
        SET auth_source = $2::varchar, password_hash = $3, must_change_password = ($2::varchar = 'local'),
            failed_attempts = 0, locked_until = NULL
      WHERE id = $1`,
    [id, authSource, authSource === 'ldap' ? null : passwordHash],
  );
}

export async function unlockUser(db, id) {
  await db.query('UPDATE app_user SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [id]);
}

/** Number of active users that hold the admin role (to refuse removing the last one). */
export async function countActiveAdmins(db, exceptUserId = null) {
  const { rows } = await db.query(
    `SELECT count(DISTINCT u.id)::int AS n
       FROM app_user u JOIN user_grant g ON g.user_id = u.id
      WHERE u.is_active AND g.role = 'admin' AND ($1::int IS NULL OR u.id <> $1)`,
    [exceptUserId],
  );
  return rows[0].n;
}

export const DEFAULT_ADMIN = { username: 'admin', password: 'admin' };

/**
 * First start only: if there are no users at all, creates the local account admin/admin with the
 * admin role on all branches. The password must be changed at first sign-in. It stays as a
 * break-glass account for when AD is unreachable. Returns true if the account was created.
 */
export async function ensureDefaultAdmin(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialise concurrent app instances starting at the same time.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('app_user_bootstrap'))`);
    const { rows } = await client.query('SELECT count(*)::int AS n FROM app_user');
    if (rows[0].n > 0) {
      await client.query('COMMIT');
      return false;
    }
    await createUser(client, {
      username: DEFAULT_ADMIN.username,
      displayName: 'Administrator',
      authSource: 'local',
      passwordHash: await hashPassword(DEFAULT_ADMIN.password),
      mustChange: true,
      grants: [{ branchId: null, role: 'admin' }],
    });
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
