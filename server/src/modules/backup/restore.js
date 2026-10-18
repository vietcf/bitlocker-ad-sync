import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { runMigrations } from '../../db/migrate.js';
import { AuditService } from '../audit/audit.service.js';
import { decryptSecret, secretKey } from '../mail/secret.js';
import { generatePassword, hashPassword } from '../auth/password.js';
import { isEncryptedZip, unzipAes } from './zip-aes.js';

/** Largest database backup restored in memory; bigger ones: unzip with 7-Zip and run pg_restore by hand. */
export const MAX_RESTORE_BYTES = 1.5 * 1024 ** 3;

/** Tables whose rows decide whether the target database already holds data. */
const DATA_TABLES = ['computer', 'recovery_key', 'access_log', 'branch', 'app_user'];

export class RestoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** libpq environment for a connection URL (the password never appears in the process list). */
export function pgEnvFromUrl(url) {
  const u = new URL(url);
  const env = {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, '')),
  };
  const sslmode = u.searchParams.get('sslmode');
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}

/** Runs pg_restore for a dump file. clean: drop the objects first (the schema is already there). */
export function runPgRestore({ file, url, clean, bin = process.env.PG_RESTORE_PATH || 'pg_restore' }) {
  const env = pgEnvFromUrl(url);
  // pg_restore needs -d to write into a database (it does not read PGDATABASE for that).
  const args = ['--no-owner', '--exit-on-error', '--no-password', '--dbname', env.PGDATABASE, ...(clean ? ['--clean', '--if-exists'] : []), file];
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    child.on('error', (e) => reject(new RestoreError('pg_restore_missing',
      e.code === 'ENOENT' ? `pg_restore not found (${bin}). Install the PostgreSQL 17 client or set PG_RESTORE_PATH.` : e.message)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new RestoreError('pg_restore_failed', `pg_restore exited with code ${code}: ${err.trim().slice(-1500)}`))));
  });
}

/** { tables, rows }: how much the target already holds. */
async function inspectTarget(client) {
  const { rows: t } = await client.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
  let rows = 0;
  for (const name of DATA_TABLES) {
    const exists = await client.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${name}`]);
    if (exists.rows[0].ok) rows += (await client.query(`SELECT count(*)::int AS n FROM ${name}`)).rows[0].n;
  }
  return { tables: t[0].n, rows };
}

/** Reads the backup zip: { dump: Buffer, manifest }. Checks the password and the SHA-256 in the manifest. */
export function readBackup(zipPath, password) {
  const size = fs.statSync(zipPath).size;
  if (size > MAX_RESTORE_BYTES) {
    throw new RestoreError('too_big', 'The backup is too large to restore in one step: unzip it with 7-Zip and run pg_restore by hand (README 6.8).');
  }
  const buf = fs.readFileSync(zipPath);
  if (isEncryptedZip(buf) && !password) throw new RestoreError('password_required', 'This backup is encrypted: a password is needed.');
  let files;
  try {
    files = unzipAes(buf, password || null);
  } catch (e) {
    throw new RestoreError('wrong_password', e.message === 'wrong password' ? 'Wrong password for this backup.' : `The backup is damaged: ${e.message}`);
  }
  if (!files['bitlocker.dump']) {
    throw new RestoreError('not_db_backup', 'This is not a database backup (no bitlocker.dump). Use bitlocker-db-*.zip.');
  }
  const manifest = files['manifest.json'] ? JSON.parse(files['manifest.json'].toString('utf8')) : null;
  const expected = manifest?.files?.find((f) => f.name === 'bitlocker.dump')?.sha256;
  const actual = createHash('sha256').update(files['bitlocker.dump']).digest('hex');
  if (expected && expected !== actual) throw new RestoreError('checksum_mismatch', 'bitlocker.dump does not match the SHA-256 in manifest.json: the backup is damaged.');
  return { dump: files['bitlocker.dump'], manifest };
}

/** Counts of encrypted values (SMTP / backup passwords, 2-step secrets) this LOG_HMAC_KEY cannot read. */
async function checkSecrets(pool, hmacKey) {
  const key = secretKey(hmacKey);
  const unreadable = (value) => { try { decryptSecret(key, value); return false; } catch { return true; } };
  const settings = [];
  const walk = (name, v) => {
    if (typeof v === 'string' && v.startsWith('enc:v1:')) { if (unreadable(v)) settings.push(name); } else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(name, x);
  };
  for (const r of (await pool.query('SELECT key, value FROM app_setting')).rows) walk(r.key, r.value);
  let totp = 0;
  for (const r of (await pool.query('SELECT totp_secret FROM app_user WHERE totp_secret IS NOT NULL')).rows) if (unreadable(r.totp_secret)) totp += 1;
  return { settings: [...new Set(settings)], totpUsers: totp };
}

/**
 * Restores a database backup (bitlocker-db-*.zip) into the database of ownerUrl (blk_owner), runs the migrations,
 * and reports what still needs attention. Empty target (a fresh schema is fine) restores directly; a target that
 * holds data needs force. newLogKey: LOG_HMAC_KEY is not the one the backup was made with, so the log chain is
 * re-anchored here. reset2fa: turn two-step sign-in off for everybody. resetAdmin: new one-time password for the
 * original admin.
 */
export async function restoreDatabase({
  zipPath, password = null, ownerUrl, hmacKey, tz, force = false, newLogKey = false, reset2fa = false, resetAdmin = false,
  pgRestore = runPgRestore, say = () => {},
}) {
  say('Reading the backup...');
  if (!fs.existsSync(zipPath)) throw new RestoreError('file_not_found', `Backup file not found: ${zipPath}`);
  const { dump, manifest } = readBackup(zipPath, password);

  const probe = new pg.Client({ connectionString: ownerUrl });
  await probe.connect();
  let target;
  try {
    target = await inspectTarget(probe);
  } finally {
    await probe.end();
  }
  if (target.rows > 0 && !force) {
    throw new RestoreError('target_not_empty', `The database already holds data (${target.rows} rows in computers, keys, users, log...). Restoring replaces it: run again with --force.`);
  }

  say(`Restoring the database${target.tables ? ' (replacing the empty schema)' : ''}...`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '.blk-restore-'));
  try {
    const file = path.join(dir, 'bitlocker.dump');
    fs.writeFileSync(file, dump, { mode: 0o600 });
    await pgRestore({ file, url: ownerUrl, clean: target.tables > 0 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  say('Applying newer migrations...');
  const migrated = await runMigrations(ownerUrl);

  const pool = new pg.Pool({ connectionString: ownerUrl, max: 2 });
  try {
    const audit = new AuditService({ pool, hmacKey, tz });
    let chain = await audit.verify();
    let reanchored = false;
    if (!chain.ok && newLogKey) {
      await audit.reanchor('restore (new LOG_HMAC_KEY)');
      chain = await audit.verify();
      reanchored = true;
    }
    const secrets = await checkSecrets(pool, hmacKey);

    let twoFactorOff = 0;
    if (reset2fa) {
      twoFactorOff = (await pool.query(
        `UPDATE app_user SET totp_required = false, totp_secret = NULL, totp_enrolled_at = NULL, totp_last_step = NULL
          WHERE totp_required OR totp_secret IS NOT NULL`,
      )).rowCount;
    }

    let adminReset = null;
    if (resetAdmin) {
      const admin = (await pool.query(`SELECT id, username FROM app_user WHERE is_root AND auth_source = 'local' LIMIT 1`)).rows[0];
      if (!admin) throw new RestoreError('no_local_root', 'There is no local original admin to reset.');
      const oneTime = generatePassword();
      await pool.query(
        `UPDATE app_user SET password_hash = $2, must_change_password = true, password_changed_at = now(),
                failed_attempts = 0, locked_until = NULL, is_active = true WHERE id = $1`,
        [admin.id, await hashPassword(oneTime)],
      );
      adminReset = { username: admin.username, password: oneTime };
    }

    const count = async (t) => (await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
    const counts = { computers: await count('computer'), keys: await count('recovery_key'), users: await count('app_user') };
    await audit.log({
      userSid: 'cli', userUpn: 'cli', action: 'admin_change',
      detail: { op: 'restore_database', file: path.basename(zipPath), backupCreatedAt: manifest?.createdAt ?? null, reset2fa, resetAdmin, newLogKey: reanchored },
    });
    return { backupCreatedAt: manifest?.createdAt ?? null, counts, migrated, chain, reanchored, secrets, twoFactorOff, adminReset };
  } finally {
    await pool.end();
  }
}
