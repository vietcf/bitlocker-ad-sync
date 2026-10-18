import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { appPool, asOwner, PWD, resetDatabase, seedTwoBranches } from './db.js';
import { addUser, buildApp, csrfFrom, PASSWORD, webLogin } from './app.js';

const KEY_HN = 'aaaaaaaa-0000-0000-0000-000000000001';

let pool;
let app;

beforeAll(() => {
  pool = appPool();
  ({ app } = buildApp(pool));
});
afterAll(() => pool?.end());
beforeEach(async () => {
  await resetDatabase();
  await seedTwoBranches();
  await addUser(pool, 'admin.hq', [{ branchId: null, role: 'admin' }]);
  await addUser(pool, 'it.hn', [{ branchId: 1, role: 'it' }]);
  await addUser(pool, 'auditor', [{ branchId: 1, role: 'auditor' }, { branchId: 2, role: 'auditor' }]);
});

describe('web pages', () => {
  it('sends signed-out visitors to the login page, keeping where they wanted to go', async () => {
    const res = await request(app).get('/computers/1');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login?next=%2Fcomputers%2F1');
  });

  it('shows the login form again with a message on a wrong password', async () => {
    const agent = request.agent(app);
    const page = await agent.get('/login');
    const res = await agent.post('/login').type('form').send({ _csrf: csrfFrom(page.text), username: 'it.hn', password: 'nope' });
    expect(res.status).toBe(401);
    expect(res.text).toContain('Sai tên đăng nhập hoặc mật khẩu');
  });

  it('refuses a form post without the CSRF token', async () => {
    const res = await request(app).post('/login').type('form').send({ username: 'it.hn', password: PASSWORD });
    expect(res.status).toBe(403);
  });

  it('does not follow an off-site "next" after login', async () => {
    const agent = request.agent(app);
    const page = await agent.get('/login');
    const res = await agent.post('/login').type('form').send({ _csrf: csrfFrom(page.text), username: 'it.hn', password: PASSWORD, next: '//evil.example/x' });
    expect(res.headers.location).toBe('/');
  });

  it('renders every admin page', async () => {
    const { agent } = await webLogin(app, 'admin.hq');
    for (const path of ['/', '/dashboard', '/?q=HN', '/?q=aaaaaaaa', '/computers/1', `/computers/1/keys/${KEY_HN}/reveal`, '/audit', '/reports',
      '/admin/branches', '/admin/branches/new', '/admin/branches/1/edit', '/admin/users', '/admin/users/new', '/admin/sync']) {
      const res = await agent.get(path);
      expect(res.status, path).toBe(200);
      expect(res.text, path).toContain('</html>');
    }
  });

  it('keeps IT staff out of admin pages and other branches', async () => {
    const { agent } = await webLogin(app, 'it.hn');
    expect((await agent.get('/admin/users')).status).toBe(403);
    expect((await agent.get('/audit')).status).toBe(403);
    expect((await agent.get('/computers/2')).status).toBe(404);
  });

  it('sends an auditor to the log instead of the search page', async () => {
    const { agent } = await webLogin(app, 'auditor');
    const res = await agent.get('/');
    expect(res.headers.location).toBe('/dashboard');
    expect((await agent.get('/computers/1')).status).toBe(403);
  });

  it('reveals a key through the form, on a no-store page, with the reason logged', async () => {
    const { agent } = await webLogin(app, 'it.hn');
    const form = await agent.get(`/computers/1/keys/${KEY_HN}/reveal`);
    const missing = await agent.post(`/computers/1/keys/${KEY_HN}/reveal`).type('form').send({ _csrf: csrfFrom(form.text), reason: '' });
    expect(missing.status).toBe(400);
    expect(missing.text).not.toContain(PWD(1));

    const res = await agent.post(`/computers/1/keys/${KEY_HN}/reveal`).type('form').send({ _csrf: csrfFrom(form.text), reason: 'user_locked_out' });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    for (const group of PWD(1).split('-')) expect(res.text).toContain(group);
    expect(res.text).toContain('data-reveal');
  });

  it('serves pages with a strict content security policy', async () => {
    const res = await request(app).get('/login');
    expect(res.headers['content-security-policy']).toMatch(/script-src 'self'/);
    expect(res.headers['x-frame-options']).toBeDefined();
  });

  it('lets an admin create a user and shows the one-time password once', async () => {
    const { agent } = await webLogin(app, 'admin.hq');
    const form = await agent.get('/admin/users/new');
    const res = await agent.post('/admin/users').type('form').send({ _csrf: csrfFrom(form.text), username: 'it.hcm', displayName: 'IT HCM', email: 'it.hcm@corp.local', authSource: 'local', isActive: 'on', grants: ['it:2'] });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Mật khẩu một lần');
    expect(res.headers['cache-control']).toMatch(/no-store/);
  });

describe('reveal page', () => {
  it('has a copy-to-clipboard button for the recovery key', async () => {
    const { agent } = await webLogin(app, 'it.hn');
    const form = await agent.get(`/computers/1/keys/${KEY_HN}/reveal`);
    const page = await agent.post(`/computers/1/keys/${KEY_HN}/reveal`).type('form').send({ _csrf: csrfFrom(form.text), reason: 'user_locked_out' });
    expect(page.text).toContain('data-copy-key');
    expect(page.text).toContain('Sao chép key');
  });
});
});

describe('Quan tri navigation', () => {
  it('shows the four groups and only the sub-tabs of the open group', async () => {
    await addUser(pool, 'nav.admin', [{ branchId: null, role: 'admin' }]);
    const { agent } = await webLogin(app, 'nav.admin');
    const page = (await agent.get('/admin/backup')).text;
    for (const g of ['Người dùng &amp; chi nhánh', 'Đồng bộ AD', 'Email', 'Hệ thống']) expect(page).toContain(`>${g}</a>`);
    expect(page).toMatch(/aria-current="true">Hệ thống</);
    expect(page).toMatch(/aria-current="page">Sao lưu</);
    expect(page).toContain('>Bảo mật</a>');
    expect(page).not.toContain('>Mail server</a>'); // another group's tab
    const mail = (await agent.get('/admin/mail')).text;
    expect(mail).toMatch(/aria-current="true">Email</);
  });
});

describe('Tinh trang sync: worker Online / Offline', () => {
  it('shows Online in green within the heartbeat limit, Offline in red after it', async () => {
    await addUser(pool, 'sync.admin', [{ branchId: null, role: 'admin' }]);
    await asOwner(`INSERT INTO worker_heartbeat (worker_id, version, at, ldap_ok) VALUES
      ('dev-go', '1.0.0-go', now() - interval '2 minutes', true),
      ('old-net', '1.0.0', now() - interval '3 hours', true)`);
    const { agent } = await webLogin(app, 'sync.admin');
    const page = (await agent.get('/admin/sync')).text;
    expect(page).toMatch(/dev-go[\s\S]*?badge badge-good[^>]*>● Online</);
    expect(page).toMatch(/old-net[\s\S]*?badge badge-bad[^>]*>● Offline</);
  });
});

describe('Tinh trang sync: two separate statuses', () => {
  it('shows the worker and AD / the sync apart', async () => {
    await addUser(pool, 'status.admin', [{ branchId: null, role: 'admin' }]);
    const { agent } = await webLogin(app, 'status.admin');
    // Worker alive, AD problem.
    await asOwner(`INSERT INTO worker_heartbeat (worker_id, version, at, ldap_ok, last_error_code) VALUES ('w1', '1', now(), false, 'ldap_tls_failed')`);
    await asOwner(`INSERT INTO sync_alert (type, severity, detail) VALUES ('sync_problem', 'high', '{"subject":"x","text":"y"}')`);
    let page = (await agent.get('/admin/sync')).text;
    expect(page).toMatch(/Worker \(agent\)[\s\S]*?badge-good[^>]*>● Online/);
    expect(page).toMatch(/Đồng bộ AD<\/div>[\s\S]*?badge-bad[^>]*>● Có sự cố/);
    // Worker down: the worker is Offline and AD is "not determined", never "problem".
    await asOwner(`DELETE FROM sync_alert; UPDATE worker_heartbeat SET at = now() - interval '3 hours'`);
    await asOwner(`INSERT INTO sync_alert (type, severity, detail) VALUES ('worker_offline', 'high', '{"subject":"x","text":"y"}')`);
    page = (await agent.get('/admin/sync')).text;
    expect(page).toMatch(/Worker \(agent\)[\s\S]*?badge-bad[^>]*>● Offline/);
    expect(page).toMatch(/Đồng bộ AD<\/div>[\s\S]*?badge-muted[^>]*>Chưa xác định/);
    expect(page).not.toContain('● Có sự cố');
  });
});
