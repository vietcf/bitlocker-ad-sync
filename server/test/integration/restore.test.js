import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { HMAC_KEY, OWNER_URL, asOwner, resetDatabase, seedTwoBranches } from './db.js';
import { AuditService } from '../../src/modules/audit/audit.service.js';
import { encryptSecret, secretKey } from '../../src/modules/mail/secret.js';
import { RestoreError, restoreDatabase } from '../../src/modules/backup/restore.js';
import { zipAes } from '../../src/modules/backup/zip-aes.js';
import { addUser } from './app.js';
import { appPool } from './db.js';

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
  zipPath, password: PASSWORD, ownerUrl: OWNER_URL, hmacKey: HMAC_KEY, tz: 'Asia/Ho_Chi_Minh', pgRestore: fakeRestore, ...over,
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
    expect(r.chain.ok).toBe(true);
  });

  it('refuses a database that holds data unless forced', async () => {
    await seedTwoBranches();
    expect(await code(run(makeZip('data.zip')))).toBe('target_not_empty');
    expect(calls).toHaveLength(0);
    await run(makeZip('data.zip'), { force: true });
    expect(calls).toHaveLength(1);
  });

  it('stops on a missing or wrong password, a damaged dump and a keys-only backup, before touching the database', async () => {
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
});

describe('a LOG_HMAC_KEY that is not the one the backup was made with', () => {
  async function seedWithOldKey() {
    const pool = appPool();
    const audit = new AuditService({ pool, hmacKey: HMAC_KEY });
    await audit.log({ userSid: 'user:1', userUpn: 'a', action: 'login', detail: { n: 1 } });
    await audit.log({ userSid: 'user:1', userUpn: 'a', action: 'login', detail: { n: 2 } });
    await pool.end();
  }

  it('keeps the log but reports the chain as broken; --new-log-key re-anchors it', async () => {
    await seedWithOldKey();
    const broken = await run(makeZip('k1.zip'), { hmacKey: OTHER_KEY, force: true });
    expect(broken.chain.ok).toBe(false);
    expect((await asOwner(`SELECT count(*)::int AS n FROM access_log`))[0].n).toBeGreaterThanOrEqual(2);

    const fixed = await run(makeZip('k2.zip'), { hmacKey: OTHER_KEY, force: true, newLogKey: true });
    expect(fixed.chain.ok).toBe(true);
    expect(fixed.reanchored).toBe(true);

    // The audit rows written afterwards chain from the anchor and verify with the new key.
    const pool = appPool();
    const audit = new AuditService({ pool, hmacKey: OTHER_KEY });
    await audit.log({ userSid: 'user:1', userUpn: 'a', action: 'login', detail: { n: 3 } });
    expect((await audit.verify()).ok).toBe(true);
    await pool.end();
  });

  it('lists the encrypted values that can no longer be read, and --reset-2fa clears two-step sign-in', async () => {
    await addUser(appPool(), 'u.totp', []);
    await asOwner(`INSERT INTO app_setting (key, value) VALUES ('test.secret', $1::jsonb)`, [JSON.stringify({ password: encryptSecret(secretKey(HMAC_KEY), 'smtp-pass') })]);
    await asOwner(`UPDATE app_user SET totp_required = true, totp_secret = $1 WHERE username = 'u.totp'`, [encryptSecret(secretKey(HMAC_KEY), 'JBSWY3DPEHPK3PXP')]);

    const r = await run(makeZip('s.zip'), { hmacKey: OTHER_KEY, force: true, reset2fa: true });
    expect(r.secrets.settings).toContain('test.secret');
    expect(r.secrets.totpUsers).toBe(1);
    expect(r.twoFactorOff).toBe(1);
    const [u] = await asOwner(`SELECT totp_required, totp_secret FROM app_user WHERE username = 'u.totp'`);
    expect(u).toEqual({ totp_required: false, totp_secret: null });
  });

  it('with the right key nothing is reported unreadable', async () => {
    await asOwner(`INSERT INTO app_setting (key, value) VALUES ('test.secret', $1::jsonb)`, [JSON.stringify(encryptSecret(secretKey(HMAC_KEY), 'x'))]);
    const r = await run(makeZip('good.zip'), { force: true });
    expect(r.secrets).toEqual({ settings: [], totpUsers: 0 });
  });
});

describe('--reset-admin', () => {
  it('gives the original local admin a new one-time password that must be changed, and unlocks it', async () => {
    await addUser(appPool(), 'root.admin', [{ branchId: null, role: 'admin' }]);
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

it('records the restore in the log', async () => {
  await run(makeZip('log.zip'));
  const [row] = await asOwner(`SELECT detail FROM access_log WHERE action = 'admin_change' ORDER BY id DESC LIMIT 1`);
  expect(row.detail).toMatchObject({ op: 'restore_database', file: 'log.zip' });
});

describe('audit reanchor (audit.js)', () => {
  it('verifies, finds a changed row, and starts the chain again after the last row', async () => {
    const pool = new pg.Pool({ connectionString: OWNER_URL, max: 2 });
    const audit = new AuditService({ pool, hmacKey: HMAC_KEY });
    expect(await audit.reanchor('t')).toEqual({ upToId: null }); // empty log: nothing to anchor
    await audit.log({ userSid: 'user:1', userUpn: 'a', action: 'login', detail: { n: 1 } });
    expect((await audit.verify()).ok).toBe(true);
    const other = new AuditService({ pool, hmacKey: OTHER_KEY });
    expect((await other.verify()).ok).toBe(false);
    const { upToId } = await other.reanchor('cli (new LOG_HMAC_KEY)');
    expect(upToId).toBeGreaterThan(0);
    expect((await other.verify()).ok).toBe(true);
    await other.log({ userSid: 'user:1', userUpn: 'a', action: 'login', detail: { n: 2 } });
    expect((await other.verify()).ok).toBe(true);
    await pool.end();
  });
});
