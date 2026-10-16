import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appPool, asOwner, PWD, resetDatabase, seedTwoBranches } from './db.js';
import request from 'supertest';
import { addUser, apiLogin, buildApp } from './app.js';

// Seed: branch 1 = HN (computer 1, key aaaaaaaa-…), branch 2 = HCM (computer 2, key bbbbbbbb-…),
// computer 3 unmapped (key cccccccc-…).
const KEY_HN = 'aaaaaaaa-0000-0000-0000-000000000001';
const KEY_HCM = 'bbbbbbbb-0000-0000-0000-000000000002';
const KEY_UNMAPPED = 'cccccccc-0000-0000-0000-000000000003';
const reason = { reason: 'user_locked_out' };

let pool;
let app;
let sent;
let services;
let ingestApp;

beforeAll(() => {
  pool = appPool();
  ({ app, sent, services, ingestApp } = buildApp(pool));
});
afterAll(() => pool?.end());
beforeEach(async () => {
  await resetDatabase();
  await seedTwoBranches();
  sent.length = 0;
  await addUser(pool, 'it.hn', [{ branchId: 1, role: 'it' }]);
  await addUser(pool, 'admin.hq', [{ branchId: null, role: 'admin' }]);
  await addUser(pool, 'auditor', [{ branchId: 1, role: 'auditor' }, { branchId: 2, role: 'auditor' }]);
  // No alerts for working hours in tests: every hour of every day counts as working time.
  await services.settings.set('reveal.working_hours', { tz: 'UTC', days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '24:00' });
});

describe('search and computer details (branch isolation)', () => {
  it('finds a key by its 8-character prefix only inside the user branch', async () => {
    const { agent } = await apiLogin(app, 'it.hn');
    const own = await agent.get('/api/keys/search').query({ keyId: 'aaaaaaaa' });
    expect(own.body).toMatchObject({ kind: 'key', total: 1 });
    const other = await agent.get('/api/keys/search').query({ keyId: 'BBBBBBBB' });
    expect(other.body.total).toBe(0);
  });

  it('answers 404, not 403, for a computer of another branch (existence not revealed)', async () => {
    const { agent } = await apiLogin(app, 'it.hn');
    expect((await agent.get('/api/computers/1')).status).toBe(200);
    const res = await agent.get('/api/computers/2');
    expect(res.status).toBe(404);
    expect((await agent.get('/api/computers/999')).body).toEqual(res.body);
  });

  it('never returns key values in metadata responses', async () => {
    const { agent } = await apiLogin(app, 'admin.hq');
    const detail = await agent.get('/api/computers/1');
    const search = await agent.get('/api/computers').query({ q: 'HN' });
    expect(JSON.stringify([detail.body, search.body])).not.toContain(PWD(1));
  });

  it('shows unmapped computers to Admin HQ only', async () => {
    const it = await apiLogin(app, 'it.hn');
    const admin = await apiLogin(app, 'admin.hq');
    expect((await it.agent.get('/api/keys/search').query({ keyId: 'cccccccc' })).body.total).toBe(0);
    expect((await admin.agent.get('/api/keys/search').query({ keyId: 'cccccccc' })).body.total).toBe(1);
  });
});

describe('reveal', () => {
  it('returns the key, logs it in the same transaction and records when it was revealed', async () => {
    const { agent, csrf } = await apiLogin(app, 'it.hn');
    const res = await agent.post(`/api/keys/${KEY_HN}/reveal`).set('X-CSRF-Token', csrf).send({ ...reason, ticketNo: 'HD-1' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ recoveryPassword: PWD(1), expiresInSec: 60 });
    expect(res.headers['cache-control']).toMatch(/no-store/);

    const [log] = await asOwner(`SELECT * FROM access_log WHERE action = 'reveal'`);
    expect(log).toMatchObject({ user_upn: 'it.hn', reason: 'user_locked_out', ticket_no: 'HD-1', branch_id: 1 });
    expect(JSON.stringify(log)).not.toContain(PWD(1));
    const [key] = await asOwner(`SELECT status, last_revealed_at FROM recovery_key WHERE key_id = $1`, [KEY_HN]);
    expect(key.status).toBe('active'); // revealing no longer changes the status
    expect(key.last_revealed_at).not.toBeNull();
  });

  it('refuses another branch key with 404 and without logging a reveal', async () => {
    const { agent, csrf } = await apiLogin(app, 'it.hn');
    const res = await agent.post(`/api/keys/${KEY_HCM}/reveal`).set('X-CSRF-Token', csrf).send(reason);
    expect(res.status).toBe(404);
    expect(await asOwner(`SELECT * FROM access_log WHERE action = 'reveal'`)).toHaveLength(0);
    const [key] = await asOwner(`SELECT status FROM recovery_key WHERE key_id = $1`, [KEY_HCM]);
    expect(key.status).toBe('active');
  });

  it('requires a valid reason, and a note for "other"', async () => {
    const { agent, csrf } = await apiLogin(app, 'it.hn');
    const post = (body) => agent.post(`/api/keys/${KEY_HN}/reveal`).set('X-CSRF-Token', csrf).send(body);
    expect((await post({})).status).toBe(400);
    expect((await post({ reason: 'because' })).body.error).toBe('invalid_reason');
    expect((await post({ reason: 'other' })).body.error).toBe('invalid_reason');
    expect((await post({ reason: 'other' })).body.message).toBe('The reason "other" needs a note.'); // API speaks English
    expect((await post({ reason: 'other', reasonNote: 'Ổ cứng chuyển sang máy khác' })).status).toBe(200);
  });

  it('requires a ticket when the setting says so', async () => {
    await services.settings.set('reveal.ticket_required', true);
    const { agent, csrf } = await apiLogin(app, 'it.hn');
    expect((await agent.post(`/api/keys/${KEY_HN}/reveal`).set('X-CSRF-Token', csrf).send(reason)).body.error).toBe('ticket_required');
  });

  it('never lets an auditor reveal', async () => {
    const { agent, csrf } = await apiLogin(app, 'auditor');
    expect((await agent.post(`/api/keys/${KEY_HN}/reveal`).set('X-CSRF-Token', csrf).send(reason)).status).toBe(403);
  });

  it('has no limit on how many keys a user reveals, and logs every one', async () => {
    const { agent, csrf } = await apiLogin(app, 'admin.hq');
    const results = await Promise.all(
      Array.from({ length: 25 }, () => agent.post(`/api/keys/${KEY_UNMAPPED}/reveal`).set('X-CSRF-Token', csrf).send(reason)),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    const [row] = await asOwner(`SELECT count(*)::int AS n FROM access_log WHERE action = 'reveal'`);
    expect(row.n).toBe(25);
  });

  it('alerts when a key is revealed outside working hours', async () => {
    await services.settings.set('reveal.working_hours', { tz: 'UTC', days: [], start: '08:00', end: '18:00' });
    const { agent, csrf } = await apiLogin(app, 'it.hn');
    await agent.post(`/api/keys/${KEY_HN}/reveal`).set('X-CSRF-Token', csrf).send(reason);
    expect(sent.map((m) => m.subject).join()).toContain('ngoài giờ làm việc');
  });

});

describe('audit log access', () => {
  it('lets an auditor read and export the log, which never contains a key', async () => {
    const it = await apiLogin(app, 'it.hn');
    await it.agent.post(`/api/keys/${KEY_HN}/reveal`).set('X-CSRF-Token', it.csrf).send(reason);
    const { agent } = await apiLogin(app, 'auditor');
    const list = await agent.get('/api/audit').query({ action: 'reveal' });
    expect(list.body.total).toBe(1);
    const csv = await agent.get('/api/audit').query({ format: 'csv' });
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toContain('reveal');
    expect(csv.text).not.toContain(PWD(1));
    expect((await asOwner(`SELECT count(*)::int AS n FROM access_log WHERE action = 'export_log'`))[0].n).toBe(1);
  });

  it('keeps IT staff out of the log', async () => {
    const { agent } = await apiLogin(app, 'it.hn');
    expect((await agent.get('/api/audit')).status).toBe(403);
  });
});

describe('computer info typed by IT (serial, user e-mail)', () => {
  const put = async (user, computerId, body) => {
    const { agent, csrf } = await apiLogin(app, user);
    return agent.put(`/api/computers/${computerId}/info`).set('X-CSRF-Token', csrf).send(body);
  };

  it('is empty by default, editable in scope, cleared by an empty value, and logged', async () => {
    const { agent } = await apiLogin(app, 'it.hn');
    expect((await agent.get('/api/computers/1')).body.computer).toMatchObject({ device_serial: null, owner_email: null });

    const saved = await put('it.hn', 1, { deviceSerial: '5CG1234XYZ', ownerEmail: 'NguyenVanA@Corp.Local' });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ computerId: 1, deviceSerial: '5CG1234XYZ', ownerEmail: 'nguyenvana@corp.local' });
    expect((await agent.get('/api/computers/1')).body.computer).toMatchObject({ device_serial: '5CG1234XYZ', info_updated_by: 'it.hn' });

    await put('it.hn', 1, { deviceSerial: '', ownerEmail: 'nguyenvana@corp.local' });
    expect((await agent.get('/api/computers/1')).body.computer).toMatchObject({ device_serial: null, owner_email: 'nguyenvana@corp.local' });

    const logs = await asOwner(`SELECT user_upn, computer_id, detail FROM access_log WHERE action = 'computer_edit' ORDER BY id`);
    expect(logs).toHaveLength(2);
    expect(logs[1].detail).toEqual({
      before: { deviceSerial: '5CG1234XYZ', ownerEmail: 'nguyenvana@corp.local' },
      after: { deviceSerial: null, ownerEmail: 'nguyenvana@corp.local' },
    });
  });

  it('refuses computers outside the scope, roles without key access, and a bad e-mail', async () => {
    expect((await put('it.hn', 2, { deviceSerial: 'x' })).status).toBe(404);
    expect((await put('auditor', 1, { deviceSerial: 'x' })).status).toBe(403);
    expect((await put('it.hn', 1, { ownerEmail: 'not-an-email' })).body.fields).toEqual([{ field: 'ownerEmail', message: 'invalid_email' }]);
  });

  it('is never overwritten by a sync of the same computer', async () => {
    await put('admin.hq', 1, { deviceSerial: 'SN-1', ownerEmail: 'a@corp.local' });
    const ingest = () => request(ingestApp);
    const { runId } = (await ingest().post('/api/ingest/sync-runs').send({ mode: 'full', dcName: 'DC01' })).body;
    await ingest().post('/api/ingest/computers').send({ runId, items: [{
      objectGuid: '00000000-0000-0000-0000-000000000001', name: 'HN-LT-0001', dn: 'CN=HN-LT-0001,OU=Computers,OU=HN,DC=corp,DC=local', os: 'Windows 11',
    }] });
    const [c] = await asOwner(`SELECT os, device_serial, owner_email FROM computer WHERE id = 1`);
    expect(c).toEqual({ os: 'Windows 11', device_serial: 'SN-1', owner_email: 'a@corp.local' });
  });

  it('shows the fields and an edit button in the computer information', async () => {
    await put('it.hn', 1, { deviceSerial: 'SN-42' });
    const { agent } = await (await import('./app.js')).webLogin(app, 'it.hn');
    const page = await agent.get('/computers/1');
    expect(page.text).toContain('<dt>Serial máy</dt><dd><code>SN-42</code></dd>');
    expect(page.text).toContain('href="/computers/1/edit"');
    expect((await agent.get('/computers/1/edit')).status).toBe(200);
  });
});

describe('search by machine serial and user e-mail', () => {
  const search = async (user, q) => (await (await apiLogin(app, user)).agent.get('/api/computers').query({ q })).body;

  it('finds a computer by the start of its serial or user e-mail, any case, only in scope', async () => {
    await asOwner(`UPDATE computer SET device_serial = 'ABCDEF12', owner_email = 'nguyen_van.a@corp.local' WHERE id = 1;
                   UPDATE computer SET device_serial = '5CG9999', owner_email = 'tran.b@corp.local' WHERE id = 2;`);
    expect((await search('it.hn', '5cg')).rows).toEqual([]); // HCM computer: out of scope
    expect((await search('admin.hq', '5cg')).rows.map((r) => r.name)).toEqual(['HCM-LT-0001']);
    expect((await search('it.hn', 'NGUYEN_VAN')).rows.map((r) => r.name)).toEqual(['HN-LT-0001']);
    expect((await search('it.hn', 'nguyenXvan')).rows).toEqual([]); // "_" is not a wildcard
    // 8 hex characters with no matching Key ID: searched as a serial too.
    const byHexSerial = await search('it.hn', 'abcdef12');
    expect(byHexSerial.kind).toBe('name');
    expect(byHexSerial.rows.map((r) => r.device_serial)).toEqual(['ABCDEF12']);
    // A real Key ID prefix still finds the key.
    expect((await search('it.hn', 'aaaaaaaa')).kind).toBe('key');
  });

  it('finds a part of the name anywhere (from 3 characters), ignoring case and - _ . and spaces', async () => {
    const names = async (q, user = 'admin.hq') => (await search(user, q)).rows.map((r) => r.name);
    expect(await names('LT-0001')).toEqual(['HCM-LT-0001', 'HN-LT-0001']); // in the middle
    expect(await names('lt0001')).toEqual(['HCM-LT-0001', 'HN-LT-0001']); // no dash
    expect(await names('hn lt')).toEqual(['HN-LT-0001']);
    expect(await names('srv')).toEqual(['SRV-0001']);
    expect(await names('01')).toEqual([]); // 2 characters: start of the value only
    expect(await names('hn')).toEqual(['HN-LT-0001']); // ... which works
    expect(await names('LT-0001', 'it.hn')).toEqual(['HN-LT-0001']); // still only in scope
  });

  it('puts the exact match first, then names that start with the text, then the others', async () => {
    await asOwner(`
      INSERT INTO computer (object_guid, name, distinguished_name, branch_id) VALUES
        (gen_random_uuid(), 'PC-ABC', 'CN=PC-ABC,OU=Computers,OU=HN,DC=corp,DC=local', 1),
        (gen_random_uuid(), 'ABC', 'CN=ABC,OU=Computers,OU=HN,DC=corp,DC=local', 1),
        (gen_random_uuid(), 'ABC-2', 'CN=ABC-2,OU=Computers,OU=HN,DC=corp,DC=local', 1);`);
    expect((await search('it.hn', 'abc')).rows.map((r) => r.name)).toEqual(['ABC', 'ABC-2', 'PC-ABC']);
  });

  it('says what matched when it is not the name', async () => {
    await asOwner(`UPDATE computer SET device_serial = '5CG-777-XYZ' WHERE id = 1`);
    const r = await search('it.hn', '777xyz');
    expect(r.rows.map((x) => [x.name, x.matched_on])).toEqual([['HN-LT-0001', 'serial']]);
  });

  it('finds a key from its first 4 characters, and shows computers matching as text alongside', async () => {
    const r = await search('it.hn', 'aaaa');
    expect(r).toMatchObject({ kind: 'key', total: 1 });
    expect(r.rows[0].key_id).toBe('aaaaaaaa-0000-0000-0000-000000000001');
    expect((await search('it.hn', 'AAAAAAAA-00')).total).toBe(1); // longer prefixes too
    expect((await search('it.hn', 'aaa')).kind).toBe('name'); // 3: not a Key ID
    // Dashes are optional: a pasted Key ID without them, or a prefix past the first 8.
    expect((await search('it.hn', 'aaaaaaaa000000000000000000000001')).total).toBe(1);
    expect((await search('it.hn', '{AAAAAAAA0000}')).total).toBe(1);
    // Hex digits that are also part of a name: both lists.
    await asOwner(`UPDATE computer SET name = 'HN-AAAA-PC' WHERE id = 1`);
    const both = await search('it.hn', 'aaaa');
    expect(both.kind).toBe('key');
    expect(both.computers.rows.map((x) => x.name)).toEqual(['HN-AAAA-PC']);
  });
});
