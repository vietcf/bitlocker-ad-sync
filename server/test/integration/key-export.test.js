import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appPool, asOwner, PWD, resetDatabase, seedTwoBranches } from './db.js';
import { addUser, apiLogin, buildApp, csrfFrom, webLogin } from './app.js';

let pool;
let app;
let services;
let sent;

beforeAll(() => {
  pool = appPool();
  ({ app, services, sent } = buildApp(pool));
});
afterAll(() => pool?.end());
beforeEach(async () => {
  await resetDatabase();
  services.settings.invalidate();
  sent.length = 0;
  await seedTwoBranches(); // HN-LT-0001 (HN, key PWD(1)), HCM-LT-0001 (HCM, key PWD(2)), SRV-0001 (unmapped)
  await addUser(pool, 'it.hn', [{ branchId: 1, role: 'it' }]);
  await addUser(pool, 'admin.hq', [{ branchId: null, role: 'admin' }]);
  await addUser(pool, 'auditor', [{ branchId: 1, role: 'auditor' }, { branchId: 2, role: 'auditor' }]);
});

const setMode = async (mode) => {
  await asOwner(`INSERT INTO app_setting (key, value) VALUES ('export.keys', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(mode)]);
  services.settings.invalidate();
};
const reason = { reason: 'disk_recovery', ticketNo: 'INC-42' };
const exportApi = async (user, body = {}) => {
  const { agent, csrf } = await apiLogin(app, user);
  return agent.post('/api/keys/export').set('X-CSRF-Token', csrf).send({ ...reason, ...body });
};

describe('key export', () => {
  it('is off by default', async () => {
    const res = await exportApi('admin.hq');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('feature_disabled');
    expect((await (await webLogin(app, 'admin.hq')).agent.get('/')).text).not.toContain('Xuất kèm key');
  });

  it('lets IT export the keys of their own branch, logs every key as a reveal, and alerts', async () => {
    await setMode('all');
    const res = await exportApi('it.hn');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    const lines = res.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('computer,computer_object_guid,branch,distinguished_name,in_ad,key_id,volume_guid,device_serial,owner_email,status,key_created_utc,key_recorded_utc,recovery_password');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('HN-LT-0001');
    expect(lines[1]).toContain(PWD(1));
    expect(res.text).not.toContain(PWD(2)); // HCM is outside the scope

    const logs = await asOwner(`SELECT action, user_upn, key_id, reason, ticket_no, detail FROM access_log WHERE action IN ('reveal', 'export_keys') ORDER BY id`);
    expect(logs).toEqual([
      { action: 'reveal', user_upn: 'it.hn', key_id: 'aaaaaaaa-0000-0000-0000-000000000001', reason: 'disk_recovery', ticket_no: 'INC-42', detail: { export: true } },
      expect.objectContaining({ action: 'export_keys', user_upn: 'it.hn', detail: expect.objectContaining({ keys: 1, computers: 1 }) }),
    ]);
    expect(JSON.stringify(logs)).not.toContain(PWD(1));
    expect((await asOwner(`SELECT last_revealed_at IS NOT NULL AS seen FROM recovery_key ORDER BY id`)).map((r) => r.seen)).toEqual([true, false, false]);
    expect(sent).toEqual([expect.objectContaining({ type: 'key_export', severity: 'high' })]);
    expect(JSON.stringify(sent)).not.toContain(PWD(1));
  });

  it('follows the list filters and lets Admin HQ export every branch', async () => {
    await setMode('admin');
    expect((await exportApi('it.hn')).status).toBe(403);
    const all = await exportApi('admin.hq');
    expect(all.text).toContain(PWD(1));
    expect(all.text).toContain(PWD(2));
    const hcm = await exportApi('admin.hq', { branchId: 2 });
    expect(hcm.text).not.toContain(PWD(1));
    expect(hcm.text).toContain(PWD(2));
  });

  it('needs a valid reason, and is never open to roles without key access', async () => {
    await setMode('all');
    expect((await exportApi('it.hn', { reason: 'because' })).body.error).toBe('invalid_reason');
    expect((await exportApi('it.hn', { reason: 'other' })).body.error).toBe('invalid_reason');
    expect((await exportApi('auditor')).status).toBe(403);
    expect((await asOwner(`SELECT count(*)::int AS n FROM access_log WHERE action IN ('reveal', 'export_keys')`))[0].n).toBe(0);
  });

  it('works from the web: button, form with the count, then the CSV download', async () => {
    await setMode('all');
    const { agent } = await webLogin(app, 'it.hn');
    expect((await agent.get('/')).text).toContain('href="/computers/export-keys');
    const form = await agent.get('/computers/export-keys');
    expect(form.status).toBe(200);
    expect(form.text).toMatch(/<strong>1 key<\/strong>\s*trên <strong>1 máy<\/strong>/);
    const csrf = csrfFrom(form.text);
    const missing = await agent.post('/computers/export-keys').type('form').send({ _csrf: csrf, status: 'all' });
    expect(missing.status).toBe(400);
    expect(missing.text).toContain('Xuất kèm recovery key');
    const ok = await agent.post('/computers/export-keys').type('form').send({ _csrf: csrf, status: 'all', reason: 'disk_recovery' });
    expect(ok.headers['content-disposition']).toMatch(/recovery-keys-/);
    expect(ok.text).toContain(PWD(1));
  });
});
