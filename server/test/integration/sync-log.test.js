import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createLogger } from '../../src/logger.js';
import { appPool, asOwner, PWD, resetDatabase } from './db.js';
import { addUser, apiLogin, buildApp } from './app.js';

// Every change a sync makes is traceable in the app log (component "sync"), after commit,
// with the run id, and never with a recovery password.

const lines = [];
const sink = new Writable({
  write(chunk, enc, cb) {
    for (const l of chunk.toString().split('\n').filter(Boolean)) lines.push(JSON.parse(l));
    cb();
  },
});

let pool;
let app;
let ingestApp;
beforeAll(() => {
  pool = appPool();
  ({ app, ingestApp } = buildApp(pool, { logger: createLogger('info', sink) }));
});
afterAll(() => pool?.end());
beforeEach(async () => {
  await resetDatabase();
  lines.length = 0;
  await asOwner(`
    INSERT INTO branch (code, name) VALUES ('HN', 'Ha Noi'), ('HCM', 'Ho Chi Minh');
    INSERT INTO branch_ou (branch_id, root_dn) VALUES (1, 'ou=computers,ou=hn,dc=corp,dc=local'), (2, 'ou=computers,ou=hcm,dc=corp,dc=local');`);
});

const ingest = () => request(ingestApp);
const guid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const keyGuid = (n) => `0000${String(n).padStart(4, '0')}-1111-4000-8000-000000000000`;
const C = 'c0000000-0000-4000-8000-000000000001';
const dn = (name, branch) => `CN=${name},OU=Computers,OU=${branch},DC=corp,DC=local`;
const pc = (n, name, branch) => ({ objectGuid: guid(n), name, dn: dn(name, branch) });
const key = (n, name, branch, when, volumeGuid = C) => ({
  keyId: keyGuid(n), dn: `CN={K${n}},${dn(name, branch)}`, recoveryPassword: PWD(n), whenCreated: when, volumeGuid,
});
async function run(mode, computers, keys = []) {
  const { runId } = (await ingest().post('/api/ingest/sync-runs').send({ mode, dcName: 'DC01' })).body;
  if (computers.length) await ingest().post('/api/ingest/computers').send({ runId, items: computers });
  if (keys.length) await ingest().post('/api/ingest/keys').send({ runId, items: keys });
  await ingest().post(`/api/ingest/sync-runs/${runId}/complete`).send({ status: 'success', highestUsn: 100 + runId, keysSeen: keys.length });
  return runId;
}
const sync = () => lines.filter((l) => l.component === 'sync');
const msgs = (runId) => sync().filter((l) => l.runId === runId).map((l) => l.msg);

describe('sync trace in the app log', () => {
  it('logs added computers and keys, branch moves, renames, superseded keys, and a summary per batch and run', async () => {
    const r1 = await run('full', [pc(1, 'PC-1', 'HN'), pc(2, 'PC-2', 'HN')], [key(1, 'PC-1', 'HN', '2026-01-01T00:00:00Z')]);
    expect(msgs(r1)).toEqual([
      'sync run opened',
      'computer added', 'computer added', 'computer batch stored',
      'key added', 'key batch stored',
      'sync run completed',
    ]);
    const added = sync().find((l) => l.msg === 'key added');
    expect(added).toMatchObject({ runId: r1, keyId: keyGuid(1), computer: 'PC-1', volumeGuid: C });

    // PC-1 moves to HCM, PC-2 is renamed, PC-1 gets a newer key for the same volume.
    lines.length = 0;
    const r2 = await run('delta', [{ ...pc(1, 'PC-1', 'HCM') }, { ...pc(2, 'PC-2B', 'HN') }],
      [key(2, 'PC-1', 'HCM', '2026-06-01T00:00:00Z')]);
    expect(sync().find((l) => l.msg === 'computer moved to another branch')).toMatchObject({ runId: r2, name: 'PC-1', fromBranchId: 1, toBranchId: 2 });
    expect(sync().find((l) => l.msg === 'computer renamed or moved in AD')).toMatchObject({ runId: r2, name: 'PC-2B', fromName: 'PC-2' });
    expect(sync().find((l) => l.msg === 'key superseded by a newer key of the same volume')).toMatchObject({
      runId: r2, keyId: keyGuid(1), computer: 'PC-1', status: 'superseded',
    });
    expect(sync().find((l) => l.msg === 'computer batch stored')).toMatchObject({ runId: r2, received: 2, added: 0, moved: 1, changed: 1, unchanged: 0 });
    expect(sync().find((l) => l.msg === 'key batch stored')).toMatchObject({ runId: r2, received: 1, added: 1, statusChanged: 1 });

    // A known key sent again is only counted; nothing is logged for it on its own.
    lines.length = 0;
    const r3 = await run('delta', [pc(1, 'PC-1', 'HCM')], [key(2, 'PC-1', 'HCM', '2026-06-01T00:00:00Z')]);
    expect(msgs(r3)).toEqual(['sync run opened', 'computer batch stored', 'key batch stored', 'sync run completed']);
    expect(sync().find((l) => l.msg === 'key batch stored')).toMatchObject({ unchanged: 1, added: 0 });

    // Never a recovery password in any log line.
    for (const n of [1, 2]) expect(JSON.stringify(lines)).not.toContain(PWD(n));
  });

  it('logs keys it could not store and each computer flagged out of the monitored scope', async () => {
    await run('full', [pc(1, 'PC-1', 'HN'), pc(2, 'PC-2', 'HN')]);
    lines.length = 0;
    const r = await run('full', [pc(1, 'PC-1', 'HN')], [
      { ...key(5, 'PC-1', 'HN', '2026-01-01T00:00:00Z'), recoveryPassword: '' },
      key(6, 'PC-9', 'HN', '2026-01-01T00:00:00Z'),
    ]);
    // 1 of 2 computers not seen = 50%: the run is held; accept it to apply the flag.
    expect(sync().filter((l) => l.msg === 'sync anomaly').map((l) => l.code)).toContain('mass_delete');
    expect(sync().find((l) => l.msg === 'key without a readable password (not stored)')).toMatchObject({ level: 40, keyId: keyGuid(5) });
    expect(sync().find((l) => l.msg === 'key for an unknown computer (sent back as orphan)')).toMatchObject({ keyId: keyGuid(6) });

    await addUser(pool, 'admin.hq', [{ branchId: null, role: 'admin' }]);
    const { agent, csrf } = await apiLogin(app, 'admin.hq');
    await agent.post(`/api/admin/sync-runs/${r}/ack`).set('X-CSRF-Token', csrf).send({ decision: 'accept' });
    expect(sync().find((l) => l.msg === 'computer not seen by the full run: flagged out of the monitored scope')).toMatchObject({ runId: r, name: 'PC-2' });
    expect(sync().find((l) => l.msg === 'quarantined sync run decided')).toMatchObject({ runId: r, decision: 'accept', by: 'admin.hq', markedNotInAd: 1 });
  });

  it('the run list is paged (50 per page) and "last success" does not depend on the page', async () => {
    await asOwner(`INSERT INTO sync_run (mode, dc_name, status, started_at, finished_at)
      SELECT 'delta', 'DC01', CASE WHEN g = 1 THEN 'success' ELSE 'failed' END, now() - make_interval(mins => 200 - g), now() - make_interval(mins => 200 - g)
        FROM generate_series(1, 120) g`);
    await addUser(pool, 'admin.hq', [{ branchId: null, role: 'admin' }]);
    const { agent } = await apiLogin(app, 'admin.hq');
    const p1 = (await agent.get('/api/admin/sync-runs')).body;
    expect(p1).toMatchObject({ page: 1, pages: 3, total: 120, pageSize: 50 });
    expect(p1.items).toHaveLength(50);
    const p3 = (await agent.get('/api/admin/sync-runs?page=3')).body;
    expect(p3.items).toHaveLength(20);
    expect((await agent.get('/api/admin/sync-runs?page=99')).body.page).toBe(3); // out of range: last page
    const web = await agent.get('/api/admin/sync');
    expect(web.body.lastSuccess).not.toBeNull(); // the only success is on the last page
  });
});
