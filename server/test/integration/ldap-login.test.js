import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { appPool, asOwner, resetDatabase, seedTwoBranches } from './db.js';
import { addAdUser, addUser, apiLogin, buildApp, csrfFrom, webLogin } from './app.js';

const GUID_A = '11111111-2222-3333-4444-555555555555';
const GUID_B = '99999999-8888-7777-6666-555555555555';

let pool;
let app;
let directory;

beforeAll(() => {
  pool = appPool();
  ({ app, directory } = buildApp(pool));
});
afterAll(() => pool?.end());
beforeEach(async () => {
  await resetDatabase();
  await seedTwoBranches();
  directory.down = false;
  directory.binds = 0;
  directory.accounts = { nguyenvana: { password: 'Windows-Pass-1', objectGuid: GUID_A } };
  await addAdUser(pool, 'nguyenvana', [{ branchId: 1, role: 'it' }]);
});

// AD users sign in on the web (the API takes local accounts only): 302 = signed in, otherwise the form again with the status.
const login = async (username, password) => {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  return agent.post('/login').type('form').send({ _csrf: csrfFrom(page.text), username, password });
};
const apiLocal = (username, password) => request(app).post('/api/auth/login').send({ username, password });

describe('sign-in with the AD password', () => {
  it('lets a provisioned AD user in with their Windows password, with roles from this app', async () => {
    const { agent } = await webLogin(app, 'nguyenvana', 'Windows-Pass-1');
    const me = await agent.get('/api/me');
    expect(me.body).toMatchObject({ roles: ['it'], branches: { keys: [1] }, mustChangePassword: false });
    const [log] = await asOwner(`SELECT detail FROM access_log WHERE action = 'login'`);
    expect(log.detail).toEqual({ method: 'ldap' });
  });

  it('fills an empty e-mail from AD at sign-in, but never overwrites one set in the app', async () => {
    directory.accounts.nguyenvana.mail = 'Nguyen.Van.A@corp.local';
    await webLogin(app, 'nguyenvana', 'Windows-Pass-1');
    const email = async () => (await asOwner(`SELECT email FROM app_user WHERE username = 'nguyenvana'`))[0].email;
    expect(await email()).toBe('nguyen.van.a@corp.local');
    await asOwner(`UPDATE app_user SET email = 'set.by.admin@corp.local' WHERE username = 'nguyenvana'`);
    await webLogin(app, 'nguyenvana', 'Windows-Pass-1');
    expect(await email()).toBe('set.by.admin@corp.local');
  });

  it('fills an empty display name from AD at sign-in, but never overwrites one set in the app', async () => {
    directory.accounts.nguyenvana.displayName = 'Nguyen Van A (AD)';
    const name = async () => (await asOwner(`SELECT display_name FROM app_user WHERE username = 'nguyenvana'`))[0].display_name;
    await asOwner(`UPDATE app_user SET display_name = '' WHERE username = 'nguyenvana'`);
    await webLogin(app, 'nguyenvana', 'Windows-Pass-1');
    expect(await name()).toBe('Nguyen Van A (AD)');
    await asOwner(`UPDATE app_user SET display_name = 'Set By Admin' WHERE username = 'nguyenvana'`);
    await webLogin(app, 'nguyenvana', 'Windows-Pass-1');
    expect(await name()).toBe('Set By Admin');
  });

  it('accepts DOMAIN\\user and user@domain forms of the name', async () => {
    expect((await login('CORP\\nguyenvana', 'Windows-Pass-1')).status).toBe(302);
    expect((await login('NguyenVanA@corp.local', 'Windows-Pass-1')).status).toBe(302);
  });

  it('refuses AD users on the API (local accounts only) without contacting AD', async () => {
    const res = await apiLocal('nguyenvana', 'Windows-Pass-1');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('api_requires_local');
    expect(directory.binds).toBe(0);
    const [log] = await asOwner(`SELECT detail FROM access_log WHERE action = 'login_failed'`);
    expect(log.detail).toMatchObject({ reason: 'api_local_only', method: 'ldap' });
    await addUser(pool, 'svc.report', [{ branchId: 1, role: 'auditor' }]);
    expect((await apiLocal('svc.report', 'a-test-passphrase-123')).status).toBe(200);
  });

  it('refuses a valid AD account that was not created in this app, with the usual message', async () => {
    directory.accounts.stranger = { password: 'Stranger-Pass-1', objectGuid: GUID_B };
    const res = await login('stranger', 'Stranger-Pass-1');
    expect(res.status).toBe(401);
    expect(directory.binds).toBe(0); // not even asked to AD
  });

  it('refuses a wrong AD password and counts it towards the lockout', async () => {
    expect((await login('nguyenvana', 'wrong')).status).toBe(401);
    const [u] = await asOwner(`SELECT failed_attempts FROM app_user WHERE username = 'nguyenvana'`);
    expect(u.failed_attempts).toBe(1);
  });

  it('binds the AD objectGUID at first sign-in and refuses a recreated account with the same name', async () => {
    await login('nguyenvana', 'Windows-Pass-1');
    expect((await asOwner(`SELECT ad_object_guid FROM app_user WHERE username = 'nguyenvana'`))[0].ad_object_guid).toBe(GUID_A);

    // The AD account is deleted and a new one (another person) gets the same name.
    directory.accounts.nguyenvana = { password: 'New-Person-Pass-1', objectGuid: GUID_B };
    const res = await login('nguyenvana', 'New-Person-Pass-1');
    expect(res.status).toBe(403);
  });

  it('lets an admin unlink the AD account so the next sign-in binds again', async () => {
    await login('nguyenvana', 'Windows-Pass-1');
    directory.accounts.nguyenvana = { password: 'New-Pass-1', objectGuid: GUID_B };
    await addUser(pool, 'admin.hq', [{ branchId: null, role: 'admin' }]);
    const admin = await apiLogin(app, 'admin.hq');
    const [u] = await asOwner(`SELECT id FROM app_user WHERE username = 'nguyenvana'`);
    expect((await admin.agent.post(`/api/admin/users/${u.id}/unlink-ad`).set('X-CSRF-Token', admin.csrf)).status).toBe(204);
    expect((await login('nguyenvana', 'New-Pass-1')).status).toBe(302);
  });

  it('answers 503 (not "wrong password") when no DC can be reached, and does not count a failure', async () => {
    directory.down = true;
    const res = await login('nguyenvana', 'Windows-Pass-1');
    expect(res.status).toBe(503);
    expect((await asOwner(`SELECT failed_attempts FROM app_user WHERE username = 'nguyenvana'`))[0].failed_attempts).toBe(0);
  });

  it('keeps the local break-glass admin working while AD is down', async () => {
    directory.down = true;
    await addUser(pool, 'admin.hq', [{ branchId: null, role: 'admin' }]);
    expect((await apiLogin(app, 'admin.hq')).csrf).toBeTruthy();
  });

  it('refuses a disabled AD user even with the right password', async () => {
    await pool.query(`UPDATE app_user SET is_active = false WHERE username = 'nguyenvana'`);
    expect((await login('nguyenvana', 'Windows-Pass-1')).status).toBe(401);
  });

  it('never stores or logs the AD password', async () => {
    await login('nguyenvana', 'Windows-Pass-1');
    await login('nguyenvana', 'Wrong-Windows-Pass');
    const dump = JSON.stringify([await asOwner('SELECT * FROM app_user'), await asOwner('SELECT * FROM access_log')]);
    expect(dump).not.toContain('Windows-Pass-1');
    expect(dump).not.toContain('Wrong-Windows-Pass');
  });

  it('does not offer password change to AD users', async () => {
    const { agent } = await webLogin(app, 'nguyenvana', 'Windows-Pass-1');
    const csrf = (await agent.get('/api/me')).body.csrfToken;
    const res = await agent.post('/api/auth/change-password').set('X-CSRF-Token', csrf).send({ currentPassword: 'x', newPassword: 'y' });
    expect(res.body.error).toBe('directory_user');
  });

  it('signs in through the web form too', async () => {
    const agent = request.agent(app);
    const page = await agent.get('/login');
    const res = await agent.post('/login').type('form').send({ _csrf: csrfFrom(page.text), username: 'nguyenvana', password: 'Windows-Pass-1' });
    expect(res.status).toBe(302);
    expect((await agent.get('/')).status).toBe(200);
  });
});

describe('creating AD users', () => {
  it('lets an AD user be created without name and e-mail, but local accounts need both', async () => {
    await addUser(pool, 'admin.hq', [{ branchId: null, role: 'admin' }]);
    const admin = await apiLogin(app, 'admin.hq');
    const post = (body) => admin.agent.post('/api/admin/users').set('X-CSRF-Token', admin.csrf).send(body);
    expect((await post({ username: 'lethic', authSource: 'ldap', grants: [] })).status).toBe(201);
    const [u] = await asOwner(`SELECT display_name, email FROM app_user WHERE username = 'lethic'`);
    expect(u).toEqual({ display_name: '', email: null });
    expect((await post({ username: 'lethic', displayName: 'X', email: '', authSource: 'ldap', grants: [] })).status).toBe(409);
    const bad = await post({ username: 'local.one', displayName: 'Local One', authSource: 'local', grants: [] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('name_email_required_local');
    expect((await post({ username: 'local.one', displayName: 'Local One', email: 'l@corp.local', authSource: 'local', grants: [] })).status).toBe(201);
  });

  it('creates an AD user without any password and validates the sAMAccountName', async () => {
    await addUser(pool, 'admin.hq', [{ branchId: null, role: 'admin' }]);
    const admin = await apiLogin(app, 'admin.hq');
    const post = (body) => admin.agent.post('/api/admin/users').set('X-CSRF-Token', admin.csrf).send(body);

    const ok = await post({ username: 'CORP\\tranthib', displayName: 'Tran Thi B', email: 'tran.thi.b@corp.local', authSource: 'ldap', grants: ['it:2'] });
    expect(ok.status).toBe(201);
    expect(ok.body.oneTimePassword).toBeNull();
    const [u] = await asOwner(`SELECT username, auth_source, password_hash FROM app_user WHERE username = 'tranthib'`);
    expect(u).toEqual({ username: 'tranthib', auth_source: 'ldap', password_hash: null });

    expect((await post({ username: 'a-name-that-is-far-too-long-for-ad', displayName: 'X', email: 'x@corp.local', authSource: 'ldap', grants: [] })).status).toBe(400);
  });

  it('switches a user to a local password and shows a one-time password once', async () => {
    await addUser(pool, 'admin.hq', [{ branchId: null, role: 'admin' }]);
    const admin = await apiLogin(app, 'admin.hq');
    const [u] = await asOwner(`SELECT id FROM app_user WHERE username = 'nguyenvana'`);
    const res = await admin.agent.put(`/api/admin/users/${u.id}`).set('X-CSRF-Token', admin.csrf)
      .send({ displayName: 'NVA', email: 'nva@corp.local', isActive: true, authSource: 'local', grants: ['it:1'] });
    expect(res.body.oneTimePassword).toBeTruthy();
    expect((await apiLocal('nguyenvana', res.body.oneTimePassword)).body.mustChangePassword).toBe(true);
  });
});
