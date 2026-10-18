import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appPool, asOwner, resetDatabase, seedTwoBranches } from './db.js';
import { addUser, apiLogin, buildApp, webLogin } from './app.js';
import { assertGrantsConsistent } from '../../src/modules/auth/users.repo.js';

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
});

const idOf = async (u) => (await asOwner(`SELECT id FROM app_user WHERE username = $1`, [u]))[0].id;
const grantsOf = async (u) => (await asOwner(`SELECT role, branch_id FROM user_grant WHERE user_id = $1 ORDER BY branch_id NULLS FIRST, role`, [await idOf(u)]));

describe('roles of a user', () => {
  it('Admin HQ stands alone, one role per branch, different roles on different branches', () => {
    const g = (role, branchId = null) => ({ role, branchId });
    expect(() => assertGrantsConsistent([g('admin')])).not.toThrow();
    expect(() => assertGrantsConsistent([g('it', 1), g('lead', 2)])).not.toThrow();
    expect(() => assertGrantsConsistent([])).not.toThrow();
    expect(() => assertGrantsConsistent([g('admin'), g('it', 1)])).toThrowError(/cannot be combined/);
    expect(() => assertGrantsConsistent([g('it', 1), g('auditor', 1)])).toThrowError(/only one role/);
  });

  it('the API refuses admin plus another role, and two roles on one branch, on create and on update', async () => {
    const admin = await apiLogin(app, 'admin.hq');
    const post = (body) => admin.agent.post('/api/admin/users').set('X-CSRF-Token', admin.csrf).send(body);
    const base = { displayName: 'X', email: 'x@corp.local', authSource: 'local' };

    const a = await post({ ...base, username: 'mix.admin', grants: ['admin:all', 'it:1'] });
    expect(a.status).toBe(400);
    expect(a.body.error).toBe('admin_exclusive');
    const b = await post({ ...base, username: 'two.roles', grants: ['it:1', 'auditor:1'] });
    expect(b.status).toBe(400);
    expect(b.body.error).toBe('one_role_per_branch');
    expect(await asOwner(`SELECT 1 FROM app_user WHERE username IN ('mix.admin', 'two.roles')`)).toHaveLength(0);

    expect((await post({ ...base, username: 'regional', grants: ['it:1', 'lead:2'] })).status).toBe(201);
    expect(await grantsOf('regional')).toEqual([{ role: 'it', branch_id: 1 }, { role: 'lead', branch_id: 2 }]);

    const id = await idOf('regional');
    const put = (grants) => admin.agent.put(`/api/admin/users/${id}`).set('X-CSRF-Token', admin.csrf)
      .send({ displayName: 'X', email: 'x@corp.local', isActive: true, grants });
    expect((await put(['admin:all', 'lead:2'])).body.error).toBe('admin_exclusive');
    expect((await put(['it:1', 'it:1', 'lead:1'])).body.error).toBe('one_role_per_branch');
    expect(await grantsOf('regional')).toEqual([{ role: 'it', branch_id: 1 }, { role: 'lead', branch_id: 2 }]); // untouched by the refusals
    expect((await put(['admin:all'])).status).toBe(200);
    expect(await grantsOf('regional')).toEqual([{ role: 'admin', branch_id: null }]);
  });

  it('the database also keeps one role per branch', async () => {
    const id = await idOf('admin.hq');
    await asOwner(`INSERT INTO user_grant (user_id, branch_id, role) VALUES (${id}, 1, 'it')`);
    await expect(asOwner(`INSERT INTO user_grant (user_id, branch_id, role) VALUES (${id}, 1, 'lead')`)).rejects.toThrow();
  });

  it('a web form with the Admin HQ box ticked ends up with the admin role only', async () => {
    const web = await webLogin(app, 'admin.hq');
    const res = await web.agent.post('/admin/users').type('form').send({
      _csrf: web.csrf, username: 'web.admin', displayName: 'Web Admin', email: 'w@corp.local', authSource: 'local', grants: ['admin:all'],
    });
    expect(res.status).toBeLessThan(400);
    expect(await grantsOf('web.admin')).toEqual([{ role: 'admin', branch_id: null }]);
  });
});
