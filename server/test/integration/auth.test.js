import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ensureDefaultAdmin } from '../../src/modules/auth/users.repo.js';
import { appPool, asOwner, resetDatabase, seedTwoBranches } from './db.js';
import { PASSWORD, addUser, apiLogin, buildApp } from './app.js';

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
});

const login = (username, password) => request.agent(app).post('/api/auth/login').send({ username, password });

describe('default admin', () => {
  it('is created once, only with no users, and must change its password before anything else', async () => {
    expect(await ensureDefaultAdmin(pool)).toBe(true);
    expect(await ensureDefaultAdmin(pool)).toBe(false);

    const agent = request.agent(app);
    const res = await agent.post('/api/auth/login').send({ username: 'admin', password: 'admin' });
    expect(res.status).toBe(200);
    expect(res.body.mustChangePassword).toBe(true);
    const csrf = res.body.csrfToken;

    expect((await agent.get('/api/me')).body.mustChangePassword).toBe(true);
    expect((await agent.get('/api/admin/users')).body.error).toBe('password_change_required');

    const weak = await agent.post('/api/auth/change-password').set('X-CSRF-Token', csrf).send({ currentPassword: 'admin', newPassword: 'short' });
    expect(weak.body).toMatchObject({ error: 'weak_password', reason: 'too_short' });

    const ok = await agent.post('/api/auth/change-password').set('X-CSRF-Token', csrf).send({ currentPassword: 'admin', newPassword: 'a-much-longer-passphrase' });
    expect(ok.status).toBe(200);
    const me = await agent.get('/api/me');
    expect(me.body).toMatchObject({ mustChangePassword: false, roles: ['admin'], branches: { keys: 'all' }, can: { admin: true } });
    expect((await login('admin', 'admin')).status).toBe(401);
  });

  it('is not created when users already exist', async () => {
    await addUser(pool, 'it.hn', [{ branchId: 1, role: 'it' }]);
    expect(await ensureDefaultAdmin(pool)).toBe(false);
  });
});

describe('login', () => {
  it('gives an IT user only their branch', async () => {
    await addUser(pool, 'it.hn', [{ branchId: 1, role: 'it' }]);
    const { agent } = await apiLogin(app, 'it.hn');
    const me = await agent.get('/api/me');
    expect(me.body).toMatchObject({ roles: ['it'], branches: { keys: [1], logs: [] } });
    expect(me.headers['cache-control']).toMatch(/no-store/);
  });

  it('answers the same for an unknown user and a wrong password', async () => {
    await addUser(pool, 'it.hn', [{ branchId: 1, role: 'it' }]);
    const unknown = await login('nobody', 'x');
    const wrong = await login('it.hn', 'x');
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });

  it('locks after 5 wrong passwords, even for the right one', async () => {
    await addUser(pool, 'it.hn', [{ branchId: 1, role: 'it' }]);
    for (let i = 0; i < 5; i++) await login('it.hn', `wrong-${i}`);
    const right = await login('it.hn', PASSWORD);
    expect(right.status).toBe(423);
    expect(right.body.error).toBe('account_locked');
  });

  it('cuts off a user disabled while signed in, on the next request', async () => {
    const id = await addUser(pool, 'it.hn', [{ branchId: 1, role: 'it' }]);
    const { agent } = await apiLogin(app, 'it.hn');
    expect((await agent.get('/api/me')).status).toBe(200);
    await pool.query('UPDATE app_user SET is_active = false WHERE id = $1', [id]);
    expect((await agent.get('/api/me')).status).toBe(401);
  });

  it('issues a new HttpOnly, SameSite=Strict session id at each login', async () => {
    await addUser(pool, 'it.hn', [{ branchId: 1, role: 'it' }]);
    const agent = request.agent(app);
    const a = await agent.post('/api/auth/login').send({ username: 'it.hn', password: PASSWORD });
    const b = await agent.post('/api/auth/login').send({ username: 'it.hn', password: PASSWORD });
    const sid = (r) => r.headers['set-cookie']?.find((c) => c.startsWith('blk.sid='));
    expect(sid(a)).toMatch(/HttpOnly/);
    expect(sid(a)).toMatch(/SameSite=Strict/);
    expect(sid(b).split(';')[0]).not.toBe(sid(a).split(';')[0]);
  });
});

describe('API session protection', () => {
  it('requires a session', async () => {
    expect((await request(app).get('/api/me')).status).toBe(401);
  });

  it('rejects state-changing calls without the CSRF token', async () => {
    await addUser(pool, 'it.hn', [{ branchId: 1, role: 'it' }]);
    const { agent, csrf } = await apiLogin(app, 'it.hn');
    expect((await agent.post('/api/auth/change-password').send({ currentPassword: 'x', newPassword: 'y' })).status).toBe(403);
    expect((await agent.post('/api/auth/change-password').set('X-CSRF-Token', 'nope').send({ currentPassword: 'x', newPassword: 'y' })).status).toBe(403);
    const good = await agent.post('/api/auth/change-password').set('X-CSRF-Token', csrf).send({ currentPassword: 'x', newPassword: 'y' });
    expect(good.body.error).toBe('wrong_current_password');
  });

  it('rejects form-encoded API calls', async () => {
    expect((await request(app).post('/api/auth/login').type('form').send('username=a&password=b')).status).toBe(415);
  });

  it('logs out', async () => {
    await addUser(pool, 'it.hn', [{ branchId: 1, role: 'it' }]);
    const { agent, csrf } = await apiLogin(app, 'it.hn');
    expect((await agent.post('/api/auth/logout').set('X-CSRF-Token', csrf)).status).toBe(204);
    expect((await agent.get('/api/me')).status).toBe(401);
  });
});

describe('audit of sign-ins', () => {
  it('records successes and failures in a valid chain, without passwords', async () => {
    await addUser(pool, 'it.hn', [{ branchId: 1, role: 'it' }]);
    await login('it.hn', 'wrong-password-xyz');
    await login('it.hn', PASSWORD);
    const rows = await asOwner('SELECT action FROM access_log ORDER BY id');
    expect(rows.map((r) => r.action)).toEqual(['login_failed', 'login']);
    const all = JSON.stringify(await asOwner('SELECT * FROM access_log'));
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain('wrong-password-xyz');
  });
});
