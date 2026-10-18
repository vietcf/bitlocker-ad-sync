import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appPool, asOwner, resetDatabase } from './db.js';
import { addUser, apiLogin, buildApp } from './app.js';
import { ensureDefaultAdmin } from '../../src/modules/auth/users.repo.js';

let pool;
let app;

beforeAll(() => {
  pool = appPool();
  ({ app } = buildApp(pool));
});
afterAll(() => pool?.end());
beforeEach(async () => {
  await resetDatabase();
  await addUser(pool, 'root.admin', [{ branchId: null, role: 'admin' }]);
  await asOwner(`UPDATE app_user SET is_root = true WHERE username = 'root.admin'`);
  await addUser(pool, 'admin.two', [{ branchId: null, role: 'admin' }]);
  await addUser(pool, 'admin.three', [{ branchId: null, role: 'admin' }]);
});

const id = async (u) => (await asOwner(`SELECT id FROM app_user WHERE username = $1`, [u]))[0].id;
const body = (u, over = {}) => ({ displayName: u, email: `${u}@corp.local`, isActive: true, grants: ['admin:all'], ...over });
const put = async (as, target, over) => {
  const s = await apiLogin(app, as);
  return s.agent.put(`/api/admin/users/${await id(target)}`).set('X-CSRF-Token', s.csrf).send(body(target, over));
};

describe('only the original admin demotes or disables another admin', () => {
  it('the first account made at start-up is the original admin', async () => {
    await resetDatabase();
    await ensureDefaultAdmin(pool);
    expect((await asOwner(`SELECT username FROM app_user WHERE is_root`))[0].username).toBe('admin');
  });

  it('another admin cannot remove the admin role, disable, or touch the original admin', async () => {
    expect((await put('admin.two', 'admin.three', { grants: [] })).body.error).toBe('only_root_can_demote_admin');
    expect((await put('admin.two', 'admin.three', { isActive: false })).status).toBe(403);
    expect((await put('admin.two', 'root.admin', { displayName: 'x' })).body.error).toBe('root_admin_protected');
    const s = await apiLogin(app, 'admin.two');
    const r = await s.agent.post(`/api/admin/users/${await id('root.admin')}/reset-password`).set('X-CSRF-Token', s.csrf).send({});
    expect(r.status).toBe(403);
  });

  it('the original admin may; other edits of admins stay allowed', async () => {
    expect((await put('root.admin', 'admin.three', { grants: [] })).status).toBe(200);
    expect((await put('admin.two', 'admin.three', { displayName: 'New name' })).status).toBe(200);
  });
});

describe('nobody else can change the original admin, by any route', () => {
  const routes = ['reset-password', 'reset-2fa', 'unlink-ad', 'unlock'];

  it('every user action on the original admin is refused for another admin, also an admin who is not signed in as root', async () => {
    const s = await apiLogin(app, 'admin.two');
    const rootId = await id('root.admin');
    for (const r of routes) {
      const res = await s.agent.post(`/api/admin/users/${rootId}/${r}`).set('X-CSRF-Token', s.csrf).send({});
      expect([r, res.status, res.body.error]).toEqual([r, 403, 'root_admin_protected']);
    }
    const put = await s.agent.put(`/api/admin/users/${rootId}`).set('X-CSRF-Token', s.csrf).send(body('root.admin', { email: 'x@corp.local' }));
    expect([put.status, put.body.error]).toEqual([403, 'root_admin_protected']);
    const [row] = await asOwner(`SELECT email, must_change_password FROM app_user WHERE username = 'root.admin'`);
    expect(row.email).not.toBe('x@corp.local');
  });

  it('the same refusals through the web pages, and nothing changed', async () => {
    const { webLogin } = await import('./app.js');
    const web = await webLogin(app, 'admin.two');
    const rootId = await id('root.admin');
    for (const r of ['reset-password', 'reset-2fa', 'unlink-ad', 'unlock']) {
      const res = await web.agent.post(`/admin/users/${rootId}/${r}`).type('form').send({ _csrf: web.csrf });
      expect([r, res.status]).toEqual([r, 403]);
    }
  });

  it('the original admin can use them on itself and on other admins', async () => {
    const s = await apiLogin(app, 'root.admin');
    expect((await s.agent.post(`/api/admin/users/${await id('root.admin')}/unlock`).set('X-CSRF-Token', s.csrf).send({})).status).toBe(204);
    expect((await s.agent.post(`/api/admin/users/${await id('admin.two')}/reset-2fa`).set('X-CSRF-Token', s.csrf).send({})).status).toBe(204);
    expect((await put('root.admin', 'root.admin', { displayName: 'Root renamed' })).status).toBe(200);
  });

  it('the original admin cannot remove its own admin role or disable itself', async () => {
    expect((await put('root.admin', 'root.admin', { grants: [] })).body.error).toBe('self_lockout');
    expect((await put('root.admin', 'root.admin', { isActive: false })).body.error).toBe('self_lockout');
  });
});

describe('superadmin label', () => {
  it('marks the original admin in the user list and on its edit page, and nobody else', async () => {
    const { webLogin } = await import('./app.js');
    const web = await webLogin(app, 'admin.two');
    const list = (await web.agent.get('/admin/users')).text;
    expect(list.match(/Superadmin/g)).toHaveLength(1);
    expect(list.slice(list.indexOf('root.admin'), list.indexOf('root.admin') + 200)).toContain('Superadmin');
    expect((await web.agent.get(`/admin/users/${await id('root.admin')}/edit`)).text).toContain('Superadmin');
    expect((await web.agent.get(`/admin/users/${await id('admin.three')}/edit`)).text).not.toContain('Superadmin');
  });
});
