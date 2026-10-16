import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appPool, asOwner, resetDatabase, seedTwoBranches } from './db.js';
import { addUser, apiLogin, buildApp, webLogin } from './app.js';
import { lineChart, niceRange, niceScale } from '../../src/web/charts.js';

const KEY_HN = 'aaaaaaaa-0000-0000-0000-000000000001';

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
  await seedTwoBranches();
  await addUser(pool, 'it.hn', [{ branchId: 1, role: 'it' }]);
  await addUser(pool, 'auditor', [{ branchId: 1, role: 'auditor' }, { branchId: 2, role: 'auditor' }]);
  await addUser(pool, 'admin.hq', [{ branchId: null, role: 'admin' }]);
  await services.settings.set('reveal.working_hours', { tz: 'UTC', days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '24:00' });
});

describe('dashboard', () => {
  it('shows IT only their own branch inventory, without reveal statistics', async () => {
    const { agent } = await apiLogin(app, 'it.hn');
    const res = await agent.get('/api/dashboard');
    expect(res.body.totals).toMatchObject({ computers: 1, noKey: 0, coveragePct: 100 });
    expect(res.body.branches.map((b) => b.branch_code)).toEqual(['HN']);
    expect(res.body.activity).toBeNull();
    expect(res.body.sync).toBeNull();
  });

  it('counts reveals per day and per branch for roles that read reports', async () => {
    const it = await apiLogin(app, 'it.hn');
    await it.agent.post(`/api/keys/${KEY_HN}/reveal`).set('X-CSRF-Token', it.csrf).send({ reason: 'user_locked_out' });

    const { agent } = await apiLogin(app, 'auditor');
    const res = await agent.get('/api/dashboard');
    expect(res.body.activity.daily).toHaveLength(14);
    expect(res.body.activity).toMatchObject({ today: 1, reveals7d: 1 });
    expect(res.body.activity.top[0]).toMatchObject({ user_upn: 'it.hn', reveals: 1 });
    expect(res.body.branches.find((b) => b.branch_code === 'HN').reveals_30d).toBe(1);
    // Its two branches; the unmapped server (N/A) is for Admin HQ only.
    expect(res.body.totals.computers).toBe(2);
  });

  it('adds sync health for Admin HQ and renders the page', async () => {
    const { agent } = await webLogin(app, 'admin.hq');
    const page = await agent.get('/dashboard');
    expect(page.status).toBe(200);
    expect(page.text).toContain('Tổng quan');
    expect(page.text).toContain('<svg');
    expect(page.text).toContain('Số máy trên hệ thống');
    expect(page.text).toContain('Số key trên hệ thống');
    expect(page.text).not.toContain('Xem dạng bảng');
    const api = await apiLogin(app, 'admin.hq');
    expect((await api.agent.get('/api/dashboard')).body.sync).toMatchObject({ lastSuccessAt: null, openAlerts: 0 });
  });

  it('is the landing page for roles without key access', async () => {
    const { agent } = await webLogin(app, 'auditor');
    expect((await agent.get('/')).headers.location).toBe('/dashboard');
  });
});

describe('per-branch statistics', () => {
  it('counts computers with and without a key and keys per branch, top 10 first, all on request', async () => {
    const { agent } = await apiLogin(app, 'it.hn');
    expect((await agent.get('/api/dashboard')).body.branches[0])
      .toMatchObject({ branch_code: 'HN', computers: 1, with_key: 1, no_key: 0, keys: 1 });

    // 12 more branches, branch Bn with n computers and no keys.
    await asOwner(`
      INSERT INTO branch (code, name) SELECT 'B' || lpad(i::text, 2, '0'), 'Branch ' || i FROM generate_series(1, 12) AS i;
      INSERT INTO computer (object_guid, name, distinguished_name, branch_id)
      SELECT gen_random_uuid(), b.code || '-' || g, 'CN=' || b.code || '-' || g || ',DC=corp,DC=local', b.id
        FROM branch b CROSS JOIN LATERAL generate_series(1, substr(b.code, 2)::int) AS g WHERE b.code LIKE 'B%';`);
    const admin = await apiLogin(app, 'admin.hq');
    const body = (await admin.agent.get('/api/dashboard')).body;
    expect(body.branches[0]).toMatchObject({ branch_code: 'B12', computers: 12, with_key: 0, no_key: 12, keys: 0 });
    expect(body.totals.keys).toBe(body.branches.reduce((n, b) => n + b.keys, 0));
    expect(body.totals.keys).toBeGreaterThan(0);

    const web = await webLogin(app, 'admin.hq');
    const top = await web.agent.get('/dashboard');
    expect(top.text).toContain('Xem tất cả 15 chi nhánh');
    expect(top.text).toContain('>B03<');
    expect(top.text).not.toContain('>B02<');
    const all = await web.agent.get('/dashboard').query({ branches: 'all' });
    expect(all.text).toContain('>B02<');
    expect(all.text).toContain('Thu gọn');
  });
});

describe('computers and keys per day', () => {
  it('counts computers from first seen until no longer in AD, and keys from first recorded, in scope', async () => {
    await asOwner(`
      UPDATE computer SET first_seen_at = now() - interval '10 days';
      UPDATE recovery_key SET first_synced_at = now() - interval '5 days';
      INSERT INTO computer (object_guid, name, distinguished_name, branch_id, first_seen_at, deleted_in_ad_at)
      VALUES (gen_random_uuid(), 'HN-OLD', 'CN=HN-OLD,OU=Computers,OU=HN,DC=corp,DC=local', 1, now() - interval '20 days', now() - interval '3 days');`);
    const { agent } = await apiLogin(app, 'it.hn');
    const days = (await agent.get('/api/dashboard')).body.inventoryDaily;
    expect(days).toHaveLength(30);
    const at = (back) => days.at(-1 - back);
    expect(at(15)).toMatchObject({ computers: 1, keys: 0 }); // only HN-OLD
    expect(at(7)).toMatchObject({ computers: 2, keys: 0 });
    expect(at(4)).toMatchObject({ computers: 2, keys: 1 });
    expect(at(0)).toMatchObject({ computers: 1, keys: 1 }); // HN-OLD left AD
    const admin = await apiLogin(app, 'admin.hq');
    expect((await admin.agent.get('/api/dashboard')).body.inventoryDaily.at(-1).computers).toBe(3);
  });
});

describe('data freshness', () => {
  it('tells every role when data was last synced, and flags it as stale past the watchdog threshold', async () => {
    const { agent } = await apiLogin(app, 'it.hn');
    expect((await agent.get('/api/dashboard')).body.freshness).toMatchObject({ lastSyncAt: null, stale: true });

    await asOwner(`INSERT INTO sync_run (started_at, finished_at, mode, dc_name, status)
      VALUES (now() - interval '11 minutes', now() - interval '10 minutes', 'delta', 'DC1', 'success')`);
    const fresh = (await agent.get('/api/dashboard')).body.freshness;
    expect(fresh).toMatchObject({ ageMinutes: 10, maxMinutes: 60, stale: false });

    await services.settings.set('watchdog.delta_max_minutes', 5);
    services.settings.invalidate();
    expect((await agent.get('/api/dashboard')).body.freshness.stale).toBe(true);
    const web = await webLogin(app, 'it.hn');
    expect((await web.agent.get('/dashboard')).text).toContain('Dữ liệu cập nhật lần cuối');
  });
});

describe('line chart geometry', () => {
  it('picks clean tick steps', () => {
    expect(niceScale(0)).toEqual({ top: 4, step: 1 });
    expect(niceScale(7)).toEqual({ top: 8, step: 2 });
    expect(niceScale(130)).toEqual({ top: 150, step: 50 });
  });

  it('fits a non-zero axis around large totals, never below 0', () => {
    expect(niceRange(4980, 5030)).toEqual({ lo: 4980, hi: 5040, step: 20 });
    expect(niceRange(3, 3)).toEqual({ lo: 2, hi: 4, step: 1 });
    expect(niceRange(0, 0).lo).toBe(0);
  });

  it('draws one path through every day and labels the last day', () => {
    const pts = Array.from({ length: 30 }, (_, i) => ({ label: `d${i}`, value: 100 + i, tip: `${100 + i} máy` }));
    const c = lineChart(pts, { zeroBased: false, width: 600 });
    expect(c.points).toHaveLength(30);
    expect(c.line.match(/[ML]/g)).toHaveLength(30);
    expect(c.labels.at(-1).text).toBe('d29');
    expect(c.last.cy).toBeLessThan(c.points[0].cy); // rising
    expect(c.points.every((p) => p.tipBox.x >= c.plot.left && p.tipBox.x + p.tipBox.w <= c.plot.right)).toBe(true);
  });
});

describe('branch isolation across the pages', () => {
  it('a lead of HN sees only HN on Tong quan, Tim may, Nhat ky and Bao cao; Admin HQ sees all', async () => {
    await addUser(pool, 'lead.hn', [{ branchId: 1, role: 'lead' }]);
    const hcm = await apiLogin(app, 'admin.hq');
    // Activity in both branches: a reveal in HCM by Admin HQ.
    await hcm.agent.post('/api/keys/bbbbbbbb-0000-0000-0000-000000000002/reveal').set('X-CSRF-Token', hcm.csrf).send({ reason: 'hardware_change' });

    const { agent } = await apiLogin(app, 'lead.hn');
    const dash = (await agent.get('/api/dashboard')).body;
    expect(dash.branches.map((b) => b.branch_code)).toEqual(['HN']);
    expect(dash.totals.computers).toBe(1);
    expect(dash.activity.reveals7d).toBe(0); // the HCM reveal is not counted

    expect((await agent.get('/api/computers').query({ q: 'HCM-LT-0001' })).body.rows).toEqual([]);
    expect((await agent.get('/api/computers').query({ q: 'bbbb' })).body.rows).toEqual([]); // HCM Key ID
    expect((await agent.get('/api/computers')).body.rows.map((c) => c.name)).toEqual(['HN-LT-0001']);

    const log = (await agent.get('/api/audit')).body.rows;
    expect(log.every((l) => l.branch_code === 'HN')).toBe(true);
    expect(log.some((l) => l.action === 'reveal')).toBe(false);

    const report = (await agent.get('/api/reports/summary')).body;
    expect(report.branches.map((b) => b.branch_code)).toEqual(['HN']);
    expect(report.totals.reveals).toBe(0);
    expect(report.revealUsers).toEqual([]);

    const all = (await hcm.agent.get('/api/dashboard')).body;
    expect(all.totals.computers).toBe(3); // Admin HQ: every branch and N/A
  });
});
