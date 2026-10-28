import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appPool, asOwner, resetDatabase } from './db.js';
import { PASSWORD, addUser, apiLogin, buildApp, csrfFrom, webLogin, chooseVietnamese } from './app.js';
import { codeAt, stepAt } from '../../src/modules/auth/totp.js';

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
  await addUser(pool, 'it.hn', []);
});

const turnOn2fa = () => asOwner(`UPDATE app_user SET totp_required = true WHERE username = 'it.hn'`);

/** Password step through the API: returns the agent (not signed in yet) and the body. */
async function passwordStep(username = 'it.hn') {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ username, password: PASSWORD });
  return { agent, res };
}

describe('two-step sign-in (TOTP)', () => {
  it('first sign-in sets up the app; afterwards a code is asked; a code works once', async () => {
    await turnOn2fa();
    const first = await passwordStep();
    expect(first.res.status).toBe(200);
    expect(first.res.body.secondFactor).toBe('setup');
    expect((await first.agent.get('/api/me')).status).toBe(401); // not signed in yet

    const setup = await first.agent.get('/api/auth/2fa/setup');
    expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\/BitLocker%20Keys%3Ait\.hn\?secret=/);
    const { secret } = setup.body;
    expect((await first.agent.get('/api/auth/2fa/setup')).body.secret).toBe(secret); // stable on reload
    const stored = await asOwner(`SELECT totp_secret FROM app_user WHERE username = 'it.hn'`);
    expect(stored[0].totp_secret).toMatch(/^enc:v1:/); // never stored in clear
    expect(stored[0].totp_secret).not.toContain(secret);

    const bad = await first.agent.post('/api/auth/2fa').set('X-CSRF-Token', first.res.body.csrfToken).send({ code: '000000' });
    expect(bad.status).toBe(401);
    const code = codeAt(secret, stepAt());
    const ok = await first.agent.post('/api/auth/2fa').set('X-CSRF-Token', first.res.body.csrfToken).send({ code });
    expect(ok.status).toBe(200);
    expect((await first.agent.get('/api/me')).body.user.username).toBe('it.hn');

    // Next sign-in: a code. The code just used is refused (replay); the next one works.
    const second = await passwordStep();
    expect(second.res.body.secondFactor).toBe('code');
    const reuse = await second.agent.post('/api/auth/2fa').set('X-CSRF-Token', second.res.body.csrfToken).send({ code });
    expect(reuse.status).toBe(401);
    const next = await second.agent.post('/api/auth/2fa').set('X-CSRF-Token', second.res.body.csrfToken).send({ code: codeAt(secret, stepAt() + 1) });
    expect(next.status).toBe(200);

    const log = await asOwner(`SELECT action, detail FROM access_log WHERE user_upn = 'it.hn' ORDER BY id`);
    expect(log.map((l) => [l.action, l.action === 'login' ? l.detail.twoFactor : l.detail.reason])).toEqual([
      ['login_failed', 'wrong_totp'],
      ['login', 'totp_enrolled'],
      ['login_failed', 'wrong_totp'],
      ['login', 'totp'],
    ]);
  });

  it('locks the account after 5 wrong codes', async () => {
    await turnOn2fa();
    const { agent, res } = await passwordStep();
    await agent.get('/api/auth/2fa/setup');
    const codes = [];
    for (let i = 0; i < 5; i += 1) codes.push((await agent.post('/api/auth/2fa').set('X-CSRF-Token', res.body.csrfToken).send({ code: '111111' })).status);
    expect(codes).toEqual([401, 401, 401, 401, 423]);
  });

  it('web: password, then the QR code page, then the code', async () => {
    await turnOn2fa();
    const agent = request.agent(app);
    await chooseVietnamese(agent);
    const page = await agent.get('/login');
    const login = await agent.post('/login').type('form').send({ _csrf: csrfFrom(page.text), username: 'it.hn', password: PASSWORD });
    expect(login.headers.location).toBe('/login/2fa');
    expect((await agent.get('/')).headers.location).toMatch(/^\/login/); // the app is still closed
    const setup = await agent.get('/login/2fa');
    expect(setup.text).toContain('<svg');
    expect(setup.text).toContain('Thiết lập xác thực 2 bước');
    const secret = /class="totp-secret">([A-Z2-7 ]+)</.exec(setup.text)[1].replace(/ /g, '');
    const done = await agent.post('/login/2fa').type('form').send({ _csrf: csrfFrom(setup.text), code: codeAt(secret, stepAt()) });
    expect(done.status).toBe(302);
    expect(done.headers.location).toBe('/');
    expect((await agent.get('/')).headers.location ?? '').not.toMatch(/login/); // signed in
  });

  it('Admin HQ turns it on / off, resets it, and can force a password change', async () => {
    const web = await webLogin(app, 'admin.hq');
    const [{ id }] = await asOwner(`SELECT id FROM app_user WHERE username = 'it.hn'`);
    const save = (extra) => web.agent.post(`/admin/users/${id}`).type('form')
      .send({ _csrf: web.csrf, displayName: 'IT HN', email: 'it@corp.local', isActive: 'on', ...extra });

    expect((await save({ totpRequired: 'on' })).status).toBe(302);
    expect((await passwordStep()).res.body.secondFactor).toBe('setup');
    const users = await web.agent.get('/admin/users');
    expect(users.text).toContain('Chờ thiết lập');

    // Set up, then reset: a new QR code next time.
    const s = await passwordStep();
    const { secret } = (await s.agent.get('/api/auth/2fa/setup')).body;
    await s.agent.post('/api/auth/2fa').set('X-CSRF-Token', s.res.body.csrfToken).send({ code: codeAt(secret, stepAt()) });
    expect((await passwordStep()).res.body.secondFactor).toBe('code');
    expect((await web.agent.post(`/admin/users/${id}/reset-2fa`).type('form').send({ _csrf: web.csrf })).status).toBe(302);
    expect((await passwordStep()).res.body.secondFactor).toBe('setup');

    // Off: password only again. Force a password change.
    await save({ mustChangePassword: 'on' });
    const plain = await apiLogin(app, 'it.hn');
    const me = await plain.agent.get('/api/me');
    expect(me.body.mustChangePassword).toBe(true);
    const log = await asOwner(`SELECT detail FROM access_log WHERE action = 'admin_change' ORDER BY id`);
    expect(log.map((l) => l.detail.op)).toEqual(['update_user', 'reset_two_factor', 'update_user']);
    expect(log[2].detail).toMatchObject({ totpRequired: { from: true, to: false }, mustChangePassword: { from: false, to: true } });
  });

  it('an API update that leaves the fields out keeps them', async () => {
    await turnOn2fa();
    const { agent, csrf } = await apiLogin(app, 'admin.hq');
    const [{ id }] = await asOwner(`SELECT id FROM app_user WHERE username = 'it.hn'`);
    const r = await agent.put(`/api/admin/users/${id}`).set('X-CSRF-Token', csrf)
      .send({ displayName: 'IT', email: 'it@corp.local', isActive: true, grants: [] });
    expect(r.status).toBe(200);
    expect((await asOwner(`SELECT totp_required FROM app_user WHERE id = $1`, [id]))[0].totp_required).toBe(true);
  });
});

describe('session limits', () => {
  it('ends a session idle longer than Quan tri > Bao mat allows', async () => {
    const web = await webLogin(app, 'admin.hq');
    const saved = await web.agent.post('/admin/settings/security').type('form').send({ _csrf: web.csrf, pwMinLength: '12', idleMinutes: '10', maxHours: '8' });
    expect(saved.status).toBe(302);
    expect((await web.agent.post('/admin/settings/security').type('form').send({ _csrf: web.csrf, pwMinLength: '12', idleMinutes: '600', maxHours: '8' })).status).toBe(400);
    services.settings.invalidate();
    const page = await web.agent.get('/admin/settings/security');
    expect(page.text).toContain('value="10"');
    expect(page.text).toContain('data-idle-minutes="10"');

    const api = await apiLogin(app, 'it.hn');
    expect((await api.agent.get('/api/me')).status).toBe(200);
    // 11 minutes without a request.
    await asOwner(`UPDATE session SET sess = jsonb_set(sess::jsonb, '{lastSeenAt}', to_jsonb((extract(epoch FROM now()) * 1000 - 11 * 60000)::bigint))::json
                    WHERE sess::jsonb->>'userId' IS NOT NULL AND (sess::jsonb->>'userId')::int = (SELECT id FROM app_user WHERE username = 'it.hn')`);
    const expired = await api.agent.get('/api/me');
    expect(expired.status).toBe(401);
    expect(expired.body.error).toBe('session_expired');
  });
});

describe('password policy (Quan tri > Bao mat)', () => {
  it('is enforced on a password change and met by one-time passwords', async () => {
    const web = await webLogin(app, 'admin.hq');
    const saved = await web.agent.post('/admin/settings/security').type('form')
      .send({ _csrf: web.csrf, pwMinLength: '16', pwUpper: 'on', pwDigit: 'on', pwSpecial: 'on', idleMinutes: '15', maxHours: '8' });
    expect(saved.status).toBe(302);
    services.settings.invalidate();
    expect(await services.settings.get('password.policy')).toEqual({ minLength: 16, upper: true, lower: false, digit: true, special: true });
    expect((await web.agent.post('/admin/settings/security').type('form').send({ _csrf: web.csrf, pwMinLength: '4', idleMinutes: '15', maxHours: '8' })).status).toBe(400);

    const { agent, csrf } = await apiLogin(app, 'it.hn');
    const weak = await agent.post('/api/auth/change-password').set('X-CSRF-Token', csrf).send({ currentPassword: PASSWORD, newPassword: 'longbutnoupper-123' });
    expect(weak.status).toBe(400);
    expect(weak.body).toMatchObject({ error: 'weak_password', reason: 'missing_upper' });
    const short = await agent.post('/api/auth/change-password').set('X-CSRF-Token', csrf).send({ currentPassword: PASSWORD, newPassword: 'Short-1' });
    expect(short.body).toMatchObject({ reason: 'too_short', minLength: 16 });
    const ok = await agent.post('/api/auth/change-password').set('X-CSRF-Token', csrf).send({ currentPassword: PASSWORD, newPassword: 'Mot cum tu dai 2026!' });
    expect(ok.status).toBe(200);

    const page = await (await webLogin(app, 'admin.hq')).agent.get('/admin/settings/security');
    expect(page.text).toContain('Tối thiểu 16 ký tự, có ít nhất một chữ hoa, một chữ số');

    const [{ id }] = await asOwner(`SELECT id FROM app_user WHERE username = 'it.hn'`);
    const admin = await apiLogin(app, 'admin.hq');
    const reset = await admin.agent.post(`/api/admin/users/${id}/reset-password`).set('X-CSRF-Token', admin.csrf);
    expect(reset.body.oneTimePassword.length).toBeGreaterThanOrEqual(16);
    expect(reset.body.oneTimePassword).toMatch(/[A-Z]/);
    expect(reset.body.oneTimePassword).toMatch(/\d/);
  });
});
