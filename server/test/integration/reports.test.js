import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appPool, asOwner, resetDatabase, seedTwoBranches } from './db.js';
import { addUser, apiLogin, buildApp, webLogin } from './app.js';

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
  services.settings.invalidate();
  await seedTwoBranches(); // HN-LT-0001 (HN, 1 key), HCM-LT-0001 (HCM, 1 key), SRV-0001 (N/A, 1 key)
  await asOwner(`
    UPDATE computer SET first_seen_at = now() - interval '100 days';
    UPDATE recovery_key SET first_synced_at = now() - interval '100 days';
    INSERT INTO computer (object_guid, name, distinguished_name, branch_id, first_seen_at)
    VALUES (gen_random_uuid(), 'HN-PC-NEW', 'CN=HN-PC-NEW,OU=Computers,OU=HN,DC=corp,DC=local', 1, now() - interval '2 days'),
           (gen_random_uuid(), 'HN-PC-GONE', 'CN=HN-PC-GONE,OU=Computers,OU=HN,DC=corp,DC=local', 1, now() - interval '200 days');
    UPDATE computer SET deleted_in_ad_at = now() - interval '1 day' WHERE name = 'HN-PC-GONE';`);
  await addUser(pool, 'it.hn', [{ branchId: 1, role: 'it' }]);
  await addUser(pool, 'lead.hn', [{ branchId: 1, role: 'lead' }]);
  await addUser(pool, 'auditor', [{ branchId: 1, role: 'auditor' }, { branchId: 2, role: 'auditor' }]);
});

/** Text of each file in a zip (enough for the workbook this app writes). */
function unzip(buf) {
  const files = {};
  for (let o = 0; buf.readUInt32LE(o) === 0x04034b50;) {
    const size = buf.readUInt32LE(o + 18);
    const nameLen = buf.readUInt16LE(o + 26);
    const extra = buf.readUInt16LE(o + 28);
    const name = buf.toString('utf8', o + 30, o + 30 + nameLen);
    const start = o + 30 + nameLen + extra;
    files[name] = inflateRawSync(buf.subarray(start, start + size)).toString('utf8');
    o = start + size;
  }
  return files;
}

describe('report', () => {
  it('gives totals and per-branch inventory with the changes of the period', async () => {
    const { agent } = await apiLogin(app, 'auditor');
    const res = await agent.get('/api/reports/summary');
    expect(res.status).toBe(200);
    expect(res.body.period.days).toBe(30);
    // An auditor of HN and HCM: the unmapped server (N/A) is for Admin HQ only.
    expect(res.body.totals).toMatchObject({ branches: 2, computers: 3, withKey: 2, noKey: 1, keys: 2, newComputers: 1, newKeys: 0, leftAd: 1 });
    const hn = res.body.branches.find((b) => b.branch_code === 'HN');
    expect(hn).toMatchObject({ computers: 2, with_key: 1, no_key: 1, keys: 1, new_computers: 1, left_ad: 1, coverage: 0.5 });
    expect(res.body.branches.find((b) => b.branch_code === null)).toBeUndefined(); // N/A: Admin HQ only
    expect(res.body.noKey.map((c) => c.name)).toEqual(['HN-PC-NEW']);
  });

  it('counts reveals per branch and per user, and keeps a lead to their own branch', async () => {
    const it = await apiLogin(app, 'it.hn');
    for (let i = 0; i < 2; i += 1) {
      await it.agent.post(`/api/keys/${KEY_HN}/reveal`).set('X-CSRF-Token', it.csrf).send({ reason: 'hardware_change' });
    }
    const lead = await apiLogin(app, 'lead.hn');
    const body = (await lead.agent.get('/api/reports/summary')).body;
    expect(body.branches.map((b) => b.branch_code)).toEqual(['HN']);
    expect(body.branches[0]).toMatchObject({ reveals: 2, reveal_users: 1, reveal_computers: 1, top_reason: 'hardware_change' });
    expect(body.revealUsers).toEqual([expect.objectContaining({ branch_code: 'HN', user_upn: 'it.hn', reveals: 2, computers: 1 })]);
    // A branch outside the scope gives an empty report, not an error.
    expect((await lead.agent.get('/api/reports/summary').query({ branchId: 2 })).body.totals.computers).toBe(0);
    // Reveals outside the period are not counted.
    const old = await lead.agent.get('/api/reports/summary').query({ from: '2020-01-01', to: '2020-01-31' });
    expect(old.body.totals.reveals).toBe(0);
  });

  it('reports all time with period=all (from the first day with data, dates ignored)', async () => {
    const { agent } = await apiLogin(app, 'auditor');
    const res = await agent.get('/api/reports/summary').query({ period: 'all', from: '2020-01-01', to: '2026-01-01' });
    expect(res.status).toBe(200);
    expect(res.body.period.all).toBe(true);
    expect(res.body.period.days).toBeGreaterThanOrEqual(201); // HN-PC-GONE first seen 200 days ago
    expect(res.body.totals).toMatchObject({ computers: 3, newKeys: 2, leftAd: 1 });
    expect(res.body.totals.newComputers).toBeGreaterThanOrEqual(4);
    expect((await agent.get('/reports/export.xlsx').query({ period: 'all' })).status).toBe(200);
    expect((await agent.get('/api/reports/summary').query({ period: 'year' })).status).toBe(400);
  });

  it('validates the period and is closed to IT', async () => {
    const { agent } = await apiLogin(app, 'auditor');
    expect((await agent.get('/api/reports/summary').query({ from: '2026-02-01', to: '2026-01-01' })).status).toBe(400);
    expect((await agent.get('/api/reports/summary').query({ from: '2020-01-01', to: '2026-01-01' })).status).toBe(400);
    expect((await agent.get('/api/reports/summary').query({ from: '01/01/2026' })).status).toBe(400);
    const it = await apiLogin(app, 'it.hn');
    expect((await it.agent.get('/api/reports/summary')).status).toBe(403);
  });

  it('exports an Excel workbook with six sheets, no key values, and logs the export', async () => {
    await asOwner(`INSERT INTO computer (object_guid, name, distinguished_name, branch_id, deleted_in_ad_at) VALUES
      ('00000000-0000-0000-0000-0000000000f1', 'HN-OLD-0009', 'CN=HN-OLD-0009,OU=Computers,OU=HN,DC=corp,DC=local', 1, now())`);
    const { agent } = await webLogin(app, 'auditor');
    const res = await agent.get('/reports/export.xlsx').buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheetml/);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    const files = unzip(res.body);
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['[Content_Types].xml', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet5.xml']));
    expect(files['xl/workbook.xml']).toContain('name="Tổng quan"');
    expect(files['xl/workbook.xml']).toContain('name="Xem key theo CN"');
    expect(files['xl/worksheets/sheet2.xml']).toContain('Ha Noi');
    // All branches: the no-key sheet is a summary per branch, no computer listed.
    expect(files['xl/worksheets/sheet5.xml']).toContain('Lâu hơn 7 ngày');
    expect(files['xl/worksheets/sheet5.xml']).not.toContain('HN-PC-NEW');
    const one = await agent.get('/reports/export.xlsx').query({ branchId: 1 }).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    // All branches: no sheet of computers with keys either (only the overview).
    expect(files['xl/workbook.xml']).not.toContain('Máy đã có key');
    // One branch: the computers that have keys (with their key count) come before the computers without a key.
    const oneFiles = unzip(one.body);
    const names = [...oneFiles['xl/workbook.xml'].matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
    expect(names).toEqual(['Tổng quan', 'Theo chi nhánh', 'Xem key theo CN', 'Người xem key', 'Máy đã có key', 'Máy chưa có key', 'Máy rời phạm vi']);
    // The computers that left the monitored scope in the period: this branch only, with the key count.
    expect(oneFiles['xl/worksheets/sheet7.xml']).toContain('HN-OLD-0009');
    expect(oneFiles['xl/worksheets/sheet7.xml']).not.toContain('HN-LT-0001');
    expect(files['xl/worksheets/sheet6.xml']).toContain('HN-OLD-0009'); // all branches: also listed
    expect(oneFiles['xl/worksheets/sheet5.xml']).toContain('HN-LT-0001'); // has a key
    expect(oneFiles['xl/worksheets/sheet5.xml']).not.toContain('HN-PC-NEW'); // none
    expect(oneFiles['xl/worksheets/sheet5.xml']).not.toContain('HCM-LT-0001'); // another branch
    expect(oneFiles['xl/worksheets/sheet6.xml']).toContain('HN-PC-NEW'); // the list without a key
    expect(oneFiles['xl/worksheets/sheet6.xml']).not.toContain('HN-LT-0001');
    expect(Object.values(oneFiles).join('')).not.toContain('aaaaaaaa-0000-0000-0000-000000000001'); // not even a Key ID
    const all = Object.values(files).join('');
    expect(all).not.toMatch(/\d{6}-\d{6}-\d{6}/); // no recovery password
    const log = await asOwner(`SELECT user_upn, detail FROM access_log WHERE action = 'export_report'`);
    expect(log).toHaveLength(2);
    expect(log[0].detail).toMatchObject({ branchId: null });
  });

  it('counts computers by last AD logon per branch, with links to the list filters', async () => {
    await asOwner(`UPDATE computer SET last_logon_at = now() - interval '10 days' WHERE name = 'HN-LT-0001';
                   UPDATE computer SET last_logon_at = now() - interval '8 months' WHERE name = 'HCM-LT-0001'`); // HN-PC-NEW: no data
    const { agent } = await apiLogin(app, 'auditor');
    const res = await agent.get('/api/reports/summary');
    expect(res.body.totals).toMatchObject({ active: 1, inactive: 1, noLogon: 1 });
    expect(res.body.branches.find((b) => b.branch_code === 'HN')).toMatchObject({ active: 1, inactive: 0, no_logon: 1 });
    expect(res.body.activityMonths).toBe(3);
    const page = (await (await webLogin(app, 'auditor')).agent.get('/reports')).text;
    expect(page).toContain('Hoạt động của máy');
    expect(page).toContain('activity=a3&noLogon=exclude');
    expect(page).toContain('noLogon=only');
  });

  it('filters the computers counted by last AD logon, on the page and in the Excel file', async () => {
    await asOwner(`UPDATE computer SET last_logon_at = now() - interval '10 days' WHERE name = 'HN-LT-0001';
                   UPDATE computer SET last_logon_at = now() - interval '8 months' WHERE name = 'HCM-LT-0001'`); // HN-PC-NEW: no data
    const { agent } = await apiLogin(app, 'auditor');
    const sum = async (query) => (await agent.get('/api/reports/summary').query(query)).body;
    expect((await sum({})).totals.computers).toBe(3); // no filter: everything
    expect((await sum({ activity: 'a3' })).totals).toMatchObject({ computers: 1, active: 1, noLogon: 0 });
    expect((await sum({ activity: 'i3' })).totals).toMatchObject({ computers: 1, inactive: 1 });
    expect((await sum({ activity: 'i3', noLogon: 'include' })).totals.computers).toBe(2); // old OR no data
    expect((await sum({ noLogon: 'only' })).totals).toMatchObject({ computers: 1, noLogon: 1 });
    expect((await sum({ noLogon: 'only' })).noKey.map((c) => c.name)).toEqual(['HN-PC-NEW']);

    const web = await webLogin(app, 'auditor');
    const page = (await web.agent.get('/reports').query({ activity: 'a3' })).text;
    expect(page).toContain('name="activity"');
    expect(page).toContain('Đăng nhập AD gần nhất');
    expect(page).toContain('Máy chưa có dữ liệu');
    expect(page).toContain('Đang lọc theo');
    expect(page).toContain('activity=a3'); // the Excel link keeps the filter
    const xlsx = await web.agent.get('/reports/export.xlsx').query({ activity: 'i3', noLogon: 'include' }).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(xlsx.status).toBe(200);
    expect(Object.values(unzip(xlsx.body)).join('')).toContain('quá 3 tháng chưa thấy, gồm cả máy chưa có dữ liệu');
  });

  it('counts new computers and keys by the day recorded here (default) or by the day created in AD', async () => {
    // HN-PC-NEW was first recorded 2 days ago; make it created in AD long ago, and one old computer created in AD yesterday
    await asOwner(`UPDATE computer SET ad_created_at = now() - interval '300 days' WHERE name = 'HN-PC-NEW';
                   UPDATE computer SET ad_created_at = now() - interval '1 day' WHERE name = 'HCM-LT-0001'`);
    const { agent } = await apiLogin(app, 'auditor');
    const seen = (await agent.get('/api/reports/summary')).body;
    expect(seen.dateField).toBe('seen');
    expect(seen.totals.newComputers).toBe(1); // HN-PC-NEW (recorded 2 days ago)
    const ad = (await agent.get('/api/reports/summary').query({ dateField: 'ad' })).body;
    expect(ad.dateField).toBe('ad');
    expect(ad.branches.find((b) => b.branch_code === 'HCM').new_computers).toBe(1); // created in AD yesterday
    expect(ad.branches.find((b) => b.branch_code === 'HN').new_computers).toBe(0); // HN-PC-NEW is old in AD
    const page = (await (await webLogin(app, 'auditor')).agent.get('/reports').query({ dateField: 'ad' })).text;
    expect(page).toContain('Máy mới / key mới theo');
    expect(page).toContain('dateField=ad'); // the Excel link keeps the choice
  });

  it('renders the page with the three parts', async () => {
    const { agent } = await webLogin(app, 'auditor');
    const page = await agent.get('/reports');
    expect(page.status).toBe(200);
    for (const text of ['Tổng quan', 'Chi tiết theo chi nhánh', 'Xem key theo chi nhánh', 'Người xem key', 'Máy chưa có key', 'Xuất Excel']) {
      expect(page.text).toContain(text);
    }
  });

  it('summarises computers without a key per branch, and lists them only for one branch', async () => {
    const { agent } = await apiLogin(app, 'auditor');
    const all = (await agent.get('/api/reports/summary')).body;
    expect(all.noKeyDetail).toBe(false);
    expect(all.noKeyByBranch).toEqual([expect.objectContaining({ branch_code: 'HN', total: 1, recent: 1, older: 0 })]);
    const hn = (await agent.get('/api/reports/summary').query({ branchId: 1 })).body;
    expect(hn.noKeyDetail).toBe(true);
    expect(hn.noKey[0]).toMatchObject({ name: 'HN-PC-NEW', days_without_key: 2, is_new: true });

    const web = await webLogin(app, 'auditor');
    const summary = await web.agent.get('/reports');
    expect(summary.text).toContain('/?branchId=1&status=no_key');
    expect(summary.text).not.toContain('>HN-PC-NEW<');
    expect((await web.agent.get('/reports').query({ branchId: 1 })).text).toContain('>HN-PC-NEW<');
    // A lead sees one branch: the list directly.
    const lead = await apiLogin(app, 'lead.hn');
    expect((await lead.agent.get('/api/reports/summary')).body.noKeyDetail).toBe(true);
  });
});

describe('deleted branches', () => {
  it('counts what deleted branches left in the log in the one N/A row, not one N/A row each', async () => {
    await addUser(pool, 'boss', [{ branchId: null, role: 'admin' }]);
    // Reveals logged under two branches that were deleted since (their ids stay in the log).
    for (const branchId of [98, 99, 99]) {
      await services.audit.log({ userSid: 'user:9', userUpn: 'old.it', action: 'reveal', branchId, reason: 'other' });
    }
    const { agent } = await apiLogin(app, 'boss');
    const r = (await agent.get('/api/reports/summary')).body;
    const na = r.branches.filter((b) => b.branch_code === null);
    expect(na).toHaveLength(1);
    expect(na[0]).toMatchObject({ branch_id: null, reveals: 3, computers: 1 }); // with SRV-0001, which has no branch
    expect(r.revealUsers.filter((u) => u.user_upn === 'old.it')).toEqual([expect.objectContaining({ branch_code: null, reveals: 3 })]);
    const dash = (await agent.get('/api/dashboard')).body;
    expect(dash.branches.find((b) => b.branch_code === null).reveals_30d).toBe(3);
  });
});

describe('Excel of one branch: computers with keys', () => {
  it('lists each computer that has keys with its number of keys, and a total', async () => {
    await asOwner(`INSERT INTO recovery_key (computer_id, key_id, recovery_password, ad_created_at)
                   VALUES (1, 'aaaaaaaa-0000-0000-0000-0000000000a2', '111111-222222-333333-444444-555555-666666-777777-888888', now())`);
    const { agent } = await webLogin(app, 'auditor');
    const res = await agent.get('/reports/export.xlsx').query({ branchId: 1 }).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    const sheet = unzip(res.body)['xl/worksheets/sheet5.xml'];
    expect(sheet).toMatch(/HN-LT-0001[\s\S]*?<v>2<\/v>/); // two keys on that computer
    expect(sheet).toContain('Tổng');
    expect(sheet).not.toMatch(/\d{6}-\d{6}-\d{6}/);
  });
});

describe('Excel column order', () => {
  const fetchXlsx = async (query) => {
    const { agent } = await webLogin(app, 'auditor');
    const res = await agent.get('/reports/export.xlsx').query(query).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    return unzip(res.body);
  };
  // header row of a sheet: its first strings, in column order
  const header = (xml, n) => [...xml.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => m[1]).slice(0, n);

  it('per branch: identity, current figures, AD logon activity, then the period figures', async () => {
    const files = await fetchXlsx({});
    expect(header(files['xl/worksheets/sheet2.xml'], 14)).toEqual([
      'Chi nhánh', 'Tên', 'Máy', 'Có key', 'Chưa có key', '% có key', 'Số key',
      'Hoạt động gần đây (3 tháng)', 'Không hoạt động gần đây', 'Chưa có dữ liệu đăng nhập',
      'Máy mới', 'Key mới', 'Rời phạm vi', 'Lượt hiện key']);
    expect(header(files['xl/worksheets/sheet3.xml'], 7)).toEqual(['Chi nhánh', 'Tên', 'Lượt hiện key', 'Xuất file', 'Ngoài giờ', 'Người xem', 'Máy được xem']);
  });

  it('computer lists: machine, dates in time order, then key or sync details, then DN last', async () => {
    const files = await fetchXlsx({ branchId: 1 });
    expect(header(files['xl/worksheets/sheet5.xml'], 11)).toEqual([
      'Chi nhánh', 'Máy', 'Hệ điều hành', 'Serial', 'Email người dùng', 'Tạo trên AD', 'Ghi nhận', 'Đăng nhập AD gần nhất',
      'Số key', 'Key mới nhất (tạo trên AD)', 'DN']);
    expect(header(files['xl/worksheets/sheet6.xml'], 10)).toEqual([
      'Chi nhánh', 'Máy', 'Hệ điều hành', 'Serial', 'Email người dùng', 'Tạo trên AD', 'Ghi nhận', 'Đăng nhập AD gần nhất',
      'Số ngày chưa có key', 'DN']);
    expect(header(files['xl/worksheets/sheet7.xml'], 9)).toEqual([
      'Chi nhánh', 'Máy', 'Hệ điều hành', 'Serial', 'Email người dùng', 'Lần cuối sync thấy', 'Rời phạm vi lúc', 'Số key (vẫn lưu)', 'DN']);
  });
});
