import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appPool, asOwner, resetDatabase } from './db.js';
import { addUser, apiLogin, buildApp } from './app.js';

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
});

const admin = async () => {
  const { agent, csrf } = await apiLogin(app, 'admin.hq');
  return {
    get: (p) => agent.get(p),
    put: (p, body) => agent.put(p).set('X-CSRF-Token', csrf).send(body),
    post: (p, body = {}) => agent.post(p).set('X-CSRF-Token', csrf).send(body),
  };
};

/** n log rows dated `daysAgo` days back, written through the real hash-chain writer. */
async function logRows(n, daysAgo) {
  for (let i = 0; i < n; i++) {
    await services.audit.log({ userSid: 'S-test', userUpn: 'tester', action: 'search', at: new Date(Date.now() - daysAgo * 86_400_000) });
  }
}

describe('retention settings', () => {
  it('keeps the access log forever by default and lets the admin choose any number of days from 1', async () => {
    const a = await admin();
    expect((await a.get('/api/admin/settings/retention')).body).toMatchObject({ mailDays: 90, syncDays: 180, accessLogDays: null, lastPurge: null });
    const bad = await a.put('/api/admin/settings/retention', { mailDays: 90, syncDays: 180, keepAccessLog: false, accessLogDays: 0 });
    expect(bad.status).toBe(400);
    const few = await a.put('/api/admin/settings/retention', { mailDays: 90, syncDays: 180, keepAccessLog: false, accessLogDays: 30 });
    expect(few.status).toBe(200); // no longer limited to 365 days
    expect((await a.get('/api/admin/settings/retention')).body).toMatchObject({ accessLogDays: 30 });
    await a.put('/api/admin/settings/retention', { mailDays: 90, syncDays: 180, keepAccessLog: true });
    const noDays = await a.put('/api/admin/settings/retention', { mailDays: 90, syncDays: 180, keepAccessLog: false });
    expect(noDays.body.fields).toEqual([{ field: 'accessLogDays', message: 'access_log_days_required' }]);
    expect((await a.put('/api/admin/settings/retention', { mailDays: 90, syncDays: 10, keepAccessLog: true })).status).toBe(400);
  });
});

describe('access log purge', () => {
  it('deletes only the oldest rows and logs the purge', async () => {
    await logRows(3, 800);
    await logRows(2, 10);

    const a = await admin();
    await a.put('/api/admin/settings/retention', { mailDays: 90, syncDays: 180, keepAccessLog: false, accessLogDays: 400 });
    const done = (await a.post('/api/admin/settings/retention/run')).body;
    expect(done.accessLog).toBe(3);

    const left = await asOwner(`SELECT action FROM access_log ORDER BY id`);
    // 2 recent searches + the admin's sign-in/settings rows + the purge record, all newer than 400 days
    expect(left.filter((r) => r.action === 'search')).toHaveLength(2);
    expect(left.map((r) => r.action)).toContain('log_purge');
    expect((await a.get('/api/admin/settings/retention')).body.lastPurge).toMatchObject({ rows: '3', purged_by: 'admin.hq' });

    // A second run has nothing left to delete.
    expect((await a.post('/api/admin/settings/retention/run')).body.accessLog).toBe(0);
  });

  it('still refuses any other DELETE, UPDATE or TRUNCATE of the log', async () => {
    await logRows(2, 800);
    await expect(asOwner('DELETE FROM access_log WHERE id = 1')).rejects.toThrow(/append-only/);
    await expect(asOwner(`UPDATE access_log SET user_upn = 'x'`)).rejects.toThrow(/append-only/);
    await expect(asOwner('TRUNCATE access_log')).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM access_log')).rejects.toThrow(/permission denied/);
    await expect(pool.query(`SELECT * FROM purge_access_log(0, 'x')`)).rejects.toThrow(/at least 1 day/);
  });

  it('purges by a short period chosen by the admin', async () => {
    await logRows(4, 10);
    await logRows(3, 1);
    await asOwner(`UPDATE app_setting SET value = '5' WHERE key = 'retention.access_log_days'`);
    services.settings.invalidate();
    const done = await services.retention.run();
    expect(done.accessLog).toBe(4);
    const [{ n }] = await asOwner("SELECT count(*)::int AS n FROM access_log WHERE at < now() - interval '5 days'");
    expect(n).toBe(0);
  });
});

describe('sync history purge', () => {
  it('deletes old runs, their metrics and old resolved alerts, but keeps the last successful runs', async () => {
    await asOwner(`
      INSERT INTO sync_run (started_at, finished_at, mode, dc_name, status) VALUES
        (now() - interval '400 days', now() - interval '400 days', 'full',  'DC01', 'success'),  -- 1 old
        (now() - interval '300 days', now() - interval '300 days', 'delta', 'DC01', 'failed'),   -- 2 old
        (now() - interval '250 days', now() - interval '250 days', 'full',  'DC01', 'success'),  -- 3 old but last full success
        (now() - interval '1 day',    now() - interval '1 day',    'delta', 'DC01', 'success');  -- 4 recent
      INSERT INTO sync_metric (run_id, computers_seen, computers_in_db, keys_seen, keys_expected, keys_empty_pwd, new_computers_7d, new_without_key, pct_no_key)
        VALUES (1, 1, 1, 1, 1, 0, 0, 0, 0), (3, 1, 1, 1, 1, 0, 0, 0, 0);
      INSERT INTO sync_alert (type, severity, resolved_at) VALUES ('old', 'high', now() - interval '300 days'), ('open', 'high', NULL);`);
    const done = await services.retention.run();
    expect(done).toMatchObject({ syncRuns: 2, alerts: 1, accessLog: 0 });
    expect((await asOwner('SELECT id FROM sync_run ORDER BY id')).map((r) => Number(r.id))).toEqual([3, 4]);
    expect((await asOwner('SELECT run_id FROM sync_metric')).map((r) => Number(r.run_id))).toEqual([3]);
    expect((await asOwner('SELECT type FROM sync_alert')).map((r) => r.type)).toEqual(['open']);
  });
});
