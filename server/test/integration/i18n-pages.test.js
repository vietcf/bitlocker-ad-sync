import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { appPool, asOwner, resetDatabase, seedTwoBranches } from './db.js';
import { addUser, buildApp, csrfFrom, PASSWORD, webLogin } from './app.js';
import { VIETNAMESE } from '../support/i18n-scan.js';

// The UI is bilingual (English by default). Every page, rendered in English, must not contain a single
// Vietnamese letter: that catches any text that was never wrapped in t().

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
  await seedTwoBranches();
  await addUser(pool, 'admin.hq', [{ branchId: null, role: 'admin' }]);
  await addUser(pool, 'it.hn', [{ branchId: 1, role: 'it' }]);
  await addUser(pool, 'auditor', [{ branchId: 1, role: 'auditor' }, { branchId: 2, role: 'auditor' }]);
});

/** Letters of the page that are Vietnamese (empty when the page is clean). */
const vietnamese = (html) => [...new Set(html.match(new RegExp(`[^<>\\n]{0,40}${VIETNAMESE.source}[^<>\\n]{0,40}`, 'g')) ?? [])].slice(0, 5);

const asEnglish = (username) => asOwner(`UPDATE app_user SET language = 'en' WHERE username = '${username}'`);

describe('English pages', () => {
  it('every admin page is free of Vietnamese text', async () => {
    await asOwner(`INSERT INTO sync_run (mode, dc_name, status, started_at, finished_at, anomalies)
      VALUES ('full', 'DC01', 'quarantined', now() - interval '1 hour', now(), '[{"code":"computers_drop","message":"x","detail":{"seen":1,"inDb":10,"threshold":0.95}}]'::jsonb)`);
    await services.alerts.record('sync_stale', 'high', { maxMinutes: 60, lastRunId: 1, lastRunAt: 'now' });
    await services.alerts.record('escrow_broken', 'medium', { withoutKey: 3, created: 5 });
    await services.mail.enqueue({ kind: 'alert', to: ['a@corp.local'], subject: 'subject', body: 'body' });
    await asEnglish('admin.hq');
    const { agent } = await webLogin(app, 'admin.hq');
    const paths = ['/', '/dashboard', '/?q=HN', '/?q=aaaaaaaa', '/?noLogon=only', '/computers/1', '/computers/1/edit', `/computers/1/keys/${KEY_HN}/reveal`,
      '/audit', '/reports', '/reports?branchId=1', '/change-password',
      '/admin/branches', '/admin/branches/new', '/admin/branches/1/edit', '/admin/branches/1/delete', '/admin/users', '/admin/users/new', '/admin/users/1/edit',
      '/admin/sync', '/admin/sync/runs/1', '/admin/backup', '/admin/mail', '/admin/mail/1',
      '/admin/settings/mail-server', '/admin/settings/notifications', '/admin/settings/features', '/admin/settings/thresholds',
      '/admin/settings/security', '/admin/settings/retention', '/nothing-here'];
    for (const path of paths) {
      const res = await agent.get(path);
      expect([200, 404], path).toContain(res.status);
      expect(res.text, path).toContain('lang="en"');
      expect(vietnamese(res.text), `${path} still has Vietnamese`).toEqual([]);
    }
  });

  it('the pages of IT staff and the login page are in English too', async () => {
    await asEnglish('it.hn');
    const { agent } = await webLogin(app, 'it.hn');
    for (const path of ['/', '/?q=HN', '/computers/1', `/computers/1/keys/${KEY_HN}/reveal`, '/dashboard', '/admin/users']) {
      const res = await agent.get(path);
      expect(vietnamese(res.text), `${path} still has Vietnamese`).toEqual([]);
    }
    const anon = await request(app).get('/login');
    expect(anon.text).toContain('lang="en"');
    expect(vietnamese(anon.text)).toEqual([]);
  });

  it('flash messages follow the language too', async () => {
    await asEnglish('admin.hq');
    const { agent, csrf } = await webLogin(app, 'admin.hq');
    const res = await agent.post('/admin/sync/request').type('form').send({ _csrf: csrf, mode: 'delta' });
    expect(res.status).toBe(302);
    const page = await agent.get('/admin/sync');
    expect(page.text).toContain('Sync delta requested');
    expect(vietnamese(page.text)).toEqual([]);
  });
});

describe('language switch', () => {
  it('a visitor picks a language with the cookie; a signed-in user saves it on the account', async () => {
    const visitor = request.agent(app);
    const login = await visitor.get('/login');
    expect(login.text).toContain('lang="en"');
    await visitor.post('/language').type('form').send({ _csrf: csrfFrom(login.text), lang: 'vi', next: '/login' });
    expect((await visitor.get('/login')).text).toContain('lang="vi"');

    const { agent, csrf } = await webLogin(app, 'admin.hq'); // this account is Vietnamese (test default)
    expect((await agent.get('/dashboard')).text).toContain('lang="vi"');
    await agent.post('/language').type('form').send({ _csrf: csrf, lang: 'en', next: '/dashboard' });
    expect((await asOwner(`SELECT language FROM app_user WHERE username = 'admin.hq'`))[0].language).toBe('en');
    expect((await agent.get('/dashboard')).text).toContain('lang="en"');
  });

  it('Admin HQ sets the language of a new user (English by default) and can change it', async () => {
    const { agent } = await webLogin(app, 'admin.hq');
    const form = await agent.get('/admin/users/new');
    const make = (username, language) => agent.post('/admin/users').type('form').send({
      _csrf: csrfFrom(form.text), username, displayName: username, email: `${username}@corp.local`, authSource: 'local', isActive: 'on', grants: ['it:1'], ...(language ? { language } : {}),
    });
    expect((await make('new.default')).status).toBe(200);
    expect((await make('new.viet', 'vi')).status).toBe(200);
    const langs = Object.fromEntries((await asOwner(`SELECT username, language FROM app_user WHERE username LIKE 'new.%'`)).map((r) => [r.username, r.language]));
    expect(langs).toEqual({ 'new.default': 'en', 'new.viet': 'vi' });
    const [{ id }] = await asOwner(`SELECT id FROM app_user WHERE username = 'new.default'`);
    const edit = await agent.get(`/admin/users/${id}/edit`);
    expect(edit.text).toContain('<option value="vi" >');
    const saved = await agent.post(`/admin/users/${id}`).type('form').send({
      _csrf: csrfFrom(edit.text), displayName: 'new.default', email: 'new.default@corp.local', isActive: 'on', authSource: 'local', grants: ['it:1'], language: 'vi',
    });
    expect([200, 302]).toContain(saved.status);
    expect((await asOwner(`SELECT language FROM app_user WHERE id = ${id}`))[0].language).toBe('vi');
  });

  it('ignores an unknown language and an off-site return address', async () => {
    const agent = request.agent(app);
    const login = await agent.get('/login');
    const res = await agent.post('/language').type('form').send({ _csrf: csrfFrom(login.text), lang: 'fr', next: 'https://evil.example/' });
    expect(res.headers.location).toBe('/');
    expect((await agent.get('/login')).text).toContain('lang="en"');
  });

  it('a language picked on the login page becomes the account setting after sign-in', async () => {
    await asEnglish('it.hn');
    const agent = request.agent(app);
    const login = await agent.get('/login');
    await agent.post('/language').type('form').send({ _csrf: csrfFrom(login.text), lang: 'vi', next: '/login' });
    const page = await agent.get('/login');
    const res = await agent.post('/login').type('form').send({ _csrf: csrfFrom(page.text), username: 'it.hn', password: PASSWORD });
    expect(res.status).toBe(302);
    expect((await asOwner(`SELECT language FROM app_user WHERE username = 'it.hn'`))[0].language).toBe('vi');
  });
});
