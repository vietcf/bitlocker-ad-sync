import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { appPool, asOwner, resetDatabase, seedTwoBranches } from './db.js';
import { addUser, apiLogin, buildApp, webLogin } from './app.js';

let pool;
let app;
let admin;

beforeAll(() => {
  pool = appPool();
  ({ app } = buildApp(pool));
});
afterAll(() => pool?.end());
beforeEach(async () => {
  await resetDatabase();
  await seedTwoBranches();
  await addUser(pool, 'admin.hq', [{ branchId: null, role: 'admin' }]);
  admin = await apiLogin(app, 'admin.hq');
});

const post = (path, body) => admin.agent.post(path).set('X-CSRF-Token', admin.csrf).send(body);
const put = (path, body) => admin.agent.put(path).set('X-CSRF-Token', admin.csrf).send(body);

describe('branches', () => {
  it('creates a branch and re-maps the computers its OU covers', async () => {
    // SRV-0001 (computer 3) sits in OU=Servers and is unmapped in the seed.
    const preview = await post('/api/admin/branches/preview', { ous: ['OU=Servers,DC=corp,DC=local'] });
    expect(preview.body.matches).toEqual([{ current_branch: 'N/A', computers: 1 }]);

    const res = await post('/api/admin/branches', { code: 'srv', name: 'Servers', isActive: true, ous: ['OU=Servers,DC=corp,DC=local'] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ moved: 1, computers: 1 });
    const [c] = await asOwner(`SELECT b.code FROM computer c JOIN branch b ON b.id = c.branch_id WHERE c.name = 'SRV-0001'`);
    expect(c.code).toBe('SRV');
    const [log] = await asOwner(`SELECT detail FROM access_log WHERE action = 'admin_change'`);
    expect(log.detail).toMatchObject({ op: 'create_branch', branch: 'SRV', computersMoved: 1 });
  });

  it('refuses an OU already owned by another branch, and a duplicate code', async () => {
    expect((await post('/api/admin/branches', { code: 'X', name: 'X', isActive: true, ous: ['OU=Computers,OU=HN,DC=corp,DC=local'] })).body.error).toBe('ou_taken');
    expect((await post('/api/admin/branches', { code: 'HN', name: 'Dup', isActive: true, ous: [] })).body.error).toBe('code_taken');
  });

  it('rejects malformed DNs', async () => {
    const res = await post('/api/admin/branches', { code: 'X', name: 'X', isActive: true, ous: ['not a dn'] });
    expect(res.status).toBe(400);
  });

  it('un-maps computers when their OU is removed from the branch', async () => {
    const res = await put('/api/admin/branches/1', { code: 'HN', name: 'Ha Noi', isActive: true, ous: [] });
    expect(res.body.moved).toBe(1);
    expect((await asOwner('SELECT branch_id FROM computer WHERE id = 1'))[0].branch_id).toBeNull();
  });
});

describe('deleting a branch', () => {
  const del = (path, body) => admin.agent.delete(path).set('X-CSRF-Token', admin.csrf).send(body);

  it('needs the branch code typed back, then moves its computers to N/A and removes its grants', async () => {
    await addUser(pool, 'it.hn', [{ branchId: 1, role: 'it' }]);
    await addUser(pool, 'lead.both', [{ branchId: 1, role: 'lead' }, { branchId: 2, role: 'lead' }]);
    const preview = await admin.agent.get('/api/admin/branches/1/delete-preview');
    expect(preview.body.impact).toMatchObject({ computers: 1, grants: 2, users_left_without_role: ['it.hn'] });

    const wrong = await del('/api/admin/branches/1', { confirmCode: 'HCM' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe('confirm_mismatch');
    expect(await asOwner('SELECT id FROM branch WHERE id = 1')).toHaveLength(1);

    const ok = await del('/api/admin/branches/1', { confirmCode: 'hn' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ code: 'HN', computers: 1, toNa: 1, toOther: 0, grants: 2 });
    expect(await asOwner('SELECT id FROM branch WHERE id = 1')).toHaveLength(0);
    const [c] = await asOwner(`SELECT branch_id FROM computer WHERE name = 'HN-LT-0001'`);
    expect(c.branch_id).toBeNull();
    expect(await asOwner('SELECT 1 FROM recovery_key WHERE computer_id = 1')).toHaveLength(1); // keys stay
    expect(await asOwner('SELECT 1 FROM branch_ou WHERE branch_id = 1')).toHaveLength(0);
    const [log] = await asOwner(`SELECT detail FROM access_log WHERE action = 'admin_change' ORDER BY id DESC LIMIT 1`);
    expect(log.detail).toMatchObject({ op: 'delete_branch', branch: 'HN', computers: 1, grantsRemoved: 2, usersLeftWithoutRole: ['it.hn'] });
  });

  it('moves a computer to another branch when that branch owns a parent OU', async () => {
    await post('/api/admin/branches', { code: 'ROOT', name: 'Root', isActive: true, ous: ['OU=Computers,OU=HN,DC=corp,DC=local'.replace('OU=Computers,', '')] });
    const res = await del('/api/admin/branches/1', { confirmCode: 'HN' });
    expect(res.body).toMatchObject({ toNa: 0, toOther: 1 });
    const [c] = await asOwner(`SELECT b.code FROM computer c JOIN branch b ON b.id = c.branch_id WHERE c.name = 'HN-LT-0001'`);
    expect(c.code).toBe('ROOT');
  });

  it('shows a confirmation page before deleting from the web', async () => {
    const web = await webLogin(app, 'admin.hq');
    const page = await web.agent.get('/admin/branches/2/delete');
    expect(page.status).toBe(200);
    expect(page.text).toContain('không hoàn tác được');
    expect(page.text).toContain('name="confirmCode"');
    expect((await web.agent.get('/admin/branches')).text).toContain('/admin/branches/2/delete');
  });
});

describe('users', () => {
  it('requires a valid e-mail, stored in lower case', async () => {
    const body = { username: 'it.hn', displayName: 'IT HN', authSource: 'local', grants: ['it:1'] };
    expect((await post('/api/admin/users', body)).status).toBe(400);
    const bad = await post('/api/admin/users', { ...body, email: 'not-an-email' });
    expect(bad.body.fields).toEqual([{ field: 'email', message: 'invalid_email' }]);
    const ok = await post('/api/admin/users', { ...body, email: 'IT.HN@Corp.Local' });
    expect(ok.status).toBe(201);
    expect((await asOwner(`SELECT email FROM app_user WHERE username = 'it.hn'`))[0].email).toBe('it.hn@corp.local');
  });

  it('creates a user with a one-time password that must be changed at first sign-in', async () => {
    const res = await post('/api/admin/users', { username: 'it.hn', displayName: 'IT HN', email: 'it.hn@corp.local', authSource: 'local', grants: ['it:1'] });
    expect(res.status).toBe(201);
    const login = await request(app).post('/api/auth/login').send({ username: 'it.hn', password: res.body.oneTimePassword });
    expect(login.body.mustChangePassword).toBe(true);
    const [row] = await asOwner(`SELECT detail FROM access_log WHERE action = 'admin_change'`);
    expect(JSON.stringify(row)).not.toContain(res.body.oneTimePassword);
  });

  it('refuses to remove the last admin or lock yourself out', async () => {
    const [me] = await asOwner(`SELECT id FROM app_user WHERE username = 'admin.hq'`);
    const res = await put(`/api/admin/users/${me.id}`, { displayName: 'A', email: 'a@corp.local', isActive: true, grants: [] });
    expect(res.body.error).toBe('self_lockout');

    const other = await post('/api/admin/users', { username: 'admin2', displayName: 'A2', email: 'a2@corp.local', authSource: 'local', grants: ['admin:all'] });
    expect((await put(`/api/admin/users/${other.body.id}`, { displayName: 'A2', email: 'a2@corp.local', isActive: false, grants: ['admin:all'] })).status).toBe(200);
  });

  it('applies role changes on the user next request', async () => {
    const created = await post('/api/admin/users', { username: 'lead.hn', displayName: 'Lead', email: 'lead@corp.local', authSource: 'local', grants: ['lead:1'] });
    await pool.query('UPDATE app_user SET must_change_password = false WHERE id = $1', [created.body.id]);
    const lead = await apiLogin(app, 'lead.hn', created.body.oneTimePassword);
    expect((await lead.agent.get('/api/audit')).status).toBe(200);
    await put(`/api/admin/users/${created.body.id}`, { displayName: 'Lead', email: 'lead@corp.local', isActive: true, grants: ['it:1'] });
    expect((await lead.agent.get('/api/audit')).status).toBe(403);
  });

  it('keeps non-admins out of every admin endpoint', async () => {
    await addUser(pool, 'it.hn', [{ branchId: 1, role: 'it' }]);
    const it = await apiLogin(app, 'it.hn');
    for (const path of ['/api/admin/users', '/api/admin/branches', '/api/admin/sync', '/api/admin/branches/1/delete-preview']) {
      expect((await it.agent.get(path)).status).toBe(403);
    }
  });

  it('lets only Admin HQ change or delete branches and OUs (a lead or auditor gets 403, nothing changes)', async () => {
    await addUser(pool, 'lead.hn', [{ branchId: 1, role: 'lead' }]);
    await addUser(pool, 'auditor', [{ branchId: 1, role: 'auditor' }, { branchId: 2, role: 'auditor' }]);
    for (const name of ['lead.hn', 'auditor']) {
      const u = await apiLogin(app, name);
      const send = (method, path, body) => u.agent[method](path).set('X-CSRF-Token', u.csrf).send(body);
      expect((await send('post', '/api/admin/branches', { code: 'X', name: 'X', isActive: true, ous: [] })).status).toBe(403);
      expect((await send('put', '/api/admin/branches/1', { code: 'HN', name: 'HN', isActive: true, ous: [] })).status).toBe(403);
      expect((await send('post', '/api/admin/branches/preview', { ous: ['OU=Servers,DC=corp,DC=local'] })).status).toBe(403);
      expect((await send('delete', '/api/admin/branches/1', { confirmCode: 'HN' })).status).toBe(403);
    }
    expect(await asOwner('SELECT root_dn FROM branch_ou WHERE branch_id = 1')).toHaveLength(1);
    expect(await asOwner('SELECT id FROM branch')).toHaveLength(2);
    const web = await webLogin(app, 'lead.hn');
    expect((await web.agent.get('/admin/branches/1/delete')).status).toBe(403);
    expect((await web.agent.get('/admin/branches/1/edit')).status).toBe(403);
  });
});


describe('only Admin HQ covers all branches', () => {
  it('refuses an all-branch grant for any other role (API, form, database)', async () => {
    await addUser(pool, 'boss', [{ branchId: null, role: 'admin' }]);
    const { agent, csrf } = await apiLogin(app, 'boss');
    for (const g of ['auditor:all', 'it:all', 'lead:all']) {
      const res = await agent.post('/api/admin/users').set('X-CSRF-Token', csrf)
        .send({ username: `u-${g.split(':')[0]}`, displayName: 'U', email: 'u@corp.local', authSource: 'local', grants: [g] });
      expect(res.status).toBe(400);
    }
    await expect(asOwner(`INSERT INTO user_grant (user_id, branch_id, role) SELECT id, NULL, 'auditor' FROM app_user WHERE username = 'boss'`))
      .rejects.toThrow(/user_grant_all_branches_admin_only/);
  });
});
