import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appPool, asOwner, resetDatabase, seedTwoBranches } from './db.js';
import { addUser, apiLogin, buildApp, webLogin } from './app.js';
import { PAGE_SIZES, paginate, pageSize } from '../../src/modules/settings/page-size.js';

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
  await seedTwoBranches(); // HN (1 computer, 1 key), HCM (1 computer, 1 key), SRV (N/A)
  // Six more branches with no computer and no key yet.
  for (let i = 1; i <= 6; i += 1) await asOwner(`INSERT INTO branch (code, name) VALUES ('ZZ${i}', 'Chi nhanh trong ${i}')`);
  await addUser(pool, 'admin.hq', [{ branchId: null, role: 'admin' }]);
});

const branchRows = (html) => [...html.matchAll(/<td><strong>([A-Z0-9/]+)<\/strong>/g)].map((m) => m[1]);

describe('page size helpers', () => {
  it('give the default, keep a stored value inside its limits, and cut a list into pages', async () => {
    expect(await pageSize(services.settings, PAGE_SIZES.computers)).toBe(25);
    expect(await pageSize(services.settings, PAGE_SIZES.audit)).toBe(50);
    expect(await pageSize(services.settings, PAGE_SIZES.mail)).toBe(50);
    expect(await pageSize(services.settings, PAGE_SIZES.report)).toBe(20);
    await services.settings.set(PAGE_SIZES.report.key, 1000);
    expect(await pageSize(services.settings, PAGE_SIZES.report)).toBe(20); // wrong value: the default
    const list = Array.from({ length: 12 }, (_, i) => i);
    expect(paginate(list, 2, 5)).toMatchObject({ rows: [5, 6, 7, 8, 9], page: 2, pages: 3, total: 12 });
    expect(paginate(list, 99, 5)).toMatchObject({ rows: [10, 11], page: 3 });
    expect(paginate(list, 'x', 5).page).toBe(1);
    expect(paginate([], 1, 5)).toMatchObject({ rows: [], page: 1, pages: 1, total: 0 });
  });
});

describe('Bao cao: chi tiet theo chi nhanh', () => {
  it('lists every branch, also those with no computer or key (0), and pages them', async () => {
    const web = await webLogin(app, 'admin.hq');
    const page1 = (await web.agent.get('/reports')).text;
    // Default 20 per page: all 8 branches + N/A fit on one page.
    const all = branchRows(page1);
    expect(all).toEqual(expect.arrayContaining(['HN', 'HCM', 'ZZ1', 'ZZ6']));
    const zz1 = page1.slice(page1.indexOf('<strong>ZZ1</strong>'));
    expect(zz1.slice(0, zz1.indexOf('</tr>'))).toMatch(/<td class="num">0<\/td>\s*<td class="num">0<\/td>\s*<td class="num">0<\/td>/); // computers, with key, no key
    expect(page1).not.toMatch(/<td class="num">—<\/td>\s*<td class="num">—<\/td>\s*<td class="num">—<\/td>\s*<td class="num">—<\/td>\s*<\/tr>/);

    // A page of 5: the rest is on the next page, with a pager.
    await services.settings.set(PAGE_SIZES.report.key, 5);
    services.settings.invalidate();
    const first = branchRows((await web.agent.get('/reports')).text);
    const second = branchRows((await web.agent.get('/reports').query({ bpage: 2 })).text);
    expect(first).toHaveLength(5);
    expect(second.length).toBeGreaterThan(0);
    expect([...first, ...second].sort()).toEqual(expect.arrayContaining(['HN', 'HCM', 'ZZ1', 'ZZ2', 'ZZ3', 'ZZ4', 'ZZ5', 'ZZ6']));
    expect(first.some((c) => second.includes(c))).toBe(false);
    const html = (await web.agent.get('/reports')).text;
    expect(html).toContain('bpage=2');
    expect(html).toMatch(/Hiển thị 1–5 \/ \d+ chi nhánh/);
  });

  it('the Excel sheet "Theo chi nhánh" lists them all too', async () => {
    const { agent } = await apiLogin(app, 'admin.hq');
    const r = (await agent.get('/api/reports/summary')).body;
    const codes = r.branches.map((b) => b.branch_code);
    expect(codes).toEqual(expect.arrayContaining(['HN', 'HCM', 'ZZ1', 'ZZ2', 'ZZ3', 'ZZ4', 'ZZ5', 'ZZ6']));
    expect(r.branches.find((b) => b.branch_code === 'ZZ3')).toMatchObject({ computers: 0, with_key: 0, no_key: 0, keys: 0 });
  });
});

describe('Tong quan: every branch', () => {
  it('lists a branch that has no computer yet', async () => {
    const { agent } = await apiLogin(app, 'admin.hq');
    const d = (await agent.get('/api/dashboard')).body;
    expect(d.branches.find((b) => b.branch_code === 'ZZ2')).toMatchObject({ computers: 0, keys: 0 });
    expect(d.branches.map((b) => b.branch_code)).toEqual(expect.arrayContaining(['HN', 'HCM', 'ZZ1', 'ZZ6', null])); // N/A holds the server
    expect(d.totals.computers).toBe(3);
  });
});

describe('Quan tri: rows per page', () => {
  it('are set on the Tinh nang page with their defaults, and apply to the lists', async () => {
    const web = await webLogin(app, 'admin.hq');
    const page = (await web.agent.get('/admin/settings/features')).text;
    expect(page).toMatch(/name="ui\.page_size\.computers" value="25"/);
    expect(page).toMatch(/name="ui\.page_size\.audit" value="50"/);
    expect(page).toMatch(/name="ui\.page_size\.mail" value="50"/);
    expect(page).toMatch(/name="ui\.page_size\.report" value="20"/);

    const form = { _csrf: web.csrf, 'ui.page_size.computers': '5', 'ui.page_size.audit': '7', 'ui.page_size.mail': '10', 'ui.page_size.report': '8' };
    expect((await web.agent.post('/admin/settings/features').type('form').send(form)).status).toBe(302);
    expect((await web.agent.post('/admin/settings/features').type('form').send({ ...form, 'ui.page_size.audit': '4' })).status).toBe(400);
    expect((await web.agent.post('/admin/settings/features').type('form').send({ ...form, 'ui.page_size.audit': '201' })).status).toBe(400);
    services.settings.invalidate();

    const { agent } = await apiLogin(app, 'admin.hq');
    expect((await agent.get('/api/audit')).body.pageSize).toBe(7);
    expect((await agent.get('/api/computers')).body.pageSize).toBe(5);
    const log = await asOwner(`SELECT detail FROM access_log WHERE action = 'admin_change' ORDER BY id`);
    expect(log.some((l) => l.detail.op === 'settings_features' && l.detail.features['ui.page_size.audit'] === 7)).toBe(true);
  });
});
