import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appPool, asOwner, resetDatabase, seedTwoBranches } from './db.js';
import { addAdUser, addUser, apiLogin, buildApp, csrfFrom, webLogin } from './app.js';

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
  await addUser(pool, 'root.admin', [{ branchId: null, role: 'admin' }]);
  await asOwner(`UPDATE app_user SET is_root = true WHERE username = 'root.admin'`);
  await addUser(pool, 'admin.two', [{ branchId: null, role: 'admin' }]);
  await addUser(pool, 'it.hn', [{ branchId: 1, role: 'it' }]);
});

const idOf = async (u) => (await asOwner(`SELECT id FROM app_user WHERE username = $1`, [u]))[0].id;
const exists = async (u) => (await asOwner(`SELECT 1 FROM app_user WHERE username = $1`, [u])).length === 1;
const del = async (as, target) => {
  const s = await apiLogin(app, as);
  return s.agent.delete(`/api/admin/users/${await idOf(target)}`).set('X-CSRF-Token', s.csrf);
};

describe('deleting a user', () => {
  it('deletes a user the log has never mentioned, with their grants, and records who did it', async () => {
    expect((await del('root.admin', 'it.hn')).status).toBe(204);
    expect(await exists('it.hn')).toBe(false);
    const grants = await asOwner(`SELECT count(*)::int AS n FROM user_grant g LEFT JOIN app_user u ON u.id = g.user_id WHERE u.id IS NULL`);
    expect(grants[0].n).toBe(0);
    const [log] = await asOwner(`SELECT detail FROM access_log WHERE action = 'admin_change' AND detail->>'op' = 'delete_user'`);
    expect(log.detail).toMatchObject({ op: 'delete_user', user: 'it.hn' });
  });

  it('refuses once the log has an entry of that user, and tells why', async () => {
    await apiLogin(app, 'it.hn'); // a sign-in is logged under that user
    const res = await del('root.admin', 'it.hn');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('user_has_log');
    expect(await exists('it.hn')).toBe(true);
  });

  it('counts a failed sign-in under that name too', async () => {
    const { default: request } = await import('supertest');
    await request(app).post('/api/auth/login').send({ username: 'it.hn', password: 'wrong-password-123' });
    expect((await del('root.admin', 'it.hn')).body.error).toBe('user_has_log');
  });

  it('never deletes yourself or the original admin', async () => {
    expect((await del('admin.two', 'admin.two')).body.error).toBe('self_delete');
    expect((await del('admin.two', 'root.admin')).body.error).toBe('root_admin_protected');
    expect((await del('root.admin', 'root.admin')).body.error).toBe('self_delete');
    expect(await exists('root.admin')).toBe(true);
  });

  it('only the original admin deletes another admin', async () => {
    await addUser(pool, 'admin.three', [{ branchId: null, role: 'admin' }]);
    expect((await del('admin.two', 'admin.three')).body.error).toBe('only_root_can_demote_admin');
    expect((await del('root.admin', 'admin.three')).status).toBe(204);
  });

  it('non-admins cannot delete users', async () => {
    expect((await del('it.hn', 'admin.two')).status).toBe(403);
  });

  it('the web button deletes and the flash says so; a user with a log is refused with the reason', async () => {
    await addAdUser(pool, 'nguyenvana', []);
    const web = await webLogin(app, 'root.admin');
    const post = async (u) => web.agent.post(`/admin/users/${await idOf(u)}/delete`).type('form').send({ _csrf: web.csrf });
    const ok = await post('nguyenvana');
    expect(ok.status).toBe(302);
    expect(await exists('nguyenvana')).toBe(false);

    await apiLogin(app, 'it.hn');
    const refused = await post('it.hn');
    expect(refused.status).toBe(409);
    expect(refused.text).toContain('vô hiệu hóa');
    expect(await exists('it.hn')).toBe(true);
  });

  it('the edit form offers the button for others, not for yourself or the original admin', async () => {
    const web = await webLogin(app, 'root.admin');
    const page = async (u) => (await web.agent.get(`/admin/users/${await idOf(u)}/edit`)).text;
    expect(await page('it.hn')).toContain('/delete');
    expect(await page('root.admin')).not.toContain('Xóa người dùng');
    expect(csrfFrom(await page('it.hn'))).toBeTruthy();
  });
});
