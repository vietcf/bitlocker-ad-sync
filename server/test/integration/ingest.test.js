import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { appPool, asOwner, PWD, resetDatabase } from './db.js';
import { addUser, apiLogin, buildApp, webLogin } from './app.js';
import { runSyncWatchdog } from '../../src/jobs/watchdog.js';

let pool;
let app;
let ingestApp;
let services;
let sent;

beforeAll(() => {
  pool = appPool();
  ({ app, ingestApp, services, sent } = buildApp(pool));
});
afterAll(() => pool?.end());
beforeEach(async () => {
  await resetDatabase();
  sent.length = 0;
  await asOwner(`
    INSERT INTO branch (code, name) VALUES ('HN', 'Ha Noi'), ('HCM', 'Ho Chi Minh');
    INSERT INTO branch_ou (branch_id, root_dn) VALUES (1, 'ou=computers,ou=hn,dc=corp,dc=local'), (2, 'ou=computers,ou=hcm,dc=corp,dc=local');`);
});

const ingest = () => request(ingestApp);
const guid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const keyGuid = (n) => `0000${String(n).padStart(4, '0')}-1111-4000-8000-000000000000`;
const dn = (n, branch = 'HN') => `CN=PC-${n},OU=Laptops,OU=Computers,OU=${branch},DC=corp,DC=local`;
const computer = (n, branch) => ({ objectGuid: guid(n), name: `PC-${n}`, dn: dn(n, branch), os: 'Windows 11', whenCreated: '2025-01-01T00:00:00Z' });
const key = (n, pcN, branch, when = '2025-06-01T00:00:00Z') => ({
  keyId: keyGuid(n),
  dn: `CN={${keyGuid(n).toUpperCase()}},${dn(pcN, branch)}`,
  recoveryPassword: PWD(n),
  whenCreated: when,
});

/** One complete run through the ingest API. */
async function runSync({ mode = 'full', dc = 'DC01', computers = [], keys = [], keysSeen = keys.length }) {
  const open = await ingest().post('/api/ingest/sync-runs').send({ mode, dcName: dc });
  expect(open.status).toBe(201);
  const { runId } = open.body;
  if (computers.length) expect((await ingest().post('/api/ingest/computers').send({ runId, items: computers })).status).toBe(200);
  let keysRes = null;
  if (keys.length) keysRes = (await ingest().post('/api/ingest/keys').send({ runId, items: keys })).body;
  const done = await ingest().post(`/api/ingest/sync-runs/${runId}/complete`).send({ status: 'success', highestUsn: 1000 + runId, keysSeen, dcHighestUsn: 5000 + runId });
  return { runId, open: open.body, keys: keysRes, done: done.body };
}

const tenComputers = (branch = 'HN', from = 1) => Array.from({ length: 10 }, (_, i) => computer(from + i, branch));

describe('ingest', () => {
  it('maps computers to branches by OU and stores their keys', async () => {
    const r = await runSync({ computers: [computer(1, 'HN'), computer(2, 'HCM'), { ...computer(3), dn: 'CN=SRV,OU=Servers,DC=corp,DC=local' }], keys: [key(1, 1, 'HN')] });
    expect(r.done.status).toBe('success');
    const rows = await asOwner('SELECT name, branch_id FROM computer ORDER BY name');
    expect(rows).toEqual([{ name: 'PC-1', branch_id: 1 }, { name: 'PC-2', branch_id: 2 }, { name: 'PC-3', branch_id: null }]);
    expect((await asOwner('SELECT count(*)::int AS n FROM recovery_key'))[0].n).toBe(1);
  });

  it('is idempotent: sending the same batches twice creates no duplicates', async () => {
    const batch = { computers: [computer(1)], keys: [key(1, 1)] };
    await runSync(batch);
    const second = await runSync(batch);
    expect(second.keys).toMatchObject({ inserted: 0, skipped: 1 });
    expect((await asOwner('SELECT count(*)::int AS n FROM computer'))[0].n).toBe(1);
  });

  it('never overwrites a key; a newer key supersedes the older one', async () => {
    await runSync({ computers: [computer(1)], keys: [key(1, 1)] });
    await runSync({ computers: [computer(1)], keys: [key(1, 1), key(3, 1, 'HN', '2025-09-01T00:00:00Z')] });
    const status = Object.fromEntries((await asOwner('SELECT key_id, status FROM recovery_key')).map((r) => [r.key_id, r.status]));
    expect(status[keyGuid(1)]).toBe('superseded');
    expect(status[keyGuid(3)]).toBe('active');
  });

  it('keeps one active key per volume: a new key for D: does not supersede the key for C:', async () => {
    const C = 'c0000000-0000-4000-8000-000000000001';
    const D = 'd0000000-0000-4000-8000-000000000002';
    await runSync({ computers: [computer(1)], keys: [{ ...key(1, 1), volumeGuid: C }] });
    await runSync({ computers: [computer(1)], keys: [{ ...key(1, 1), volumeGuid: C }, { ...key(2, 1, 'HN', '2025-08-01T00:00:00Z'), volumeGuid: D }] });
    let status = Object.fromEntries((await asOwner('SELECT key_id, status FROM recovery_key')).map((r) => [r.key_id, r.status]));
    expect(status).toEqual({ [keyGuid(1)]: 'active', [keyGuid(2)]: 'active' });

    await runSync({ computers: [computer(1)], keys: [{ ...key(3, 1, 'HN', '2025-09-01T00:00:00Z'), volumeGuid: D }] });
    status = Object.fromEntries((await asOwner('SELECT key_id, status FROM recovery_key')).map((r) => [r.key_id, r.status]));
    expect(status).toEqual({ [keyGuid(1)]: 'active', [keyGuid(2)]: 'superseded', [keyGuid(3)]: 'active' });
  });

  it('fills in the volume of keys stored without one and recomputes their status', async () => {
    const C = 'c0000000-0000-4000-8000-000000000001';
    const D = 'd0000000-0000-4000-8000-000000000002';
    // Stored before volumes were tracked: the older key looks superseded.
    await runSync({ computers: [computer(1)], keys: [key(1, 1), key(2, 1, 'HN', '2025-08-01T00:00:00Z')] });
    expect((await asOwner(`SELECT status FROM recovery_key WHERE key_id = '${keyGuid(1)}'`))[0].status).toBe('superseded');

    const r = await runSync({ computers: [computer(1)], keys: [{ ...key(1, 1), volumeGuid: C }, { ...key(2, 1, 'HN', '2025-08-01T00:00:00Z'), volumeGuid: D }] });
    expect(r.keys).toMatchObject({ inserted: 0, skipped: 2 });
    const rows = await asOwner('SELECT key_id, volume_guid, status, recovery_password FROM recovery_key ORDER BY key_id');
    expect(rows.map((k) => [k.volume_guid, k.status])).toEqual([[C, 'active'], [D, 'active']]);
    expect(rows[0].recovery_password).toBe(PWD(1)); // the key itself is never overwritten
  });

  it('returns keys whose computer is unknown as orphans', async () => {
    const r = await runSync({ computers: [computer(1)], keys: [key(9, 99)] });
    expect(r.keys.orphans).toEqual([keyGuid(9)]);
  });

  it('logs a computer moving to another branch', async () => {
    await runSync({ computers: [computer(1, 'HN')] });
    await runSync({ computers: [computer(1, 'HCM')] });
    const [log] = await asOwner(`SELECT branch_id, detail FROM access_log WHERE action = 'computer_moved'`);
    expect(log).toMatchObject({ branch_id: 2, detail: { fromBranchId: 1, toBranchId: 2 } });
  });

  it('turns a delta against another DC into a full run', async () => {
    await runSync({ dc: 'DC01', computers: [computer(1)] });
    const delta = await ingest().post('/api/ingest/sync-runs').send({ mode: 'delta', dcName: 'DC02' });
    expect(delta.body).toMatchObject({ mode: 'full', sinceUsn: 0 });
  });

  it('refuses a second run while one is open', async () => {
    await ingest().post('/api/ingest/sync-runs').send({ mode: 'full', dcName: 'DC01' });
    expect((await ingest().post('/api/ingest/sync-runs').send({ mode: 'full', dcName: 'DC01' })).status).toBe(409);
  });

  it('marks computers missing from a clean full run as deleted, but keeps their keys', async () => {
    const all = [...tenComputers('HN', 1), ...tenComputers('HCM', 101), ...tenComputers('HN', 201)];
    await runSync({ computers: all, keys: [key(1, 1)] });
    const r = await runSync({ computers: all.slice(1), keysSeen: 1 }); // PC-1 gone: 1/30 = 3.3% < 5%
    expect(r.done).toMatchObject({ status: 'success', markedDeleted: 1 });
    expect((await asOwner(`SELECT deleted_in_ad_at FROM computer WHERE name = 'PC-1'`))[0].deleted_in_ad_at).not.toBeNull();
    expect((await asOwner('SELECT count(*)::int AS n FROM recovery_key'))[0].n).toBe(1);
  });
});

describe('real-life cases', () => {
  it('case 1: a renamed computer stays the same computer (same objectGUID): keys, history and IT notes kept', async () => {
    await runSync({ computers: [computer(1)], keys: [key(1, 1, 'HN')] });
    await asOwner(`UPDATE computer SET device_serial = 'SN-1' WHERE object_guid = '${guid(1)}'`);
    // Renamed in AD: PC-1 -> PC-1-NEW (same object, new name and DN)
    const renamed = { ...computer(1), name: 'PC-1-NEW', dn: 'CN=PC-1-NEW,OU=Laptops,OU=Computers,OU=HN,DC=corp,DC=local' };
    await runSync({ mode: 'delta', computers: [renamed], keys: [{ ...key(2, 1, 'HN', '2026-01-01T00:00:00Z'), dn: `CN={K2},${renamed.dn}` }] });

    const rows = await asOwner('SELECT id, name, distinguished_name, device_serial, deleted_in_ad_at FROM computer');
    expect(rows).toHaveLength(1); // no second computer
    expect(rows[0]).toMatchObject({ name: 'PC-1-NEW', device_serial: 'SN-1', deleted_in_ad_at: null });
    const keys = await asOwner('SELECT key_id, status, computer_id FROM recovery_key ORDER BY ad_created_at');
    expect(keys.map((k) => [k.key_id, k.status])).toEqual([[keyGuid(1), 'superseded'], [keyGuid(2), 'active']]);
    expect(new Set(keys.map((k) => k.computer_id)).size).toBe(1);
  });

  it('stores the last AD logon of a computer; a worker that does not send it keeps the stored value', async () => {
    await runSync({ computers: [{ ...computer(1), lastLogon: '2026-10-01T08:00:00Z' }] });
    const lastLogon = async () => (await asOwner('SELECT last_logon_at FROM computer'))[0].last_logon_at?.toISOString() ?? null;
    expect(await lastLogon()).toBe('2026-10-01T08:00:00.000Z');
    await runSync({ mode: 'delta', computers: [computer(1)] }); // older worker: no lastLogon in the item
    expect(await lastLogon()).toBe('2026-10-01T08:00:00.000Z');
    await runSync({ mode: 'delta', computers: [{ ...computer(1), lastLogon: '2026-10-15T08:00:00Z' }] });
    expect(await lastLogon()).toBe('2026-10-15T08:00:00.000Z');
  });

  it('case 2: a computer deleted and joined again with the same name is a new computer; old keys stay with the old one', async () => {
    await runSync({ computers: [computer(1), ...tenComputers('HN', 10), ...tenComputers('HN', 20), ...tenComputers('HN', 30)], keys: [key(1, 1, 'HN'), ...Array.from({ length: 30 }, (_, i) => key(100 + i, 10 + i, 'HN'))] });
    // Deleted from AD, then re-installed and joined with the same name: a NEW object (new objectGUID), same DN.
    const reinstalled = { ...computer(1), objectGuid: guid(99), whenCreated: '2026-02-01T00:00:00Z' };
    // The next run is a delta (the old object's deletion is not seen yet): both rows exist and are live.
    await runSync({ mode: 'delta', computers: [reinstalled], keys: [key(2, 1, 'HN', '2026-02-02T00:00:00Z')] });
    let rows = await asOwner(`SELECT id, object_guid, deleted_in_ad_at FROM computer WHERE name = 'PC-1' ORDER BY id`);
    expect(rows).toHaveLength(2);
    const [oldPc, newPc] = rows;
    const k = await asOwner(`SELECT key_id, computer_id, status FROM recovery_key WHERE key_id IN ('${keyGuid(1)}', '${keyGuid(2)}') ORDER BY ad_created_at`);
    expect(k).toEqual([
      { key_id: keyGuid(1), computer_id: oldPc.id, status: 'active' }, // the old disk's key, kept
      { key_id: keyGuid(2), computer_id: newPc.id, status: 'active' }, // the new key goes to the NEW computer
    ]);

    // The next full run no longer sees the old object: it is marked "not in AD", its keys stay.
    await runSync({ computers: [reinstalled, ...tenComputers('HN', 10), ...tenComputers('HN', 20), ...tenComputers('HN', 30)], keys: [key(2, 1, 'HN', '2026-02-02T00:00:00Z'), ...Array.from({ length: 30 }, (_, i) => key(100 + i, 10 + i, 'HN'))] });
    rows = await asOwner(`SELECT object_guid, deleted_in_ad_at IS NOT NULL AS gone FROM computer WHERE name = 'PC-1' ORDER BY id`);
    expect(rows).toEqual([{ object_guid: guid(1), gone: true }, { object_guid: guid(99), gone: false }]);
    expect((await asOwner('SELECT count(*)::int AS n FROM recovery_key'))[0].n).toBe(32);

    // A key pushed later for that name still goes to the live computer, not the deleted one.
    await runSync({ mode: 'delta', computers: [], keys: [key(3, 1, 'HN', '2026-03-01T00:00:00Z')] });
    const [k3] = await asOwner(`SELECT computer_id FROM recovery_key WHERE key_id = '${keyGuid(3)}'`);
    expect(k3.computer_id).toBe(newPc.id);
  });

  it('links a key by the computer objectGUID when the worker sends it, whatever the DN says', async () => {
    await runSync({ computers: [computer(1)] });
    const reinstalled = { ...computer(1), objectGuid: guid(99) }; // same name and DN, new AD object
    await runSync({ mode: 'delta', computers: [reinstalled] });
    const [oldPc, newPc] = await asOwner(`SELECT id FROM computer WHERE name = 'PC-1' ORDER BY id`);
    const r = await runSync({ mode: 'delta', keys: [
      { ...key(5, 1, 'HN'), computerObjectGuid: guid(1) },   // explicitly the OLD object
      { ...key(6, 1, 'HN'), computerObjectGuid: guid(99) },  // the new one
      { ...key(7, 1, 'HN'), computerObjectGuid: guid(555) }, // unknown objectGUID: orphan, even though the DN exists
    ] });
    expect(r.keys.orphans).toEqual([keyGuid(7)]);
    const rows = await asOwner(`SELECT key_id, computer_id FROM recovery_key ORDER BY key_id`);
    expect(rows).toEqual([{ key_id: keyGuid(5), computer_id: oldPc.id }, { key_id: keyGuid(6), computer_id: newPc.id }]);
  });

  it('case 3: a new key for the same volume supersedes the old one; the old key is kept; the same key again changes nothing', async () => {
    const vol = '7c9e1f20-3b4a-4d5e-9f60-718293a4b5c6';
    await runSync({ computers: [computer(1)], keys: [{ ...key(1, 1, 'HN', '2025-06-01T00:00:00Z'), volumeGuid: vol }] });
    await runSync({ mode: 'delta', computers: [], keys: [{ ...key(2, 1, 'HN', '2026-10-15T06:22:39Z'), volumeGuid: vol }] });
    let keys = await asOwner('SELECT key_id, status, recovery_password FROM recovery_key ORDER BY ad_created_at');
    expect(keys.map((k) => [k.key_id, k.status])).toEqual([[keyGuid(1), 'superseded'], [keyGuid(2), 'active']]);
    expect(keys[0].recovery_password).toBe(PWD(1)); // old password still there (e.g. an old backup image)

    // manage-bde -adbackup of the same protector again: same Key ID -> nothing new, no duplicate
    const again = await runSync({ mode: 'delta', computers: [], keys: [{ ...key(2, 1, 'HN', '2026-10-15T06:22:39Z'), volumeGuid: vol }] });
    expect(again.keys).toMatchObject({ inserted: 0 });
    keys = await asOwner('SELECT count(*)::int AS n FROM recovery_key');
    expect(keys[0].n).toBe(2);
  });
});

describe('anomaly quarantine', () => {
  it('quarantines a full run that suddenly sees far fewer computers, then applies it only when accepted', async () => {
    const all = [...tenComputers('HN', 1), ...tenComputers('HCM', 101)];
    await runSync({ computers: all });
    const bad = await runSync({ computers: all.slice(0, 10) }); // the whole HCM OU vanished
    expect(bad.done.status).toBe('quarantined');
    expect(bad.done.anomalies.map((a) => a.code)).toEqual(expect.arrayContaining(['computers_drop', 'mass_delete']));
    expect((await asOwner('SELECT count(*)::int AS n FROM computer WHERE deleted_in_ad_at IS NOT NULL'))[0].n).toBe(0);
    expect(sent.some((m) => m.subject.includes('bị giữ lại'))).toBe(true);

    // The USN of a quarantined run is not used by the next delta.
    expect((await ingest().get('/api/ingest/sync-runs/last')).body.runId).not.toBe(bad.runId);

    await addUser(pool, 'admin.hq', [{ branchId: null, role: 'admin' }]);
    const { agent, csrf } = await apiLogin(app, 'admin.hq');
    const ack = await agent.post(`/api/admin/sync-runs/${bad.runId}/ack`).set('X-CSRF-Token', csrf).send({ decision: 'accept' });
    expect(ack.body).toMatchObject({ decision: 'accept', markedDeleted: 10, remaining: 0 });
    expect((await ingest().get('/api/ingest/sync-runs/last')).body.runId).toBe(bad.runId);
    expect(sent.some((m) => m.subject.includes('Đã xử lý: '))).toBe(true);
  });

  it('previews what accepting would change before the decision (web and API)', async () => {
    const all = [...tenComputers('HN', 1), ...tenComputers('HCM', 101)];
    await runSync({ computers: all, keys: [key(1, 101, 'HCM')] });
    const bad = await runSync({ computers: [...all.slice(0, 10), computer(500, 'HN')] }); // HCM vanished, one new HN computer
    await addUser(pool, 'admin.hq', [{ branchId: null, role: 'admin' }]);
    const { agent, csrf } = await apiLogin(app, 'admin.hq');
    const p = (await agent.get(`/api/admin/sync-runs/${bad.runId}`)).body;
    expect(p.waiting).toBe(true);
    expect(p.planned.total).toBe(10);
    expect(p.planned.byBranch).toEqual([{ branch_code: 'HCM', computers: 10, keys: 1 }]);
    expect(p.planned.rows.map((c) => c.name)).toContain('PC-101');
    expect(p.stored.computers).toMatchObject({ total: 1, rows: [expect.objectContaining({ name: 'PC-500' })] });
    expect((await asOwner('SELECT count(*)::int AS n FROM computer WHERE deleted_in_ad_at IS NOT NULL'))[0].n).toBe(0); // preview only

    const web = await webLogin(app, 'admin.hq');
    const list = (await web.agent.get('/admin/sync')).text;
    expect(list).toContain('Đang chờ quyết định');
    expect(list).toContain('Lượt full chỉ thấy'); // the overview stays in the note
    expect(list).toContain(`href="/admin/sync/runs/${bad.runId}"`); // details: click the run number
    expect(list).not.toContain(`/admin/sync/runs/${bad.runId}/ack`); // the decision is on the preview page
    const page = (await web.agent.get(`/admin/sync/runs/${bad.runId}`)).text;
    expect(page).toContain('Nếu chấp nhận');
    expect(page).toContain('PC-101');
    expect(page).toContain(`/admin/sync/runs/${bad.runId}/ack`);
    // After the decision the note still tells what was found, and who decided.
    await agent.post(`/api/admin/sync-runs/${bad.runId}/ack`).set('X-CSRF-Token', csrf).send({ decision: 'accept' });
    const after = (await web.agent.get('/admin/sync')).text;
    expect(after).toContain('Lượt full chỉ thấy');
    expect(after).toContain('nếu chấp nhận, các máy này được gắn nhãn');
    expect(after).toMatch(/Đã chấp nhận bởi admin.hq lúc/);
  });

  it('applies nothing when a quarantined run is rejected', async () => {
    const all = [...tenComputers('HN', 1), ...tenComputers('HCM', 101)];
    await runSync({ computers: all });
    const bad = await runSync({ computers: all.slice(0, 10) });
    await addUser(pool, 'admin.hq', [{ branchId: null, role: 'admin' }]);
    const { agent, csrf } = await apiLogin(app, 'admin.hq');
    await agent.post(`/api/admin/sync-runs/${bad.runId}/ack`).set('X-CSRF-Token', csrf).send({ decision: 'reject' });
    expect((await asOwner('SELECT count(*)::int AS n FROM computer WHERE deleted_in_ad_at IS NOT NULL'))[0].n).toBe(0);
    expect((await asOwner('SELECT status FROM sync_run WHERE id = $1', [bad.runId]))[0].status).toBe('quarantined');
  });

  it('quarantines when keys come back without their password (lost permission)', async () => {
    const r = await runSync({ computers: [computer(1)], keys: [{ ...key(1, 1), recoveryPassword: '' }] });
    expect(r.keys.emptyPassword).toBe(1);
    expect(r.done.status).toBe('quarantined');
    expect(r.done.anomalies[0].code).toBe('key_attr_unreadable');
  });

  it('raises an alert for a failed run and clears it after a successful one', async () => {
    const open = await ingest().post('/api/ingest/sync-runs').send({ mode: 'full', dcName: 'DC01' });
    await ingest().post(`/api/ingest/sync-runs/${open.body.runId}/complete`).send({ status: 'failed', errorCode: 'ldap_bind_failed' });
    expect((await services.alerts.listOpen()).map((a) => a.type)).toContain('sync_failed');
    await runSync({ computers: [computer(1)] });
    expect((await services.alerts.listOpen()).map((a) => a.type)).not.toContain('sync_failed');
  });

  it('closes a run cancelled by a service stop without an alert, so the next run can open', async () => {
    const open = await ingest().post('/api/ingest/sync-runs').send({ mode: 'full', dcName: 'DC01' });
    const done = await ingest().post(`/api/ingest/sync-runs/${open.body.runId}/complete`).send({ status: 'failed', errorCode: 'cancelled' });
    expect(done.body.status).toBe('failed');
    expect(await services.alerts.listOpen()).toEqual([]);
    expect((await ingest().post('/api/ingest/sync-runs').send({ mode: 'full', dcName: 'DC01' })).status).toBe(201);
  });
});

describe('heartbeat, manual sync and watchdog', () => {
  it('delivers a manual sync request to exactly one heartbeat', async () => {
    await addUser(pool, 'admin.hq', [{ branchId: null, role: 'admin' }]);
    const { agent, csrf } = await apiLogin(app, 'admin.hq');
    await agent.post('/api/admin/sync-runs').set('X-CSRF-Token', csrf).send({ mode: 'full' });
    const beats = await Promise.all([1, 2, 3].map(() => ingest().post('/api/ingest/heartbeat').send({ workerId: 'w1', ldapOk: true })));
    expect(beats.map((b) => b.body.syncRequested).filter(Boolean)).toEqual(['full']);
  });

  const watchdog = () => runSyncWatchdog({ pool, alerts: services.alerts, settings: services.settings });
  const openTypes = async () => (await services.alerts.listOpen()).map((a) => a.type);
  const heartbeat = (extra = {}) => ingest().post('/api/ingest/heartbeat').send({ workerId: 'w1', ldapOk: true, ...extra });

  it('no heartbeat: only the worker is Offline, nothing about AD (it cannot be judged)', async () => {
    const r = await watchdog();
    expect(r.workerOffline).toBe(true);
    expect(r.problems).toEqual([]);
    expect(sent.map((m) => m.type)).toEqual(['worker_offline']);
    expect(sent[0].subject).toContain('Worker đồng bộ AD đang Offline');
    const open = await openTypes();
    expect(open).toEqual(expect.arrayContaining(['worker_offline', 'worker_silent']));
    expect(open).not.toContain('sync_problem');
    expect(open).not.toContain('sync_stale'); // a consequence of the worker being down, not a second problem
  });

  it('the worker runs but AD / the sync is wrong: sync_problem, not worker_offline', async () => {
    await heartbeat({ ldapOk: false, lastErrorCode: 'ldap_tls_failed' });
    const r = await watchdog();
    expect(r.workerOffline).toBe(false);
    expect(r.problems).toEqual(expect.arrayContaining(['ldap_error', 'sync_stale', 'full_stale']));
    expect(sent.map((m) => m.type)).toEqual(['sync_problem']);
    expect(sent[0].subject).toContain('Đồng bộ AD có sự cố');
    expect(sent[0].text).toContain('ldap_tls_failed');
    const open = await openTypes();
    expect(open).toContain('sync_problem');
    expect(open).not.toContain('worker_offline');
  });

  it('each group mails once, then at most once a day, and nothing once it is over', async () => {
    await watchdog();
    expect(sent).toHaveLength(1);
    await watchdog(); // same day
    expect(sent).toHaveLength(1);
    await pool.query(`UPDATE sync_alert SET last_notified_at = now() - interval '1 day' WHERE type = 'worker_offline' AND resolved_at IS NULL`);
    await watchdog(); // the next day
    expect(sent).toHaveLength(2);

    // The worker is back, but a full run was never done: AD side now has its own mail.
    await heartbeat();
    await runSync({ computers: [computer(1)] });
    const r = await watchdog();
    expect(r.workerOffline).toBe(false);
    expect(await openTypes()).not.toContain('worker_offline');
    expect(sent.filter((m) => m.type === 'worker_offline')).toHaveLength(2); // no "recovered" mail

    expect(await watchdog()).toMatchObject({ workerOffline: false, problems: [] });
    expect(await services.alerts.listOpen()).toEqual([]);
    expect(sent.some((m) => m.subject.includes('Đã khôi phục'))).toBe(false);
  });

  it('the run list shows + computers added and − computers flagged out of scope, + keys added', async () => {
    const all = Array.from({ length: 40 }, (_, i) => computer(i + 1));
    await runSync({ computers: all, keys: [key(1, 1)] }); // +40 computers, +1 key
    await runSync({ computers: all.slice(0, 39), keys: [key(1, 1)] }); // the full run no longer sees one: −1
    await addUser(pool, 'admin.hq', [{ branchId: null, role: 'admin' }]);
    const web = await webLogin(app, 'admin.hq');
    const list = (await web.agent.get('/admin/sync')).text;
    expect(list).toContain('class="delta-up">+40</span>');
    expect(list).toContain('class="delta-up">+1</span>'); // the key
    expect(list).toContain('class="delta-down">−1</span>');
    expect((await asOwner('SELECT marked_not_in_ad FROM sync_run ORDER BY id DESC LIMIT 1'))[0].marked_not_in_ad).toBe(1);
  });

  it('a system fault switched off in Canh bao sync is not watched: no alert, no mail', async () => {
    const setOff = async (type) => {
      await asOwner(`INSERT INTO app_setting (key, value) VALUES ('alert.${type}', 'false') ON CONFLICT (key) DO UPDATE SET value = 'false'`);
      services.settings.invalidate();
    };
    await setOff('worker_silent');
    const r = await watchdog(); // no heartbeat at all
    expect(r.workerOffline).toBe(true);
    expect(sent.map((m) => m.type)).toEqual([]); // no "worker offline" mail
    expect(await openTypes()).not.toContain('worker_offline');
    expect(await openTypes()).not.toContain('worker_silent');

    await asOwner(`DELETE FROM app_setting WHERE key = 'alert.worker_silent'`);
    services.settings.invalidate();
    await setOff('ldap_error');
    await heartbeat({ ldapOk: false, lastErrorCode: 'ldap_tls_failed' });
    const r2 = await watchdog();
    expect(r2.problems).not.toContain('ldap_error'); // switched off
    expect(r2.problems).toContain('sync_stale'); // the others still count
    expect(await openTypes()).not.toContain('ldap_error');
  });

  it('a delta run page shows only what the run saw; only a full run is compared with the whole system', async () => {
    const full = await runSync({ computers: [computer(1), computer(2), computer(3)], keys: [key(1, 1)] });
    const delta = await runSync({ mode: 'delta', computers: [computer(2)] });
    await addUser(pool, 'admin.hq', [{ branchId: null, role: 'admin' }]);
    const web = await webLogin(app, 'admin.hq');
    const fullPage = (await web.agent.get(`/admin/sync/runs/${full.runId}`)).text;
    expect(fullPage).toContain('Số liệu của lượt so với hệ thống');
    expect(fullPage).toContain('Máy đang có');
    const deltaPage = (await web.agent.get(`/admin/sync/runs/${delta.runId}`)).text;
    expect(deltaPage).toContain('Số liệu của lượt này');
    expect(deltaPage).not.toContain('Máy đang có');
    expect(deltaPage).not.toContain('Chênh lệch');
    expect(deltaPage).not.toContain('Key đang có');
    expect(deltaPage).toContain('Máy mới');

    // a delta that adds a computer to the system: "Máy mới" counts it on the run list and on the run page; full runs show a dash on the list
    const added = await runSync({ mode: 'delta', computers: [computer(2), computer(4)] });
    const addedPage = (await web.agent.get(`/admin/sync/runs/${added.runId}`)).text;
    expect(addedPage).toMatch(/Toàn hệ thống<\/td>\s*<td class="num">2<\/td>\s*<td class="num">4<\/td>\s*<td class="num">1<\/td>/); // saw 2, 4 computers now, 1 new
    expect(addedPage).toContain('Máy hiện tại');
    expect(addedPage).toContain('Key hiện tại');
    const list = (await web.agent.get('/admin/sync')).text;
    expect(list).toContain('class="delta-up">+1</span>'); // the delta row: +1 computer
    const [{ n }] = await asOwner(`SELECT count(*)::int AS n FROM computer WHERE first_seen_run = ${added.runId}`);
    expect(n).toBe(1);
  });

  it('Admin HQ can mark a data alert handled or snooze it; system faults cannot be marked', async () => {
    await heartbeat();
    await runSync({ computers: [computer(1)] }); // a full run, then it gets old
    await asOwner("UPDATE sync_run SET finished_at = now() - interval '3 days'");
    await runSync({ mode: 'delta', computers: [computer(1)] }); // recent delta: only full_stale is left (data alert)
    expect((await watchdog()).problems).toEqual(['full_stale']);
    await addUser(pool, 'admin.hq', [{ branchId: null, role: 'admin' }]);
    const web = await webLogin(app, 'admin.hq');
    const alertId = async (type) => (await asOwner(`SELECT id FROM sync_alert WHERE type = '${type}' AND resolved_at IS NULL`))[0].id;
    const post = async (type, action, body = {}) =>
      web.agent.post(`/admin/sync/alerts/${await alertId(type)}/${action}`).type('form').send({ _csrf: web.csrf, ...body });

    // "Da xu ly" = the cause was fixed: the alert closes now (with who / why) and is looked at again after the grace period
    expect((await post('full_stale', 'ack', { note: 'GPO da sua' })).status).toBe(302);
    expect(await openTypes()).not.toContain('full_stale'); // closed at once
    const [closed] = await asOwner(`SELECT acked_by, ack_note, resolved_at FROM sync_alert WHERE type = 'full_stale' ORDER BY id DESC LIMIT 1`);
    expect(closed).toMatchObject({ acked_by: 'admin.hq', ack_note: 'GPO da sua' });
    expect(closed.resolved_at).not.toBeNull();
    expect(await watchdog()).toMatchObject({ problems: [] }); // within the grace period: not raised again
    expect(await openTypes()).not.toContain('sync_problem');
    expect(await openTypes()).not.toContain('full_stale');
    const page = (await web.agent.get('/admin/sync')).text;
    expect(page).toContain('Sự cố hệ thống');
    expect(page).toContain('Cảnh báo dữ liệu');
    const [{ detail }] = await asOwner(`SELECT detail FROM access_log WHERE action = 'alert_ack'`);
    expect(detail).toMatchObject({ type: 'full_stale', graceHours: 24 });
    // the grace period is over and the condition is still true: a NEW alert opens
    await asOwner(`INSERT INTO app_setting (key, value) VALUES ('alert_grace.full_stale', to_jsonb((now() - interval '1 minute')::text)) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    services.settings.invalidate();
    expect((await watchdog()).problems).toEqual(['full_stale']);
    expect(await openTypes()).toContain('full_stale');

    // snooze: silent until the time is over, then it counts again
    expect((await post('full_stale', 'snooze', { days: '7' })).status).toBe(302);
    expect((await watchdog()).problems).toEqual([]);
    await asOwner(`UPDATE sync_alert SET snoozed_until = now() - interval '1 minute' WHERE type = 'full_stale'`);
    expect((await watchdog()).problems).toEqual(['full_stale']);

    // Admin HQ can switch a data alert off: it is closed and never opened again
    await asOwner(`INSERT INTO app_setting (key, value) VALUES ('alert.full_stale', 'false')`);
    services.settings.invalidate();
    expect((await watchdog()).problems).toEqual([]);
    expect(await openTypes()).not.toContain('full_stale');
    await asOwner(`DELETE FROM app_setting WHERE key = 'alert.full_stale'`);
    services.settings.invalidate();
    expect((await watchdog()).problems).toEqual(['full_stale']); // back on: it is reported again

    // a system fault clears itself: it can be neither marked handled nor snoozed
    await heartbeat({ ldapOk: false, lastErrorCode: 'ldap_bind_failed' });
    await watchdog();
    expect((await post('ldap_error', 'ack')).status).toBe(302); // refused: back to the page with the reason
    expect((await web.agent.get('/admin/sync')).text).toContain('sự cố hệ thống tự hết khi sửa xong');
    expect(await services.alerts.isSilenced('ldap_error')).toBe(false);
    expect((await post('ldap_error', 'snooze', { days: '7' })).status).toBe(302);
    expect((await watchdog()).problems).toContain('ldap_error');
  });

  it('the worker going down while a problem is open closes it quietly (Offline wins), and comes back as a problem if it persists', async () => {
    await heartbeat({ ldapOk: false, lastErrorCode: 'ldap_bind_failed' });
    await watchdog();
    expect(await openTypes()).toContain('sync_problem');
    await asOwner(`UPDATE worker_heartbeat SET at = now() - interval '2 hours'`);
    await watchdog();
    const open = await openTypes();
    expect(open).toEqual(expect.arrayContaining(['worker_offline']));
    expect(open).not.toContain('sync_problem');
    expect(open).not.toContain('ldap_error');
    expect(sent.map((m) => m.type)).toEqual(['sync_problem', 'worker_offline']);
  });
});

describe('same Key ID under another computer (unjoin / rejoin, cloned image)', () => {
  // Enough computers that dropping one or two does not quarantine a full run.
  const fleet = (from = 1, n = 40) => Array.from({ length: n }, (_, i) => computer(from + i));
  const keyOf = (n, pcN, extra = {}) => ({ ...key(n, pcN), computerObjectGuid: guid(pcN), ...extra });
  const ownerOf = async (n) => (await asOwner(`SELECT c.name, c.object_guid FROM recovery_key k JOIN computer c ON c.id = k.computer_id WHERE k.key_id = '${keyGuid(n)}'`))[0];
  const duplicateMails = () => sent.filter((m) => m.type === 'key_duplicate');

  it('moves the key at once when the computer rejoined AD under the same name (new objectGUID)', async () => {
    await runSync({ computers: fleet(), keys: [keyOf(1, 1)] });
    // Rejoined: new object, same name and OU, the same key pushed again.
    const rejoined = { ...computer(1), objectGuid: guid(901) };
    const r = await runSync({ mode: 'delta', computers: [rejoined], keys: [{ ...key(1, 1), computerObjectGuid: guid(901) }] });
    expect(r.done.status).toBe('success');
    expect(await ownerOf(1)).toEqual({ name: 'PC-1', object_guid: guid(901) });
    const old = await asOwner(`SELECT deleted_in_ad_at FROM computer WHERE object_guid = '${guid(1)}'`);
    expect(old[0].deleted_in_ad_at).not.toBeNull(); // the old object is flagged, not deleted
    const moves = await asOwner('SELECT reason FROM key_owner_change');
    expect(moves).toEqual([{ reason: 'rejoin_same_name' }]);
    expect((await asOwner('SELECT count(*)::int AS n FROM recovery_key'))[0].n).toBe(1); // one key, never copied
    expect(duplicateMails()).toHaveLength(0);
  });

  it('rejoined under another name: duplicate first, the key moves when a full run sees the old one gone', async () => {
    await runSync({ computers: fleet(), keys: [keyOf(1, 1)] });
    // Delta: new object PC-901 with the key of PC-1; PC-1 is not known as gone yet.
    await runSync({ mode: 'delta', computers: [computer(901)], keys: [keyOf(1, 901)] });
    expect((await ownerOf(1)).name).toBe('PC-1');
    expect(await asOwner('SELECT resolution FROM key_duplicate')).toEqual([{ resolution: null }]);
    // Full run without PC-1: PC-1 leaves AD, the key moves to PC-901, nothing is mailed.
    const full = await runSync({ computers: [...fleet(2, 39), computer(901)], keys: [keyOf(1, 901)] });
    expect(full.done.status).toBe('success');
    expect((await ownerOf(1)).name).toBe('PC-901');
    expect(await asOwner('SELECT resolution FROM key_duplicate')).toEqual([{ resolution: 'moved' }]);
    expect(await asOwner('SELECT reason FROM key_owner_change')).toEqual([{ reason: 'old_not_in_ad' }]);
    expect(duplicateMails()).toHaveLength(0);
  });

  it('two computers still in AD with one Key ID: the key stays, one mail per pair, Admin HQ can close it', async () => {
    await runSync({ computers: fleet(), keys: [keyOf(1, 1)] });
    await runSync({ computers: fleet(), keys: [keyOf(1, 1), keyOf(1, 2)] });
    expect((await ownerOf(1)).name).toBe('PC-1');
    expect(duplicateMails()).toHaveLength(1);
    expect(duplicateMails()[0].subject).toContain('Key ID trùng giữa 2 máy (1)');
    expect(duplicateMails()[0].text).toContain('PC-1');
    expect(duplicateMails()[0].text).toContain('PC-2');
    expect(duplicateMails()[0].text).not.toMatch(/\d{6}-\d{6}/); // never a password

    await runSync({ computers: fleet(), keys: [keyOf(1, 1), keyOf(1, 2)] });
    expect(duplicateMails()).toHaveLength(1); // not again

    await addUser(pool, 'admin.hq', [{ branchId: null, role: 'admin' }]);
    const web = await webLogin(app, 'admin.hq');
    const page = await web.agent.get('/admin/sync');
    expect(page.text).toContain('Key ID trùng giữa nhiều máy (1)');
    const [{ id }] = await asOwner('SELECT id FROM key_duplicate');
    const res = await web.agent.post(`/admin/sync/key-duplicates/${id}/review`).type('form').send({ _csrf: web.csrf, action: 'share' });
    expect(res.status).toBe(302);
    expect(await asOwner('SELECT resolution, resolved_by FROM key_duplicate')).toEqual([{ resolution: 'shared', resolved_by: 'admin.hq' }]);
    await runSync({ computers: fleet(), keys: [keyOf(1, 1), keyOf(1, 2)] });
    expect(await asOwner('SELECT resolution FROM key_duplicate')).toEqual([{ resolution: 'shared' }]); // stays closed
    expect(duplicateMails()).toHaveLength(1);
    expect((await asOwner(`SELECT action FROM access_log WHERE action = 'key_duplicate_review'`))).toHaveLength(1);
  });

  it('"checked" gives the key to the computer created later in AD', async () => {
    const withNewer = () => fleet().map((c) => (c.objectGuid === guid(2) ? { ...c, whenCreated: '2026-03-01T00:00:00Z' } : c));
    await runSync({ computers: withNewer(), keys: [keyOf(1, 1)] });
    await runSync({ computers: withNewer(), keys: [keyOf(1, 1), keyOf(1, 2)] });
    expect((await ownerOf(1)).name).toBe('PC-1');
    await addUser(pool, 'admin.hq', [{ branchId: null, role: 'admin' }]);
    const web = await webLogin(app, 'admin.hq');
    const [{ id }] = await asOwner('SELECT id FROM key_duplicate');
    const res = await web.agent.post(`/admin/sync/key-duplicates/${id}/review`).type('form').send({ _csrf: web.csrf, action: 'assign' });
    expect(res.status).toBe(302);
    expect((await ownerOf(1)).object_guid).toBe(guid(2));
    expect(await asOwner('SELECT resolution FROM key_duplicate')).toEqual([{ resolution: 'moved' }]);
    expect(await asOwner('SELECT reason FROM key_owner_change')).toEqual([{ reason: 'review_newer' }]);
    expect((await asOwner(`SELECT detail FROM access_log WHERE action = 'key_duplicate_review'`))[0].detail.result).toBe('moved');
  });

  it('"assign" is refused when the key holder is not the older computer; "share" shows a note on both pages', async () => {
    await runSync({ computers: fleet(), keys: [keyOf(1, 1)] });
    await runSync({ computers: fleet(), keys: [keyOf(1, 1), keyOf(1, 2)] }); // same creation time on both
    await addUser(pool, 'admin.hq', [{ branchId: null, role: 'admin' }]);
    const web = await webLogin(app, 'admin.hq');
    const [{ id }] = await asOwner('SELECT id FROM key_duplicate');
    const post = (action) => web.agent.post(`/admin/sync/key-duplicates/${id}/review`).type('form').send({ _csrf: web.csrf, action });
    expect((await post('assign')).status).toBe(302); // refused: same creation time, back to the page with the reason
    expect((await web.agent.get('/admin/sync')).text).toContain('được tạo cùng lúc trên AD'); // same creation time: short reason with both names
    expect((await ownerOf(1)).name).toBe('PC-1');
    expect(await asOwner('SELECT resolved_at FROM key_duplicate')).toEqual([{ resolved_at: null }]); // still open
    expect((await post('share')).status).toBe(302);
    expect((await ownerOf(1)).name).toBe('PC-1'); // key stays
    const ids = Object.fromEntries((await asOwner('SELECT name, id FROM computer WHERE name IN (\'PC-1\', \'PC-2\')')).map((r) => [r.name, r.id]));
    for (const name of ['PC-1', 'PC-2']) {
      const html = (await web.agent.get(`/computers/${ids[name]}`)).text;
      expect(html).toContain('dùng chung');
    }
  });

  it('never moves or overwrites a key seen with another password', async () => {
    await runSync({ computers: fleet(), keys: [keyOf(1, 1)] });
    const rejoined = { ...computer(1), objectGuid: guid(901) };
    await runSync({ mode: 'delta', computers: [rejoined], keys: [keyOf(1, 901, { recoveryPassword: PWD(2) })] });
    expect((await ownerOf(1)).object_guid).toBe(guid(1));
    expect((await asOwner('SELECT recovery_password FROM recovery_key'))[0].recovery_password).toBe(PWD(1));
    expect(await asOwner('SELECT same_password FROM key_duplicate')).toEqual([{ same_password: false }]);
  });

  it('shows the move on both computer pages', async () => {
    await runSync({ computers: fleet(), keys: [keyOf(1, 1)] });
    await runSync({ mode: 'delta', computers: [{ ...computer(1), objectGuid: guid(901) }], keys: [{ ...key(1, 1), computerObjectGuid: guid(901) }] });
    await addUser(pool, 'it.hn', [{ branchId: 1, role: 'it' }]);
    const web = await webLogin(app, 'it.hn');
    const ids = Object.fromEntries((await asOwner('SELECT object_guid, id FROM computer WHERE name = \'PC-1\'')).map((r) => [r.object_guid, r.id]));
    expect((await web.agent.get(`/computers/${ids[guid(1)]}`)).text).toContain('đã chuyển sang máy');
    expect((await web.agent.get(`/computers/${ids[guid(901)]}`)).text).toContain('chuyển từ máy cũ');
  });
});

describe('ingest API boundaries', () => {
  it('validates batches and rejects oversize ones', async () => {
    const open = await ingest().post('/api/ingest/sync-runs').send({ mode: 'full', dcName: 'DC01' });
    const tooMany = Array.from({ length: 501 }, (_, i) => computer(i));
    expect((await ingest().post('/api/ingest/computers').send({ runId: open.body.runId, items: tooMany })).status).toBe(400);
    expect((await ingest().post('/api/ingest/computers').send({ runId: open.body.runId, items: [{ name: 'x' }] })).status).toBe(400);
  });

  it('has no endpoint that returns a key', async () => {
    await runSync({ computers: [computer(1)], keys: [key(1, 1)] });
    for (const path of ['/api/ingest/keys', '/api/ingest/computers', '/api/ingest/sync-runs/last']) {
      expect(JSON.stringify((await ingest().get(path)).body)).not.toContain(PWD(1));
    }
  });
});
