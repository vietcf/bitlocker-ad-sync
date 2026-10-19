// Local account management until the admin screens exist.
//
//   node src/cli/users.js list
//   node src/cli/users.js create <username> "<Display name>" [email=<address>] <grant>...          (AD account)
//   node src/cli/users.js create-local <username> "<Display name>" [email=<address>] <grant>...    (password stored here)
//   node src/cli/users.js email <username> <address>
//   node src/cli/users.js grant <username> <grant>...
//   node src/cli/users.js revoke <username> <grant>...
//   node src/cli/users.js reset-password <username>
//   node src/cli/users.js unlock <username>
//   node src/cli/users.js disable-2fa <username>   (turn two-step sign-in off for the user)
//   node src/cli/users.js reset-2fa <username>     (forget the authenticator: a new QR code at the next sign-in)
//   node src/cli/users.js disable <username>
//   node src/cli/users.js enable <username>
//
// <grant> = role or role:BRANCHCODE, role in it | lead | admin | auditor.
//   admin          admin on all branches
//   it:HN          IT for branch HN
//   lead:HCM       lead for branch HCM
//   auditor:HN     auditor for branch HN (only admin covers all branches)
//
// AD accounts sign in with their Windows password (username = sAMAccountName); nothing is stored here.
// Local passwords are generated, printed once, and must be changed at next sign-in.
// Every change is written to access_log as admin_change by user "cli".

import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { AuditService } from '../modules/audit/audit.service.js';
import { createUser, resetTotp, setPassword, setTotpRequired } from '../modules/auth/users.repo.js';
import { generatePassword, hashPassword } from '../modules/auth/password.js';

const ROLES = ['it', 'lead', 'admin', 'auditor'];

const config = loadConfig();
const pool = createPool(config);
const audit = new AuditService({ pool });

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

async function parseGrants(specs) {
  const grants = [];
  for (const spec of specs) {
    const [role, code] = spec.split(':');
    if (!ROLES.includes(role)) throw new Error(`Unknown role "${role}" (use ${ROLES.join(', ')})`);
    if (!code) {
      if (role !== 'admin') throw new Error(`"${role}" needs a branch, e.g. ${role}:HN (only admin covers all branches)`);
      grants.push({ branchId: null, role, label: role });
      continue;
    }
    const { rows } = await pool.query('SELECT id FROM branch WHERE upper(code) = upper($1)', [code]);
    if (!rows[0]) throw new Error(`Unknown branch code "${code}"`);
    grants.push({ branchId: rows[0].id, role, label: `${role}:${code.toUpperCase()}` });
  }
  return grants;
}

async function userId(username) {
  const { rows } = await pool.query('SELECT id FROM app_user WHERE lower(username) = lower($1)', [username]);
  if (!rows[0]) throw new Error(`No user "${username}"`);
  return rows[0].id;
}

const record = (username, detail) =>
  audit.log({ userSid: 'cli', userUpn: 'cli', action: 'admin_change', detail: { target: username, ...detail } });

/** Splits "email=<address>" out of the grant arguments. */
function emailArg(specs) {
  const i = specs.findIndex((s) => s.toLowerCase().startsWith('email='));
  if (i < 0) return { email: null, rest: specs };
  const email = specs[i].slice('email='.length).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`Invalid e-mail: ${email}`);
  return { email, rest: specs.filter((_, j) => j !== i) };
}

const commands = {
  async list() {
    const { rows } = await pool.query(`
      SELECT u.username, u.display_name, u.email, u.auth_source, u.is_active, u.must_change_password,
             u.locked_until > now() AS locked, u.last_login_at,
             coalesce(string_agg(g.role || coalesce(':' || b.code, ''), ', ' ORDER BY g.role, b.code), '') AS grants
        FROM app_user u
        LEFT JOIN user_grant g ON g.user_id = u.id
        LEFT JOIN branch b ON b.id = g.branch_id
       GROUP BY u.id ORDER BY u.username`);
    console.table(
      rows.map((r) => ({
        username: r.username,
        name: r.display_name,
        email: r.email ?? '',
        auth: r.auth_source,
        grants: r.grants,
        active: r.is_active,
        locked: !!r.locked,
        mustChangePassword: r.must_change_password,
        lastLogin: r.last_login_at?.toISOString() ?? '',
      })),
    );
  },

  async create(username, displayName, ...specs) {
    if (!username || !displayName) throw new Error('Usage: create <sAMAccountName> "<Display name>" [email=<address>] <grant>...');
    const { email, rest } = emailArg(specs);
    const grants = await parseGrants(rest);
    await createUser(pool, { username, displayName, email, authSource: 'ldap', grants });
    await record(username, { op: 'create_user', email, authSource: 'ldap', grants: grants.map((g) => g.label) });
    console.log(`Created ${username}: signs in with their AD (Windows) password.`);
  },

  async 'create-local'(username, displayName, ...specs) {
    if (!username || !displayName) throw new Error('Usage: create-local <username> "<Display name>" [email=<address>] <grant>...');
    const { email, rest } = emailArg(specs);
    const grants = await parseGrants(rest);
    const password = generatePassword();
    await createUser(pool, { username, displayName, email, authSource: 'local', passwordHash: await hashPassword(password), mustChange: true, grants });
    await record(username, { op: 'create_user', email, authSource: 'local', grants: grants.map((g) => g.label) });
    console.log(`Created ${username}. One-time password (must be changed at first sign-in): ${password}`);
  },

  async email(username, address) {
    if (!username || !address) throw new Error('Usage: email <username> <address>');
    const { email } = emailArg([`email=${address}`]);
    const id = await userId(username);
    await pool.query('UPDATE app_user SET email = $2 WHERE id = $1', [id, email]);
    await record(username, { op: 'set_email', email });
    console.log(`${username}: e-mail set to ${email}.`);
  },

  async grant(username, ...specs) {
    const id = await userId(username);
    const grants = await parseGrants(specs);
    for (const g of grants) {
      await pool.query(
        'INSERT INTO user_grant (user_id, branch_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [id, g.branchId, g.role],
      );
    }
    await record(username, { op: 'grant', grants: grants.map((g) => g.label) });
    console.log(`Granted ${grants.map((g) => g.label).join(', ')} to ${username}`);
  },

  async revoke(username, ...specs) {
    const id = await userId(username);
    const grants = await parseGrants(specs);
    for (const g of grants) {
      await pool.query(
        'DELETE FROM user_grant WHERE user_id = $1 AND branch_id IS NOT DISTINCT FROM $2 AND role = $3',
        [id, g.branchId, g.role],
      );
    }
    await record(username, { op: 'revoke', grants: grants.map((g) => g.label) });
    console.log(`Revoked ${grants.map((g) => g.label).join(', ')} from ${username}`);
  },

  async 'reset-password'(username) {
    const id = await userId(username);
    const { rows } = await pool.query('SELECT auth_source FROM app_user WHERE id = $1', [id]);
    if (rows[0].auth_source !== 'local') throw new Error(`${username} signs in with AD; reset the password in AD.`);
    const password = generatePassword();
    await setPassword(pool, id, await hashPassword(password), { mustChange: true });
    await record(username, { op: 'reset_password' });
    console.log(`New one-time password for ${username} (must be changed at next sign-in): ${password}`);
  },

  async unlock(username) {
    const id = await userId(username);
    await pool.query('UPDATE app_user SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [id]);
    await record(username, { op: 'unlock' });
    console.log(`Unlocked ${username}`);
  },

  async 'disable-2fa'(username) {
    const id = await userId(username);
    await setTotpRequired(pool, id, false);
    await record(username, { op: 'disable_two_factor' });
    console.log(`Two-step sign-in is off for ${username} (the authenticator is forgotten). Turn it on again in Quan tri > Nguoi dung.`);
  },

  async 'reset-2fa'(username) {
    const id = await userId(username);
    await resetTotp(pool, id);
    await record(username, { op: 'reset_two_factor' });
    console.log(`${username}: authenticator forgotten; a new QR code is shown at the next sign-in.`);
  },

  async disable(username) {
    const id = await userId(username);
    await pool.query('UPDATE app_user SET is_active = false WHERE id = $1', [id]);
    await record(username, { op: 'disable' });
    console.log(`Disabled ${username} (signed-in sessions stop working on their next request)`);
  },

  async enable(username) {
    const id = await userId(username);
    await pool.query('UPDATE app_user SET is_active = true WHERE id = $1', [id]);
    await record(username, { op: 'enable' });
    console.log(`Enabled ${username}`);
  },
};

const [command, ...args] = process.argv.slice(2);
try {
  if (!commands[command]) {
    fail(`Commands: ${Object.keys(commands).join(', ')}`);
  } else {
    await commands[command](...args);
  }
} catch (err) {
  fail(err.code === '23505' ? 'That username already exists' : err.message);
} finally {
  await pool.end();
}
