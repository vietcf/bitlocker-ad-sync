import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { HMAC_KEY, OWNER_URL, appPool, asOwner, resetDatabase, seedTwoBranches } from './db.js';
import { encryptSecret, secretKey } from '../../src/modules/mail/secret.js';
import { RestoreError, restoreDatabase } from '../../src/modules/backup/restore.js';
import { zipAes } from '../../src/modules/backup/zip-aes.js';
import { addUser } from './app.js';

const OTHER_KEY = Buffer.alloc(32, 7);
const PASSWORD = 'a-long-backup-password-123';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blk-restore-test-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const dumpBytes = Buffer.from('PGDMP fake custom dump');
function makeZip(name, { password = PASSWORD, files, sha = createHash('sha256').update(dumpBytes).digest('hex') } = {}) {
  const manifest = { format: 'bitlocker-db-backup/1', createdAt: '2026-10-18T01:30:00.000Z', files: [{ name: 'bitlocker.dump', bytes: dumpBytes.length, sha256: sha }] };
  const entries = files ?? [{ name: 'bitlocker.dump', data: dumpBytes, compress: false }, { name: 'manifest.json', data: JSON.stringify(manifest) }];
  const file = path.join(dir, name);
  fs.writeFileSync(file, zipAes(entries, password));
  return file;
}

let calls;
const fakeRestore = async (c) => { calls.push(c); };
const run = (zipPath, over = {}) => restoreDatabase({
  zipPath, password: PASSWORD, ownerUrl: OWNER_URL, secret: HMAC_KEY, tz: 'Asia/Ho_Chi_Minh', pgRestore: fakeRestore, ...over,
});
const code = (p) => p.then(() => null, (e) => (e instanceof RestoreError ? e.code : e));

beforeEach(async () => {
  calls = [];
  await resetDatabase();
});

describe('restore of a database backup', () => {
  it('restores into an empty database (a fresh schema counts as empty), then applies migrations and reports', async () => {
    const r = await run(makeZip('ok.zip'));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ clean: true }); // the schema exists, so objects are dropped first
    expect(fs.existsSync(calls[0].file)).toBe(false); // the temporary dump is gone
    expect(r.backupCreatedAt).toBe('2026-10-18T01:30:00.000Z');
    expect(r.secrets).toEqual({ settings: [], totpUsers: 0 });
  });

  it('refuses a database that holds data unless forced', async () => {
    await seedTwoBranches();
    expect(await code(run(makeZip('data.zip')))).toBe('target_not_empty');
    expect(calls).toHaveLength(0);
    await run(makeZip('data.zip'), { force: true });
    expect(calls).toHaveLength(1);
  });

  it('stops on a missing file, a missing or wrong password, a damaged dump and a keys-only backup, before touching the database', async () => {
    expect(await code(run(path.join(dir, 'nope.zip')))).toBe('file_not_found');
    expect(await code(run(makeZip('a.zip'), { password: null }))).toBe('password_required');
    expect(await code(run(makeZip('b.zip'), { password: 'not-the-password-at-all' }))).toBe('wrong_password');
    expect(await code(run(makeZip('c.zip', { sha: 'ab'.repeat(32) })))).toBe('checksum_mismatch');
    expect(await code(run(makeZip('d.zip', { files: [{ name: 'computers.csv', data: 'x' }] })))).toBe('not_db_backup');
    expect(calls).toHaveLength(0);
  });

  it('restores an unencrypted backup without a password', async () => {
    await run(makeZip('plain.zip', { password: null }), { password: null });
    expect(calls).toHaveLength(1);
  });

  it('records the restore in the log', async () => {
    await run(makeZip('log.zip'));
    const [row] = await asOwner(`SELECT detail FROM access_log WHERE action = 'admin_change' ORDER BY id DESC LIMIT 1`);
    expect(row.detail).toMatchObject({ op: 'restore_database', file: 'log.zip' });
  });
});

describe('passwords this server cannot read (the backup came from a server with another secret key)', () => {
  async function seedSecrets() {
    const pool = appPool();
    await addUser(pool, 'u.totp', []);
    await pool.end();
    const old = secretKey(HMAC_KEY);
    await asOwner(`INSERT INTO app_setting (key, value) VALUES ('test.smtp', $1::jsonb), ('test.plain', $2::jsonb)`,
      [JSON.stringify({ host: 'smtp.corp.local', password: encryptSecret(old, 'smtp-pass') }), JSON.stringify({ x: 1 })]);
    await asOwner(`UPDATE app_user SET totp_required = true, totp_secret = $1, totp_enrolled_at = now() WHERE username = 'u.totp'`,
      [encryptSecret(old, 'JBSWY3DPEHPK3PXP')]);
  }

  it('clears them so they are entered again, and keeps the rest of the settings', async () => {
    await seedSecrets();
    const r = await run(makeZip('s.zip'), { secret: OTHER_KEY, force: true });
    expect(r.secrets).toEqual({ settings: ['test.smtp'], totpUsers: 1 });
    const [smtp] = await asOwner(`SELECT value FROM app_setting WHERE key = 'test.smtp'`);
    expect(smtp.value).toEqual({ host: 'smtp.corp.local', password: null });
    const [plain] = await asOwner(`SELECT value FROM app_setting WHERE key = 'test.plain'`);
    expect(plain.value).toEqual({ x: 1 });
    // Two-step sign-in stays required: a new QR code is shown at the next sign-in.
    const [u] = await asOwner(`SELECT totp_required, totp_secret, totp_enrolled_at FROM app_user WHERE username = 'u.totp'`);
    expect(u).toEqual({ totp_required: true, totp_secret: null, totp_enrolled_at: null });
  });

  it('with the same secret key nothing is touched', async () => {
    await seedSecrets();
    const r = await run(makeZip('good.zip'), { force: true });
    expect(r.secrets).toEqual({ settings: [], totpUsers: 0 });
    const [u] = await asOwner(`SELECT totp_secret FROM app_user WHERE username = 'u.totp'`);
    expect(u.totp_secret).not.toBeNull();
  });

  it('--reset-2fa turns two-step sign-in off for everybody', async () => {
    await seedSecrets();
    const r = await run(makeZip('r2.zip'), { secret: OTHER_KEY, force: true, reset2fa: true });
    expect(r.twoFactorOff).toBe(1);
    const [u] = await asOwner(`SELECT totp_required, totp_secret FROM app_user WHERE username = 'u.totp'`);
    expect(u).toEqual({ totp_required: false, totp_secret: null });
  });
});

describe('--reset-admin', () => {
  it('gives the original local admin a new one-time password that must be changed, and unlocks it', async () => {
    const pool = appPool();
    await addUser(pool, 'root.admin', [{ branchId: null, role: 'admin' }]);
    await pool.end();
    await asOwner(`UPDATE app_user SET is_root = true, locked_until = now() + interval '1 hour', failed_attempts = 5 WHERE username = 'root.admin'`);
    const r = await run(makeZip('adm.zip'), { force: true, resetAdmin: true });
    expect(r.adminReset.username).toBe('root.admin');
    expect(r.adminReset.password.length).toBeGreaterThanOrEqual(12);
    const [u] = await asOwner(`SELECT must_change_password, locked_until, failed_attempts FROM app_user WHERE username = 'root.admin'`);
    expect(u).toEqual({ must_change_password: true, locked_until: null, failed_attempts: 0 });
  });

  it('says so when there is no local original admin', async () => {
    expect(await code(run(makeZip('noadm.zip'), { resetAdmin: true }))).toBe('no_local_root');
  });
});
