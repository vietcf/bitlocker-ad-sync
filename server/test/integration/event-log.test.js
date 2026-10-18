import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appPool, PWD, resetDatabase, seedTwoBranches } from './db.js';
import { addUser, apiLogin, buildApp } from './app.js';
import { EventLog } from '../../src/modules/audit/event-log.js';
import { withScope } from '../../src/db/scoped.js';

const KEY_HN = 'aaaaaaaa-0000-0000-0000-000000000001';
let pool;
let app;
let ingestApp;
let services;
let lines;

const events = (type) => lines.map((l) => JSON.parse(l)).filter((e) => e.log_type === type);

/** Audit lines are written in the background right after the commit: wait for them. */
async function settle(type, count) {
  for (let i = 0; i < 100 && events(type).length < count; i += 1) await new Promise((r) => setTimeout(r, 20));
  await services.eventLog.flush();
}

beforeAll(() => {
  pool = appPool();
  ({ app, ingestApp, services } = buildApp(pool, { notifier: 'real' }));
});
afterAll(() => pool?.end());
beforeEach(async () => {
  await resetDatabase();
  services.settings.invalidate();
  lines = [];
  services.eventLog.enabled = true;
  services.eventLog.write = (line) => lines.push(line);
  await seedTwoBranches();
  await addUser(pool, 'admin.hq', [{ branchId: null, role: 'admin' }]);
  await addUser(pool, 'it.hn', [{ branchId: 1, role: 'it' }]);
});

describe('event log: audit', () => {
  it('writes a line for every row of the Nhat ky as soon as it is committed, with the fields the screen shows', async () => {
    const it = await apiLogin(app, 'it.hn');
    await it.agent.get('/api/computers').query({ q: 'HN-LT' });
    await it.agent.post(`/api/keys/${KEY_HN}/reveal`).set('X-CSRF-Token', it.csrf).send({ reason: 'hardware_change', reasonNote: 'doi mainboard' });
    await request(app).post('/api/auth/login').send({ username: 'it.hn', password: 'wrong-password-xx' });
    await settle('audit', 4);

    const all = events('audit');
    const reveal = all.find((e) => e.action === 'reveal');
    expect(reveal).toMatchObject({
      log_type: 'audit', service: 'bitlocker-keys', user_upn: 'it.hn', branch_code: 'HN', computer_name: 'HN-LT-0001',
      key_id: KEY_HN, reason: 'hardware_change', reason_note: 'doi mainboard',
    });
    expect(reveal.id).toEqual(expect.any(Number));
    expect(reveal.client_ip).toBeTruthy();
    expect(Date.parse(reveal.time)).not.toBeNaN();
    expect(all.some((e) => e.action === 'login_failed' && e.detail?.reason === 'wrong_password')).toBe(true);
    expect(all.some((e) => e.action === 'search')).toBe(true);
    // Exactly the rows of the screen, none twice.
    const { rows } = await pool.query('SELECT 1').then(() => withScope(pool, 'all', (tx) => tx.query('SELECT id FROM access_log')));
    expect(all.map((e) => e.id).sort((a, b) => a - b)).toEqual(rows.map((r) => Number(r.id)).sort((a, b) => a - b));
  });

  it('writes nothing for a transaction that rolled back', async () => {
    await expect(withScope(pool, [], async (tx) => {
      await services.audit.append(tx, { userSid: 'user:9', userUpn: 'ghost', action: 'search', detail: { q: 'x' } });
      throw new Error('the action failed');
    })).rejects.toThrow('the action failed');
    await new Promise((r) => setTimeout(r, 100));
    await services.eventLog.flush();
    expect(events('audit')).toHaveLength(0);
  });

  it('is off when disabled, and never carries a recovery password', async () => {
    services.eventLog.enabled = false;
    const it = await apiLogin(app, 'it.hn');
    await it.agent.post(`/api/keys/${KEY_HN}/reveal`).set('X-CSRF-Token', it.csrf).send({ reason: 'other', reasonNote: 'x' });
    await new Promise((r) => setTimeout(r, 100));
    expect(lines).toHaveLength(0);

    services.eventLog.enabled = true;
    await it.agent.post(`/api/keys/${KEY_HN}/reveal`).set('X-CSRF-Token', it.csrf).send({ reason: 'other', reasonNote: 'x' });
    await settle('audit', 1);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('')).not.toContain(PWD(1));
    expect(lines.join('')).not.toMatch(/\d{6}-\d{6}-\d{6}/);
    expect(EventLog.body('x'.repeat(30_000)).length).toBeLessThan(20_100);
  });
});

describe('event log: it never gets in the way', () => {
  it('queues without waiting, drops lines when the writer is stuck, and says how many', async () => {
    let release;
    const stuck = new Promise((resolve) => { release = resolve; });
    const out = [];
    const log = new EventLog({ enabled: true, maxQueue: 3, write: async (line) => { await stuck; out.push(line); } });
    const started = Date.now();
    for (let i = 0; i < 10; i += 1) log.emit('mail', { i });
    expect(Date.now() - started).toBeLessThan(50); // emit() returned at once
    release();
    await log.flush();
    const got = out.map((l) => JSON.parse(l));
    // One line was already with the writer, three waited, six were dropped; the gap is reported.
    expect(got.filter((e) => e.log_type === 'mail')).toHaveLength(4);
    expect(got.at(-1)).toMatchObject({ log_type: 'event_gap', dropped: 6 });
  });

  it('survives a failing writer and a value that cannot be written', async () => {
    const out = [];
    let calls = 0;
    const log = new EventLog({ enabled: true, write: (line) => { calls += 1; if (calls === 1) throw new Error('pipe closed'); out.push(line); } });
    const circular = {};
    circular.self = circular;
    expect(() => log.emit('alert', { circular })).not.toThrow();
    log.emit('alert', { a: 1 });
    log.emit('alert', { a: 2 });
    await log.flush();
    expect(out.map((l) => JSON.parse(l).a)).toEqual([2]); // the first was lost, the next went on
  });
});

describe('event log: e-mail, alerts and sync runs', () => {
  it('logs every state of an e-mail with its text, as the Log email screen shows it', async () => {
    const r = await services.mail.enqueue({ kind: 'alert', to: ['a@corp.local'], subject: 'Tieu de', body: 'Noi dung', missing: ['no.mail'] });
    const none = await services.mail.enqueue({ kind: 'alert', to: [], subject: 'Khong ai', body: 'x', reason: 'nobody' });
    await services.settings.set('mail.smtp', { enabled: true, host: 'smtp.corp.local', port: 25, security: 'none', from: 'x@corp.local' });
    await services.mail.processOutbox();
    await services.eventLog.flush();
    const mail = events('mail');
    expect(mail.map((e) => `${e.event}:${e.mail_id}`)).toEqual([`queued:${r.id}`, `no_recipient:${none.id}`, `sent:${r.id}`]);
    expect(mail[0]).toMatchObject({ kind: 'alert', recipients: ['a@corp.local'], subject: 'Tieu de', body: 'Noi dung', missing_recipients: ['no.mail'], status: 'pending' });
    expect(mail[1]).toMatchObject({ status: 'no_recipient', error: 'nobody', recipients: [] });
    expect(mail[2]).toMatchObject({ status: 'sent', attempts: 1 });
  });

  it('logs alerts when they open, notify and resolve', async () => {
    await services.alerts.raise('sync_failed', 'high', { runId: 7, mode: 'full', dc: 'DC01', errorCode: 'ldap_bind_failed' });
    await services.alerts.clear('sync_failed', { runId: 8 });
    await services.eventLog.flush();
    const a = events('alert');
    expect(a.map((e) => e.event)).toEqual(['opened', 'notified', 'resolved']);
    expect(a[0]).toMatchObject({ type: 'sync_failed', severity: 'high' });
    expect(a[0].subject).toContain('ldap_bind_failed');
    expect(a[2].alert_id).toBe(a[0].alert_id);
  });

  it('logs a sync run when it opens and finishes, with the fields of the list and its readable number', async () => {
    const open = await request(ingestApp).post('/api/ingest/sync-runs').send({ mode: 'full', dcName: 'DC01' });
    expect(open.status).toBe(201);
    const runId = open.body.runId;
    await request(ingestApp).post(`/api/ingest/sync-runs/${runId}/complete`).send({ status: 'failed', errorCode: 'ldap_bind_failed' });
    await services.eventLog.flush();
    const runs = events('sync_run');
    expect(runs.map((e) => e.event)).toEqual(['opened', 'failed']);
    expect(runs[1]).toMatchObject({ run_id: runId, mode: 'full', dc_name: 'DC01', status: 'failed', error_code: 'ldap_bind_failed' });
    expect(runs[1].run_ref).toMatch(/^\d{8}-\d{4}$/);
  });
});
