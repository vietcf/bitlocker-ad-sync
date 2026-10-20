import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appPool, asOwner, resetDatabase, seedTwoBranches } from './db.js';
import { addUser, apiLogin, buildApp, webLogin } from './app.js';

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
  await seedTwoBranches(); // HN-LT-0001 (branch 1, has key), HCM-LT-0001 (branch 2), SRV-0001 (unmapped)
  // 29 more HN machines without keys, and one deleted from AD: 30 live in HN.
  await asOwner(`
    INSERT INTO computer (object_guid, name, distinguished_name, branch_id)
    SELECT gen_random_uuid(), 'HN-PC-' || lpad(i::text, 3, '0'), 'CN=HN-PC-' || i || ',OU=Computers,OU=HN,DC=corp,DC=local', 1
      FROM generate_series(1, 29) AS i;
    INSERT INTO computer (object_guid, name, distinguished_name, branch_id, deleted_in_ad_at)
    VALUES (gen_random_uuid(), 'HN-OLD-001', 'CN=HN-OLD-001,OU=Computers,OU=HN,DC=corp,DC=local', 1, now());`);
  await addUser(pool, 'it.hn', [{ branchId: 1, role: 'it' }]);
  await addUser(pool, 'admin.hq', [{ branchId: null, role: 'admin' }]);
});

describe('computer list (no search term)', () => {
  it('lists only the user scope, 25 per page, without deleted machines', async () => {
    const { agent } = await apiLogin(app, 'it.hn');
    const p1 = await agent.get('/api/computers');
    expect(p1.body).toMatchObject({ total: 30, page: 1, pages: 2, pageSize: 25 });
    expect(p1.body.rows).toHaveLength(25);
    expect(p1.body.rows.every((r) => r.branch_code === 'HN')).toBe(true);
    const p2 = await agent.get('/api/computers').query({ page: 2 });
    expect(p2.body.rows).toHaveLength(5);
    const names = [...p1.body.rows, ...p2.body.rows].map((r) => r.name);
    expect(new Set(names).size).toBe(30);
  });

  it('filters by status and can include machines deleted from AD', async () => {
    const { agent } = await apiLogin(app, 'it.hn');
    expect((await agent.get('/api/computers').query({ status: 'no_key' })).body.total).toBe(29);
    const withKey = (await agent.get('/api/computers').query({ status: 'has_key' })).body.total;
    expect(withKey).toBe(1);
    expect(withKey + 29).toBe((await agent.get('/api/computers').query({ status: 'all' })).body.total);
    expect((await agent.get('/api/computers').query({ includeDeleted: 'on' })).body.total).toBe(31);
  });

  it('filters by the day a computer was recorded here or created in AD, and shows both dates', async () => {
    await asOwner(`
      UPDATE computer SET first_seen_at = '2026-03-10T08:00:00Z', ad_created_at = '2025-01-05T08:00:00Z' WHERE name = 'HN-PC-001';
      UPDATE computer SET first_seen_at = '2026-03-20T20:00:00Z', ad_created_at = '2026-03-19T08:00:00Z' WHERE name = 'HN-PC-002';`);
    const { agent } = await apiLogin(app, 'it.hn');
    const seen = await agent.get('/api/computers').query({ from: '2026-03-01', to: '2026-03-15' });
    expect(seen.body.rows.map((r) => r.name)).toEqual(['HN-PC-001']);
    expect(seen.body.rows[0].first_seen_at).toBeTruthy();
    // 20:00 UTC on the 20th is already the 21st in Asia/Ho_Chi_Minh (APP_TZ).
    const tz = await agent.get('/api/computers').query({ from: '2026-03-21', to: '2026-03-21' });
    expect(tz.body.rows.map((r) => r.name)).toEqual(['HN-PC-002']);
    const ad = await agent.get('/api/computers').query({ dateField: 'ad', to: '2025-12-31' });
    expect(ad.body.rows.map((r) => r.name)).toEqual(['HN-PC-001']);
    expect((await agent.get('/api/computers').query({ from: '20-03-2026' })).status).toBe(400);

    const web = await webLogin(app, 'it.hn');
    const page = await web.agent.get('/').query({ dateField: 'ad', from: '2026-03-01' });
    expect(page.text).toContain('Tạo trên AD');
    expect(page.text).toContain('Ghi nhận');
    expect(page.text).toContain('HN-PC-002');
    expect(page.text).not.toContain('HN-PC-001<');
  });

  it('filters by the last AD logon (recent / not seen for N months / no data), shows it on the page and in the CSV', async () => {
    await asOwner(`UPDATE computer SET last_logon_at = now() - interval '10 days' WHERE name IN ('HN-PC-001', 'HN-PC-002');
                   UPDATE computer SET last_logon_at = now() - interval '5 months' WHERE name = 'HN-PC-003';
                   UPDATE computer SET last_logon_at = now() - interval '30 months' WHERE name = 'HN-PC-004'`);
    const { agent } = await apiLogin(app, 'it.hn');
    const total = async (activity) => (await agent.get('/api/computers').query({ activity })).body.total;
    expect(await total('a1')).toBe(2);
    expect(await total('a6')).toBe(3);
    expect(await total('a24')).toBe(3);
    expect(await total('i3')).toBe(2); // 5 and 30 months ago; machines without data are not "not seen"
    expect(await total('i24')).toBe(1);
    expect(await total('unknown')).toBe(30 - 4); // HN-LT-0001 and the other 25 HN-PC have no data
    expect((await agent.get('/api/computers').query({ activity: 'a5' })).status).toBe(400);

    const web = await webLogin(app, 'it.hn');
    const [{ id }] = await asOwner(`SELECT id FROM computer WHERE name = 'HN-PC-003'`);
    const page = (await web.agent.get(`/computers/${id}`)).text;
    expect(page).toContain('Đăng nhập AD gần nhất');
    expect(page).toContain('Không hoạt động gần đây');
    expect(page).toContain('trong 3 tháng'); // the default threshold, explained in the tooltip
    // the threshold is a setting (Quan tri > Nguong canh bao): 5 months ago counts as recent within 6 months
    await asOwner(`INSERT INTO app_setting (key, value) VALUES ('computer.recent_months', '6')`);
    services.settings.invalidate();
    const page6 = (await web.agent.get(`/computers/${id}`)).text;
    expect(page6).toContain('Hoạt động gần đây');
    expect(page6).toContain('trong 6 tháng');
    const csv = (await web.agent.get('/computers/export.csv').query({ activity: 'a1' })).text;
    expect(csv).toContain('last_logon_utc');
    expect(csv).toContain('HN-PC-001');
    expect(csv).not.toContain('HN-PC-003');
  });

  it('shows the AD objectGUID of every computer and finds a computer by it', async () => {
    const { agent } = await apiLogin(app, 'it.hn');
    const list = (await agent.get('/api/computers')).body.rows;
    expect(list[0].object_guid).toMatch(/^[0-9a-f-]{36}$/);
    const hn = list.find((r) => r.name === 'HN-LT-0001');
    const found = await agent.get('/api/computers').query({ q: hn.object_guid.toUpperCase() });
    expect(found.body).toMatchObject({ kind: 'name', total: 1 });
    expect(found.body.rows[0].name).toBe('HN-LT-0001');
    const web = await webLogin(app, 'it.hn');
    expect((await web.agent.get(`/computers/${hn.id}`)).text).toContain(hn.object_guid);
    // a computer of another branch is not found by its GUID
    const [hcm] = await asOwner(`SELECT object_guid FROM computer WHERE name = 'HCM-LT-0001'`);
    expect((await agent.get('/api/computers').query({ q: hcm.object_guid })).body.total).toBe(0);
  });

  it('lets a multi-branch user filter by branch, and never by a branch outside scope', async () => {
    const admin = await apiLogin(app, 'admin.hq');
    expect((await admin.agent.get('/api/computers')).body.total).toBe(32); // incl. HCM and the unmapped server
    expect((await admin.agent.get('/api/computers').query({ branchId: 2 })).body.total).toBe(1);
    const it = await apiLogin(app, 'it.hn');
    expect((await it.agent.get('/api/computers').query({ branchId: 2 })).body.total).toBe(0);
  });

  it('filters computers in no branch with branchId=na, shown as N/A, for Admin HQ only', async () => {
    const admin = await apiLogin(app, 'admin.hq');
    const na = await admin.agent.get('/api/computers').query({ branchId: 'na' });
    expect(na.body.rows.map((r) => r.name)).toEqual(['SRV-0001']);
    expect(na.body.seesUnmapped).toBe(true);
    const it = await apiLogin(app, 'it.hn');
    expect((await it.agent.get('/api/computers').query({ branchId: 'na' })).body.total).toBe(0);

    const page = await (await webLogin(app, 'admin.hq')).agent.get('/?branchId=na');
    expect(page.text).toContain('<option value="na" selected');
    expect(page.text).toMatch(/SRV-0001[\s\S]*N\/A/);
    expect((await (await webLogin(app, 'it.hn')).agent.get('/')).text).not.toContain('value="na"');
  });

  it('exports the filtered list as CSV, in scope only, without keys, and logs the export', async () => {
    const it = await webLogin(app, 'it.hn');
    const res = await it.agent.get('/computers/export.csv').query({ status: 'no_key' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="?computers-\d{4}-\d{2}-\d{2}\.csv"?/);
    const lines = res.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('name,object_guid,dns_name,branch,distinguished_name,os,device_serial,owner_email,keys,latest_key_utc,ad_created_utc,first_seen_utc,last_logon_utc,in_scope,out_of_scope_since_utc');
    expect(lines).toHaveLength(1 + 29); // HN machines without a key; not HN-LT-0001 (has a key), not HCM
    expect(res.text).not.toContain('HCM-LT-0001');
    expect(res.text).not.toMatch(/\d{6}-\d{6}-\d{6}/); // never a recovery password

    const all = await it.agent.get('/computers/export.csv').query({ includeDeleted: 'on' });
    expect(all.text).toContain('HN-OLD-001');
    expect(all.text).toMatch(/HN-LT-0001,[^\r\n]*,1,/); // key count

    const admin = await apiLogin(app, 'admin.hq');
    const na = await admin.agent.get('/api/computers').query({ format: 'csv', branchId: 'na' });
    expect(na.text).toContain('SRV-0001,00000000-0000-0000-0000-000000000003,,N/A,');

    const logged = await asOwner(`SELECT user_upn, detail FROM access_log WHERE action = 'export_computers' ORDER BY id`);
    expect(logged.map((l) => [l.user_upn, l.detail.rows])).toEqual([['it.hn', 29], ['it.hn', 31], ['admin.hq', 1]]);
  });

  it('hides and refuses the export when it is switched off', async () => {
    await asOwner(`INSERT INTO app_setting (key, value) VALUES ('feature.computer_export', 'false')
                   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    services.settings.invalidate();
    const it = await webLogin(app, 'it.hn');
    expect((await it.agent.get('/')).text).not.toContain('/computers/export.csv');
    expect((await it.agent.get('/computers/export.csv')).status).toBe(403);
  });

  it('does not write a search log entry for browsing', async () => {
    const { agent } = await apiLogin(app, 'it.hn');
    await agent.get('/api/computers');
    expect((await asOwner(`SELECT count(*)::int AS n FROM access_log WHERE action = 'search'`))[0].n).toBe(0);
  });

  it('renders the list with pagination on the search page', async () => {
    const { agent } = await webLogin(app, 'it.hn');
    const page = await agent.get('/');
    expect(page.text).toContain('Máy trong phạm vi của bạn');
    expect(page.text).toContain('Hiển thị 1–25 / 30 máy');
    expect(page.text).toContain('aria-label="Trang sau"');
    const p2 = await agent.get('/?page=2');
    expect(p2.text).toContain('Hiển thị 26–30 / 30 máy');
    expect(p2.text).not.toContain('HCM-LT-0001');
  });
});
