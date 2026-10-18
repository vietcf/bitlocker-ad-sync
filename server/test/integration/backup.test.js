import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appPool, asOwner, PWD, resetDatabase, seedTwoBranches } from './db.js';
import { addUser, buildApp, webLogin } from './app.js';
import { unzipAes } from '../../src/modules/backup/zip-aes.js';

const PASSWORD = 'mot cum tu rat dai cho sao luu 2026';
let pool;
let app;
let services;
let dir;
let dumps;

beforeAll(() => {
  pool = appPool();
  ({ app, services } = buildApp(pool));
});
afterAll(() => pool?.end());
beforeEach(async () => {
  await resetDatabase();
  services.settings.invalidate();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blk-backup-'));
  dumps = 0;
  // Same service, files in a temporary folder, a fake pg_dump.
  services.backup.config = { ...services.backup.config, BACKUP_DIR: dir, BACKUP_DATABASE_URL: 'postgres://blk_backup:pw@db:5432/blk' };
  services.backup.runPgDump = async () => { dumps += 1; return Buffer.from('PGDMP fake custom dump'); };
  await seedTwoBranches(); // HN-LT-0001 (HN), HCM-LT-0001 (HCM), SRV-0001 (N/A), one key each
  await asOwner(`UPDATE recovery_key SET ad_dn = 'CN=2026-01-02T03:04:05-00:00{AAAAAAAA-0000-0000-0000-000000000001},CN=HN-LT-0001,OU=Computers,OU=HN,DC=corp,DC=local'
                  WHERE key_id = 'aaaaaaaa-0000-0000-0000-000000000001'`);
  await addUser(pool, 'admin.hq', [{ branchId: null, role: 'admin' }]);
});

const admin = { userSid: 'user:1', upn: 'admin.hq', grants: [{ branchId: null, role: 'admin' }] };

describe('backup', () => {
  it('refuses to run without a password: the files hold every recovery key', async () => {
    const r = await services.backup.run({ trigger: 'manual' });
    expect(r.ok).toBe(false);
    expect(r.errors[0].error).toMatch(/password/);
    expect(fs.readdirSync(dir)).toEqual([]);
    await expect(services.backup.setPassword(admin, { password: 'too short', confirm: 'too short' })).rejects.toMatchObject({ code: 'backup_password_short' });
  });

  it('writes AES-256 zips: computers and keys as CSV, and the database dump', async () => {
    await services.backup.setPassword(admin, { password: PASSWORD, confirm: PASSWORD });
    const stored = await asOwner(`SELECT value FROM app_setting WHERE key = 'backup.password'`);
    expect(JSON.stringify(stored[0].value)).not.toContain('sao luu'); // encrypted
    const r = await services.backup.run({ trigger: 'manual' });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.files.map((f) => f.kind)).toEqual(['keys', 'database']);
    expect((await services.backup.listFiles()).every((f) => f.encrypted)).toBe(true);
    expect(r.files[0]).toMatchObject({ computers: 3, keys: 3 });

    const keysZip = fs.readFileSync(path.join(dir, r.files[0].name));
    expect(() => unzipAes(keysZip, 'wrong password!!')).toThrow(/wrong password/);
    const files = unzipAes(keysZip, PASSWORD);
    expect(Object.keys(files).sort()).toEqual(['README.txt', 'computers.csv', 'key_moves.csv', 'manifest.json', 'recovery_keys.csv']);
    const keys = files['recovery_keys.csv'].toString('utf8');
    expect(keys.split('\r\n')[0]).toBe('﻿key_id,key_id_first8,recovery_password,key_dn,volume_guid,status,created_in_ad_utc,first_synced_utc,last_revealed_utc,computer_id,computer_object_guid,computer_name,computer_dn,branch,computer_in_scope');
    expect(keys).toContain(PWD(1));
    expect(keys).toContain('"CN=2026-01-02T03:04:05-00:00{AAAAAAAA-0000-0000-0000-000000000001},CN=HN-LT-0001,OU=Computers,OU=HN,DC=corp,DC=local"');
    expect(keys).toContain('00000000-0000-0000-0000-000000000001'); // computer objectGUID
    const computers = files['computers.csv'].toString('utf8');
    expect(computers).toContain('"CN=SRV-0001,OU=Servers,DC=corp,DC=local"');
    expect(computers).toContain(',N/A,'); // unmapped computers are in the backup too
    const manifest = JSON.parse(files['manifest.json']);
    expect(manifest).toMatchObject({ format: 'bitlocker-keys-backup/1', computers: 3, keys: 3 });

    const db = unzipAes(fs.readFileSync(path.join(dir, r.files[1].name)), PASSWORD);
    expect(db['bitlocker.dump'].toString()).toBe('PGDMP fake custom dump');

    // Never in the log: passwords, keys.
    const log = await asOwner(`SELECT detail FROM access_log WHERE action = 'backup_run'`);
    expect(log[0].detail).toMatchObject({ trigger: 'manual', ok: true });
    expect(JSON.stringify(log)).not.toContain(PWD(1));
    expect(JSON.stringify(log)).not.toContain(PASSWORD);
  });

  it('runs once a day after the set time, keeps the newest N files, alerts on failure', async () => {
    await services.backup.setPassword(admin, { password: PASSWORD, confirm: PASSWORD });
    await services.settings.set('backup.options', { enabled: true, time: '00:00', keys: true, database: false, keep: 2 });
    expect((await services.backup.tick()).ok).toBe(true);
    expect(await services.backup.tick()).toEqual({ skipped: 'done' });
    // Older files of a kind beyond `keep` are removed.
    for (const stamp of ['20200101-010000', '20200102-010000']) fs.writeFileSync(path.join(dir, `bitlocker-keys-${stamp}.zip`), 'x');
    await services.backup.run({ trigger: 'manual' });
    const names = fs.readdirSync(dir).filter((n) => n.startsWith('bitlocker-keys-'));
    expect(names).toHaveLength(2);
    expect(names.some((n) => n.startsWith('bitlocker-keys-20200101'))).toBe(false); // the oldest went first

    await services.settings.set('backup.options', { enabled: true, time: '00:00', keys: false, database: true, keep: 2 });
    services.backup.runPgDump = async () => { throw new Error('pg_dump exited with code 1: connection refused'); };
    const failed = await services.backup.run({ trigger: 'manual' });
    expect(failed.ok).toBe(false);
    expect((await services.alerts.listOpen()).map((a) => a.type)).toContain('backup_failed');
  });

  it('can write plain ZIPs when Admin HQ turns encryption off (no password needed)', async () => {
    await services.settings.set('backup.options', { enabled: true, time: '00:00', keys: true, database: false, keep: 5, encrypt: false });
    const r = await services.backup.run({ trigger: 'manual' });
    expect(r).toMatchObject({ ok: true, encrypted: false });
    const buf = fs.readFileSync(path.join(dir, r.files[0].name));
    expect(buf.readUInt16LE(8)).toBe(8); // Deflate, no AES
    const files = unzipAes(buf);
    expect(files['recovery_keys.csv'].toString()).toContain(PWD(1));
    expect(JSON.parse(files['manifest.json']).encrypted).toBe(false);
    expect((await services.backup.listFiles())[0].encrypted).toBe(false);
    const log = await asOwner(`SELECT detail FROM access_log WHERE action = 'backup_run'`);
    expect(log[0].detail.encrypted).toBe(false);

    // Back on without a password: refused.
    await services.settings.set('backup.options', { enabled: true, time: '00:00', keys: true, database: false, keep: 5, encrypt: true });
    expect((await services.backup.run({ trigger: 'manual' })).ok).toBe(false);
  });

  it('Quan tri > Sao luu: options, password, run now, download (logged), Admin HQ only', async () => {
    const web = await webLogin(app, 'admin.hq');
    const page = await web.agent.get('/admin/backup');
    expect(page.text).toContain('Chưa đặt');
    expect((await web.agent.post('/admin/backup/options').type('form').send({ _csrf: web.csrf, enabled: 'on', time: '02:00', keys: 'on', keep: '7', encrypt: 'on' })).status).toBe(400); // no password yet
    expect((await web.agent.post('/admin/backup/password').type('form').send({ _csrf: web.csrf, password: PASSWORD, confirm: PASSWORD })).status).toBe(302);
    expect((await web.agent.post('/admin/backup/options').type('form').send({ _csrf: web.csrf, enabled: 'on', time: '02:00', keys: 'on', keep: '7', encrypt: 'on' })).status).toBe(302);
    expect((await web.agent.post('/admin/backup/run').type('form').send({ _csrf: web.csrf })).status).toBe(302);
    await services.backup.whenIdle(); // runs in the background
    const [name] = fs.readdirSync(dir);
    expect(name).toMatch(/^bitlocker-keys-\d{8}-\d{6}\.zip$/);
    const dl = await web.agent.get(`/admin/backup/files/${name}`).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(dl.status).toBe(200);
    expect(unzipAes(dl.body, PASSWORD)['recovery_keys.csv'].toString()).toContain(PWD(2));
    expect((await web.agent.get('/admin/backup/files/..%2F..%2Fetc%2Fpasswd')).status).toBe(404);
    expect((await asOwner(`SELECT count(*)::int AS n FROM access_log WHERE action = 'backup_download'`))[0].n).toBe(1);

    await addUser(pool, 'lead.hn', [{ branchId: 1, role: 'lead' }]);
    const lead = await webLogin(app, 'lead.hn');
    expect((await lead.agent.get('/admin/backup')).status).toBe(403);
    expect((await lead.agent.get(`/admin/backup/files/${name}`)).status).toBe(403);
  });
});

describe('backup in the background', () => {
  it('runs one backup at a time and the second request is refused', async () => {
    await services.backup.setPassword(admin, { password: PASSWORD, confirm: PASSWORD });
    let release;
    services.backup.runPgDump = () => new Promise((resolve) => { release = () => resolve(Buffer.from('PGDMP slow')); });
    expect(services.backup.runNow(admin)).toEqual({ started: true });
    expect(() => services.backup.runNow(admin)).toThrow(/already running/);
    expect((await services.backup.status(admin)).running).not.toBeNull();
    await new Promise((r) => setTimeout(r, 50));
    release();
    await services.backup.whenIdle();
    expect((await services.backup.status(admin)).running).toBeNull();
    expect((await services.backup.status(admin)).lastResult.ok).toBe(true);
    expect(fs.readdirSync(dir).filter((n) => n.startsWith('.'))).toEqual([]); // no temporary files left
  });
});

describe('backup password fields', () => {
  it('can be typed only while "encrypt" is ticked', async () => {
    const { webLogin } = await import('./app.js');
    const web = await webLogin(app, 'admin.hq');
    const disabled = (html) => [...html.matchAll(/<(?:input|button)[^>]*data-needs-encrypt([^>]*)>/g)].map((m) => /disabled/.test(m[1]));
    await services.settings.set('backup.options', { encrypt: false });
    services.settings.invalidate();
    expect(disabled((await web.agent.get('/admin/backup')).text)).toEqual([true, true, true]);
    await services.settings.set('backup.options', { encrypt: true });
    services.settings.invalidate();
    expect(disabled((await web.agent.get('/admin/backup')).text)).toEqual([false, false, false]);
  });
});
