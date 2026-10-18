import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appPool, asOwner, resetDatabase } from './db.js';
import { PASSWORD, addUser, buildApp, webLogin } from './app.js';
import { LOCKOUT_DEFAULTS, loadLockoutPolicy } from '../../src/modules/auth/lockout.js';

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
  await addUser(pool, 'admin.two', [{ branchId: null, role: 'admin' }]);
  await asOwner(`INSERT INTO branch (code, name) VALUES ('HN', 'Ha Noi')`);
  await addUser(pool, 'it.hn', [{ branchId: 1, role: 'it' }]);
});

const login = (username, password) => request(app).post('/api/auth/login').send({ username, password });
const wrong = async (username, n) => {
  for (let i = 0; i < n; i += 1) await login(username, `wrong-password-${i}`);
};
const setPolicy = async (p) => {
  await services.settings.set('security.lockout', { ...LOCKOUT_DEFAULTS, ...p });
  services.settings.invalidate();
};

describe('account lockout policy', () => {
  it('has defaults, and a wrong stored value falls back to them', async () => {
    expect(await loadLockoutPolicy(services.settings)).toEqual({ enabled: true, maxAttempts: 5, lockMinutes: 15, applyToAdmin: true });
    await services.settings.set('security.lockout', { maxAttempts: 1, lockMinutes: -5, enabled: false });
    expect(await loadLockoutPolicy(services.settings)).toEqual({ enabled: false, maxAttempts: 5, lockMinutes: 15, applyToAdmin: true });
  });

  it('locks after the configured number of wrong passwords, for the configured time', async () => {
    await setPolicy({ maxAttempts: 3, lockMinutes: 30 });
    await wrong('it.hn', 2);
    expect((await login('it.hn', PASSWORD)).status).toBe(200); // 2 wrong is not enough (and a right one resets the count)
    await wrong('it.hn', 3);
    const locked = await login('it.hn', PASSWORD);
    expect(locked.status).toBe(423);
    expect(locked.body.message).toContain('30 minutes');
    const [{ mins }] = await asOwner(`SELECT round(extract(epoch FROM locked_until - now()) / 60)::int AS mins FROM app_user WHERE username = 'it.hn'`);
    expect(mins).toBeGreaterThanOrEqual(29);
    expect(mins).toBeLessThanOrEqual(30);
  });

  it('0 minutes locks until Admin HQ unlocks it', async () => {
    await setPolicy({ maxAttempts: 3, lockMinutes: 0 });
    await wrong('it.hn', 3);
    const locked = await login('it.hn', PASSWORD);
    expect(locked.status).toBe(423);
    expect(locked.body.message).toMatch(/Ask Admin HQ/);
    const web = await webLogin(app, 'admin.hq');
    expect((await web.agent.get('/admin/users')).text).toContain('Khóa (sai mật khẩu)'); // not "temporary"
    const [{ id }] = await asOwner(`SELECT id FROM app_user WHERE username = 'it.hn'`);
    expect((await web.agent.post(`/admin/users/${id}/unlock`).type('form').send({ _csrf: web.csrf })).status).toBe(302);
    expect((await login('it.hn', PASSWORD)).status).toBe(200);
  });

  it('can be switched off', async () => {
    await setPolicy({ enabled: false });
    await wrong('it.hn', 12);
    expect((await login('it.hn', PASSWORD)).status).toBe(200);
  });

  it('can leave Admin HQ accounts alone, and still locks everyone else', async () => {
    await setPolicy({ maxAttempts: 3, applyToAdmin: false });
    await wrong('admin.hq', 6);
    expect((await login('admin.hq', PASSWORD)).status).toBe(200); // never locked
    await wrong('it.hn', 3);
    expect((await login('it.hn', PASSWORD)).status).toBe(423);
    // With the option on, an admin is locked like anyone.
    await setPolicy({ maxAttempts: 3, applyToAdmin: true });
    await wrong('admin.two', 3);
    expect((await login('admin.two', PASSWORD)).status).toBe(423);
  });

  it('is set on the Bao mat page with its defaults, validated, and logged', async () => {
    const web = await webLogin(app, 'admin.hq');
    const page = (await web.agent.get('/admin/settings/security')).text;
    expect(page).toMatch(/name="lockAttempts" value="5"/);
    expect(page).toMatch(/name="lockMinutes" value="15"/);
    expect(page).toMatch(/name="lockEnabled" checked/);
    expect(page).toMatch(/name="lockAdmin" checked/);

    const base = { _csrf: web.csrf, pwMinLength: '12', idleMinutes: '15', maxHours: '8', lockEnabled: 'on', lockAttempts: '4', lockMinutes: '0' };
    expect((await web.agent.post('/admin/settings/security').type('form').send(base)).status).toBe(302); // lockAdmin left out = off
    services.settings.invalidate();
    expect(await loadLockoutPolicy(services.settings)).toEqual({ enabled: true, maxAttempts: 4, lockMinutes: 0, applyToAdmin: false });
    expect((await web.agent.post('/admin/settings/security').type('form').send({ ...base, lockAttempts: '2' })).status).toBe(400);
    expect((await web.agent.post('/admin/settings/security').type('form').send({ ...base, lockAttempts: '21' })).status).toBe(400);
    expect((await web.agent.post('/admin/settings/security').type('form').send({ ...base, lockMinutes: '-1' })).status).toBe(400);
    const log = await asOwner(`SELECT detail FROM access_log WHERE action = 'admin_change' ORDER BY id DESC LIMIT 1`);
    expect(log[0].detail).toMatchObject({ op: 'settings_security', lockout: { maxAttempts: 4, lockMinutes: 0, applyToAdmin: false } });
  });

  it('wrong two-step codes count too', async () => {
    await setPolicy({ maxAttempts: 3 });
    await asOwner(`UPDATE app_user SET totp_required = true WHERE username = 'it.hn'`);
    const agent = request.agent(app);
    const first = await agent.post('/api/auth/login').send({ username: 'it.hn', password: PASSWORD });
    await agent.get('/api/auth/2fa/setup');
    const codes = [];
    for (let i = 0; i < 3; i += 1) codes.push((await agent.post('/api/auth/2fa').set('X-CSRF-Token', first.body.csrfToken).send({ code: '000000' })).status);
    expect(codes).toEqual([401, 401, 423]);
  });
});
