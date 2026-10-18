import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appPool, asOwner, resetDatabase } from './db.js';
import { addUser, apiLogin, buildApp } from './app.js';
import { runMigrations } from '../../src/db/migrate.js';
import { OWNER_URL } from './db.js';
import { createPool } from '../../src/db/pool.js';

let pool;
let app;
let services;

beforeAll(() => {
  pool = appPool();
  ({ app, services } = buildApp(pool));
});
afterAll(() => pool?.end());
beforeEach(async () => {
  await resetDatabase();
  services.settings.invalidate();
  await addUser(pool, 'admin.hq', [{ branchId: null, role: 'admin' }]);
});

describe('hardening', () => {
  it('API: mail server settings without rejectUnauthorized keep certificate checking on', async () => {
    const s = await apiLogin(app, 'admin.hq');
    const body = { enabled: true, host: 'smtp.corp.local', port: 587, security: 'starttls', username: '', from: 'blk@corp.local' };
    expect((await s.agent.put('/api/admin/settings/mail-server').set('X-CSRF-Token', s.csrf).send(body)).status).toBe(200);
    services.settings.invalidate();
    expect((await services.settings.get('mail.smtp')).rejectUnauthorized).toBe(true);
    await s.agent.put('/api/admin/settings/mail-server').set('X-CSRF-Token', s.csrf).send({ ...body, rejectUnauthorized: false });
    services.settings.invalidate();
    expect((await services.settings.get('mail.smtp')).rejectUnauthorized).toBe(false);
  });

  it('accepting a held run keeps its finish time', async () => {
    await asOwner(`INSERT INTO sync_run (mode, dc_name, status, started_at, finished_at, pending)
                   VALUES ('delta', 'dc1', 'quarantined', now() - interval '3 days', now() - interval '3 days', '{"highestUsn": 5}')`);
    const s = await apiLogin(app, 'admin.hq');
    const r = await s.agent.post('/api/admin/sync-runs/1/ack').set('X-CSRF-Token', s.csrf).send({ decision: 'accept' });
    expect(r.status).toBe(200);
    const [row] = await asOwner(`SELECT status, finished_at < now() - interval '2 days' AS old FROM sync_run WHERE id = 1`);
    expect(row).toMatchObject({ status: 'success', old: true });
  });

  it('a run left open by a crashed worker is released after 30 quiet minutes, a live one is not', async () => {
    await asOwner(`INSERT INTO sync_run (mode, dc_name, status, started_at, last_activity_at) VALUES ('full', 'dc1', 'running', now() - interval '3 hours', now() - interval '5 minutes')`);
    await expect(services.ingest.openRun({ mode: 'delta', dcName: 'dc1' })).rejects.toMatchObject({ code: 'run_in_progress' });
    await asOwner(`UPDATE sync_run SET last_activity_at = now() - interval '31 minutes'`);
    const next = await services.ingest.openRun({ mode: 'delta', dcName: 'dc1' });
    expect(next.runId).toBeGreaterThan(1);
    expect((await asOwner('SELECT status, error_code FROM sync_run WHERE id = 1'))[0]).toEqual({ status: 'aborted', error_code: 'orphaned' });
  });

  it('two migration runs at once apply each file once', async () => {
    await Promise.all([runMigrations(OWNER_URL), runMigrations(OWNER_URL)]);
  });

  it('the pool survives a dropped idle connection', async () => {
    const p = createPool({ DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://app_node:dev_app_pw@127.0.0.1:5432/blk_test', DB_SSL: false, DB_POOL_MAX: 2 });
    const c = await p.connect();
    c.release();
    expect(() => p.emit('error', new Error('boom'))).not.toThrow();
    await p.end();
  });
});

describe('audit log dates, chain and bad input', () => {
  it('exporting the log with a date filter keeps the hash chain valid', async () => {
    const s = await apiLogin(app, 'admin.hq');
    const today = new Date().toISOString().slice(0, 10);
    expect((await s.agent.get(`/api/audit?format=csv&from=${today}&to=${today}`)).status).toBe(200);
    expect(await services.audit.verify()).toMatchObject({ ok: true });
  });

  it('"to" includes the whole day, "from" starts at its beginning (app time zone)', async () => {
    const s = await apiLogin(app, 'admin.hq');
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
    expect((await s.agent.get(`/api/audit?from=${today}&to=${today}`)).body.total).toBeGreaterThan(0);
    expect((await s.agent.get('/api/audit?to=2000-01-01')).body.total).toBe(0);
  });

  it('invalid days and NUL characters are a 400, not a 500', async () => {
    const s = await apiLogin(app, 'admin.hq');
    for (const url of ['/api/reports/summary?from=2026-13-45&to=2026-13-46', '/api/computers?from=2026-02-31', '/api/computers?q=ab%00cd']) {
      expect((await s.agent.get(url)).status).toBe(400);
    }
    expect((await (await import('supertest')).default(app).post('/api/auth/login').send({ username: 'a\u0000b', password: 'x' })).status).toBe(400);
  });
});

describe('key of a computer outside the monitored scope', () => {
  it('shows a note next to the key status, only for such computers', async () => {
    await asOwner(`INSERT INTO computer (object_guid, name, distinguished_name, deleted_in_ad_at) VALUES
      ('00000000-0000-0000-0000-0000000000a1', 'OUT-1', 'CN=OUT-1,DC=corp,DC=local', now()),
      ('00000000-0000-0000-0000-0000000000a2', 'IN-1', 'CN=IN-1,DC=corp,DC=local', NULL)`);
    await asOwner(`INSERT INTO recovery_key (computer_id, key_id, recovery_password, ad_created_at) VALUES
      (1, 'aaaaaaaa-1111-0000-0000-000000000001', '111111-111111-111111-111111-111111-111111-111111-111111', now()),
      (2, 'bbbbbbbb-1111-0000-0000-000000000002', '222222-222222-222222-222222-222222-222222-222222-222222', now())`);
    const { webLogin } = await import('./app.js');
    const web = await webLogin(app, 'admin.hq');
    expect((await web.agent.get('/computers/1')).text).toContain('Máy ngoài phạm vi');
    expect((await web.agent.get('/computers/2')).text).not.toContain('Máy ngoài phạm vi');
    expect((await web.agent.get('/?q=aaaaaaaa')).text).toContain('Máy ngoài phạm vi');
  });
});

describe('report period picker', () => {
  it('marks the quick period in use', async () => {
    const { webLogin } = await import('./app.js');
    const web = await webLogin(app, 'admin.hq');
    const on = (html) => [...html.matchAll(/<a [^>]*aria-current="true"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(on((await web.agent.get('/reports')).text)).toEqual(['30 ngày']);
    expect(on((await web.agent.get('/reports?period=all')).text)).toEqual(['Toàn bộ']);
    const day = (n) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(Date.now() - n * 86_400_000));
    expect(on((await web.agent.get(`/reports?from=${day(6)}&to=${day(0)}`)).text)).toEqual(['7 ngày']);
    expect(on((await web.agent.get('/reports?from=2026-01-01&to=2026-01-31')).text)).toEqual([]);
    expect((await web.agent.get('/reports')).text).toContain('data-autosubmit');
  });
});
