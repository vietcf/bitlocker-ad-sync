import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runRef as makeRunRef } from '../../src/modules/sync/run-ref.js';
import request from 'supertest';
import { appPool, asOwner, PWD, resetDatabase } from './db.js';
import { addUser, apiLogin, buildApp, webLogin } from './app.js';

let pool;
let app;
let ingestApp;
let services;
let smtp;

beforeAll(() => {
  pool = appPool();
  ({ app, ingestApp, services, smtp } = buildApp(pool, { notifier: 'real' }));
});
afterAll(() => pool?.end());
beforeEach(async () => {
  await resetDatabase();
  services.settings.invalidate();
  smtp.delivered.length = 0;
  smtp.fail = null;
  await asOwner(`
    INSERT INTO branch (code, name) VALUES ('HN', 'Ha Noi'), ('HCM', 'Ho Chi Minh');
    INSERT INTO branch_ou (branch_id, root_dn) VALUES (1, 'ou=computers,ou=hn,dc=corp,dc=local'), (2, 'ou=computers,ou=hcm,dc=corp,dc=local');`);
  await addUser(pool, 'admin.hq', [{ branchId: null, role: 'admin' }]);
  await addUser(pool, 'it.hn', [{ branchId: 1, role: 'it' }]);
  await addUser(pool, 'it.hcm', [{ branchId: 2, role: 'it' }]);
  await addUser(pool, 'auditor', [{ branchId: 1, role: 'auditor' }, { branchId: 2, role: 'auditor' }]);
  await asOwner(`UPDATE app_user SET email = username || '@corp.local' WHERE username <> 'auditor'`);
});

const admin = async () => {
  const s = await apiLogin(app, 'admin.hq');
  return {
    ...s,
    get: (p) => s.agent.get(p),
    put: (p, body) => s.agent.put(p).set('X-CSRF-Token', s.csrf).send(body),
    post: (p, body) => s.agent.post(p).set('X-CSRF-Token', s.csrf).send(body),
  };
};

const SMTP = { enabled: true, host: 'smtp.corp.local', port: 587, security: 'starttls', username: 'svc-mail', from: 'blk@corp.local', rejectUnauthorized: true };

describe('mail server settings', () => {
  it('stores the password encrypted, never returns it, keeps it when left empty and clears it on request', async () => {
    const a = await admin();
    const saved = await a.put('/api/admin/settings/mail-server', { ...SMTP, password: 'Smtp-Secret-1' });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ host: 'smtp.corp.local', passwordSet: true });
    expect(JSON.stringify(saved.body)).not.toContain('Smtp-Secret-1');

    const [row] = await asOwner(`SELECT value FROM app_setting WHERE key = 'mail.smtp'`);
    expect(row.value.password).toMatch(/^enc:v1:/);
    expect(JSON.stringify(row.value)).not.toContain('Smtp-Secret-1');
    const log = await asOwner(`SELECT detail FROM access_log WHERE action = 'admin_change'`);
    expect(JSON.stringify(log)).not.toContain('Smtp-Secret-1');

    // Empty password field: the stored one is kept, and the transport gets it decrypted.
    await a.put('/api/admin/settings/mail-server', { ...SMTP, host: 'smtp2.corp.local', password: '' });
    expect((await a.post('/api/admin/settings/mail-server/test', { to: 'me@corp.local' })).body).toEqual({ ok: true, error: null });
    expect(smtp.options).toMatchObject({ host: 'smtp2.corp.local', port: 587, requireTLS: true, auth: { user: 'svc-mail', pass: 'Smtp-Secret-1' } });
    expect(smtp.delivered[0].to).toBe('me@corp.local');

    await a.put('/api/admin/settings/mail-server', { ...SMTP, clearPassword: true });
    expect((await a.get('/api/admin/settings')).body.mailServer.passwordSet).toBe(false);
  });

  it('reports a failing test mail instead of throwing', async () => {
    const a = await admin();
    await a.put('/api/admin/settings/mail-server', SMTP);
    smtp.fail = 'connect ECONNREFUSED';
    expect((await a.post('/api/admin/settings/mail-server/test', { to: 'me@corp.local' })).body).toEqual({ ok: false, error: 'connect ECONNREFUSED' });
  });

  it('validates the form and is for Admin HQ only', async () => {
    const a = await admin();
    expect((await a.put('/api/admin/settings/mail-server', { ...SMTP, host: '' })).body.fields).toEqual([{ field: 'host', message: 'host_required' }]);
    const it = await apiLogin(app, 'it.hn');
    expect((await it.agent.get('/api/admin/settings')).status).toBe(403);
  });
});

describe('mail outbox', () => {
  it('sends queued mail, retries a failure later, and gives up after the last retry', async () => {
    const a = await admin();
    await a.put('/api/admin/settings/mail-server', SMTP);
    const ok = (await services.mail.enqueue({ kind: 'test', to: ['A@corp.local', 'a@corp.local'], subject: 'S', body: 'B' })).id;
    expect(await services.mail.processOutbox()).toEqual({ sent: 1, failed: 0 });
    expect(smtp.delivered).toHaveLength(1);
    expect(smtp.delivered[0].to).toEqual(['a@corp.local']); // de-duplicated, lower case
    expect((await asOwner('SELECT status, attempts FROM mail_outbox WHERE id = $1', [ok]))[0]).toEqual({ status: 'sent', attempts: 1 });

    smtp.fail = '421 try later';
    const bad = (await services.mail.enqueue({ kind: 'test', to: ['b@corp.local'], subject: 'S', body: 'B' })).id;
    await services.mail.processOutbox();
    let [m] = await asOwner('SELECT status, attempts, last_error, next_attempt_at > now() AS later FROM mail_outbox WHERE id = $1', [bad]);
    expect(m).toEqual({ status: 'pending', attempts: 1, last_error: '421 try later', later: true });

    for (let i = 0; i < 5; i++) {
      await asOwner('UPDATE mail_outbox SET next_attempt_at = now() WHERE id = $1', [bad]);
      await services.mail.processOutbox();
    }
    [m] = await asOwner('SELECT status, attempts FROM mail_outbox WHERE id = $1', [bad]);
    expect(m).toEqual({ status: 'failed', attempts: 6 });

    // Admin HQ can send it again from the mail log.
    expect((await a.post(`/api/admin/mail/${bad}/retry`)).status).toBe(204);
    smtp.fail = null;
    await services.mail.processOutbox();
    expect((await asOwner('SELECT status FROM mail_outbox WHERE id = $1', [bad]))[0].status).toBe('sent');
  });

  it('keeps mail waiting while no SMTP server is configured', async () => {
    await services.mail.enqueue({ kind: 'test', to: ['a@corp.local'], subject: 'S', body: 'B' });
    await services.mail.processOutbox();
    expect(await asOwner('SELECT status, attempts, last_error FROM mail_outbox')).toEqual([
      { status: 'pending', attempts: 0, last_error: 'SMTP server not configured' },
    ]);
  });

  it('lists and filters the mail log, and deletes old sent and failed mail after the retention period', async () => {
    const a = await admin();
    await asOwner(`
      INSERT INTO mail_outbox (kind, recipients, subject, body, status, created_at) VALUES
        ('alert', '{x@corp.local}', 'Old sent', 'b', 'sent', now() - interval '40 days'),
        ('alert', '{x@corp.local}', 'Old pending', 'b', 'pending', now() - interval '40 days'),
        ('alert', '{y@corp.local}', 'New failed', 'b', 'failed', now() - interval '1 day')`);
    const all = await a.get('/api/admin/mail');
    expect(all.body).toMatchObject({ total: 3, counts: { sent: 1, pending: 1, failed: 1 }, retentionDays: 90 });
    expect((await a.get('/api/admin/mail').query({ status: 'failed' })).body.rows.map((r) => r.subject)).toEqual(['New failed']);
    expect((await a.get('/api/admin/mail').query({ q: 'y@corp' })).body.total).toBe(1);

    expect((await a.put('/api/admin/settings/retention', { mailDays: 30, syncDays: 180, keepAccessLog: true })).status).toBe(200);
    expect(await services.mail.purge()).toEqual({ deleted: 1 });
    expect((await asOwner('SELECT subject FROM mail_outbox ORDER BY id')).map((r) => r.subject)).toEqual(['Old pending', 'New failed']);
  });
});

describe('alert e-mails: who had no e-mail', () => {
  it('records the Admin HQ users without an e-mail on the alert mail, and keeps the alert when nobody has one', async () => {
    const a = await admin();
    await a.put('/api/admin/settings/notifications', { alertsEnabled: true, alertsAdmins: true, newComputers: false, newKeys: false });
    await addUser(pool, 'admin.two', [{ branchId: null, role: 'admin' }]); // no e-mail
    await services.notifier.send({ type: 'test', severity: 'high', subject: 'S1', text: 'B' });
    let [m] = await asOwner(`SELECT recipients, missing_recipients, status FROM mail_outbox WHERE subject = 'S1'`);
    expect(m).toEqual({ recipients: ['admin.hq@corp.local'], missing_recipients: ['admin.two'], status: 'pending' });

    await asOwner(`UPDATE app_user SET email = NULL`);
    await services.notifier.send({ type: 'test', severity: 'high', subject: 'S2', text: 'B' });
    [m] = await asOwner(`SELECT recipients, missing_recipients, status FROM mail_outbox WHERE subject = 'S2'`);
    expect(m).toEqual({ recipients: [], missing_recipients: ['admin.hq', 'admin.two'], status: 'no_recipient' });
  });
});

describe('alert e-mails', () => {
  it('queue alerts for Admin HQ and the extra addresses, or nothing when switched off', async () => {
    const a = await admin();
    await a.put('/api/admin/settings/notifications', { alertsEnabled: true, alertsAdmins: true, alertsExtra: 'security@corp.local\nSecurity@corp.local' });
    await services.notifier.send({ type: 'sync_failed', severity: 'high', subject: '[BitLocker][HIGH] AD sync failed', text: 'x' });
    const [m] = await asOwner('SELECT kind, recipients, subject FROM mail_outbox');
    expect(m).toEqual({ kind: 'alert', recipients: ['admin.hq@corp.local', 'security@corp.local'], subject: '[BitLocker][HIGH] AD sync failed' });

    await a.put('/api/admin/settings/notifications', { alertsEnabled: false });
    await services.notifier.send({ type: 'sync_failed', severity: 'high', subject: 'again', text: 'x' });
    expect((await asOwner('SELECT count(*)::int AS n FROM mail_outbox'))[0].n).toBe(1);
  });
});

describe('new computer / key e-mails', () => {
  const ingest = () => request(ingestApp);
  const dn = (name, branch) => `CN=${name},OU=Computers,OU=${branch},DC=corp,DC=local`;
  let n = 0;
  const pc = (name, branch) => ({ objectGuid: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, name, dn: dn(name, branch) });
  const key = (i, name, branch) => ({
    keyId: `${String(i).padStart(8, '0')}-1111-4000-8000-000000000000`,
    dn: `CN={K${i}},${dn(name, branch)}`,
    recoveryPassword: PWD(i),
    whenCreated: '2026-10-01T00:00:00Z',
  });
  async function run(mode, computers, keys = []) {
    const { runId } = (await ingest().post('/api/ingest/sync-runs').send({ mode, dcName: 'DC01' })).body;
    if (computers.length) await ingest().post('/api/ingest/computers').send({ runId, items: computers });
    if (keys.length) await ingest().post('/api/ingest/keys').send({ runId, items: keys });
    await ingest().post(`/api/ingest/sync-runs/${runId}/complete`).send({ status: 'success', highestUsn: 100 + runId, keysSeen: keys.length });
    return runId;
  }

  it('mails each person only the new computers and keys of their branch, never a password, and skips the first full sync', async () => {
    const a = await admin();
    await a.put('/api/admin/settings/notifications', {
      alertsEnabled: false, newComputers: true, newKeys: true, newBranchUsers: true, newAdmins: true, skipFirstFull: true,
    });
    const hn1 = pc('HN-PC-1', 'HN');
    await run('full', [hn1], [key(1, 'HN-PC-1', 'HN')]);
    expect(await asOwner('SELECT * FROM mail_outbox')).toEqual([]); // first full: everything is "new"

    const hn2 = pc('HN-PC-2', 'HN');
    const hcm1 = pc('HCM-PC-1', 'HCM');
    const runId = await run('delta', [hn2, hcm1], [key(2, 'HN-PC-2', 'HN'), key(3, 'HCM-PC-1', 'HCM')]);

    const mails = await asOwner(`SELECT recipients[1] AS rcpt, subject, body FROM mail_outbox WHERE kind = 'new_objects' ORDER BY 1`);
    expect(mails.map((m) => m.rcpt)).toEqual(['admin.hq@corp.local', 'it.hcm@corp.local', 'it.hn@corp.local']);
    const byTo = Object.fromEntries(mails.map((m) => [m.rcpt, m]));
    expect(byTo['admin.hq@corp.local'].subject).toBe(`[BitLocker] Sync ${makeRunRef(runId, new Date())}: 2 máy mới, 2 key mới`);
    expect(byTo['it.hn@corp.local'].body).toContain('HN-PC-2');
    expect(byTo['it.hn@corp.local'].body).not.toContain('HCM-PC-1');
    // The full Key ID (36 characters), not only the first 8.
    expect(byTo['it.hn@corp.local'].body).toMatch(/Key ID 00000002-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/);
    expect(byTo['it.hn@corp.local'].body).not.toContain('00000002...');
    for (const m of mails) {
      for (const i of [1, 2, 3]) expect(m.body).not.toContain(PWD(i));
    }
  });

  it('logs the mail as "no recipient", with the list and the reason, when nobody has an e-mail address', async () => {
    const a = await admin();
    await a.put('/api/admin/settings/notifications', {
      alertsEnabled: false, newComputers: true, newKeys: true, newBranchUsers: true, newAdmins: true, skipFirstFull: true,
    });
    await asOwner(`UPDATE app_user SET email = NULL`);
    await run('full', [pc('HN-PC-1', 'HN')]);
    const runId = await run('delta', [pc('HN-PC-2', 'HN')], [key(2, 'HN-PC-2', 'HN')]);

    const rows = await asOwner(`SELECT recipients, missing_recipients, status, subject, body, last_error FROM mail_outbox WHERE kind = 'new_objects'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recipients: [], status: 'no_recipient', subject: `[BitLocker] Sync ${makeRunRef(runId, new Date())}: 1 máy mới, 1 key mới` });
    expect(rows[0].missing_recipients).toEqual(['admin.hq', 'it.hn']); // it.hcm does not see HN computers
    expect(rows[0].body).toContain('HN-PC-2');
    expect(rows[0].body).not.toContain(PWD(2));
    expect(rows[0].last_error).toMatch(/Not sent: no e-mail address/);
    expect(rows[0].last_error).toContain('admin.hq'); // users without an e-mail are named
    expect(await services.mail.processOutbox()).toEqual({ sent: 0, failed: 0 }); // never picked up for sending

    const log = await a.get('/api/admin/mail?status=no_recipient');
    expect(log.body.rows).toHaveLength(1);
    expect(log.body.counts.no_recipient).toBe(1);
    const web = await webLogin(app, 'admin.hq');
    const page = await web.agent.get('/admin/mail');
    expect(page.text).toContain('Không gửi (thiếu email): 1');
    expect(page.text).toContain('Không có email: admin.hq, it.hn');
  });

  it('sends to those with an e-mail and logs, in one more row, who should have got it but has none', async () => {
    const a = await admin();
    await a.put('/api/admin/settings/notifications', {
      alertsEnabled: false, newComputers: true, newKeys: true, newBranchUsers: true, newAdmins: true, skipFirstFull: true,
    });
    await asOwner(`UPDATE app_user SET email = NULL WHERE username = 'it.hn'`);
    await run('full', [pc('HN-PC-1', 'HN')]);
    await run('delta', [pc('HN-PC-2', 'HN'), pc('HCM-PC-2', 'HCM')]);

    const rows = await asOwner(`SELECT recipients, missing_recipients, status, body FROM mail_outbox WHERE kind = 'new_objects' ORDER BY id`);
    expect(rows.filter((r) => r.status === 'pending').map((r) => r.recipients[0]).sort()).toEqual(['admin.hq@corp.local', 'it.hcm@corp.local']);
    const missed = rows.find((r) => r.status === 'no_recipient');
    expect(missed.missing_recipients).toEqual(['it.hn']);
    expect(missed.body).toContain('HN-PC-2'); // what it.hn would have received
    expect(missed.body).not.toContain('HCM-PC-2');
  });

  it('puts people who get the same list on one mail, with who it went to and who has no e-mail', async () => {
    const a = await admin();
    await a.put('/api/admin/settings/notifications', {
      alertsEnabled: false, newComputers: true, newKeys: false, newBranchUsers: false, newAdmins: true, skipFirstFull: true,
    });
    await addUser(pool, 'admin.two', [{ branchId: null, role: 'admin' }]); // no e-mail
    await asOwner(`UPDATE app_user SET email = 'admin.three@corp.local' WHERE username = 'auditor'`); // not an admin: never mailed
    await run('full', [pc('HN-PC-1', 'HN')]);
    await run('delta', [pc('HN-PC-2', 'HN')]);
    const rows = await asOwner(`SELECT recipients, missing_recipients, status FROM mail_outbox WHERE kind = 'new_objects'`);
    expect(rows).toEqual([{ recipients: ['admin.hq@corp.local'], missing_recipients: ['admin.two'], status: 'pending' }]);
  });

  it('sends nothing while both kinds are switched off (the default)', async () => {
    await run('full', [pc('HN-PC-1', 'HN')]);
    await run('delta', [pc('HN-PC-2', 'HN')]);
    expect(await asOwner("SELECT * FROM mail_outbox WHERE kind = 'new_objects'")).toEqual([]);
  });
});

describe('feature switches', () => {
  it('turns off manual sync requests and the audit CSV export', async () => {
    const a = await admin();
    expect((await a.post('/api/admin/sync-runs', { mode: 'full' })).status).toBe(202);
    const off = await a.put('/api/admin/settings/features', { 'feature.manual_sync': false, 'feature.audit_export': false });
    expect(off.body).toMatchObject({ 'feature.manual_sync': false, 'feature.audit_export': false, 'feature.reveal_alerts': false });
    const refused = await a.post('/api/admin/sync-runs', { mode: 'full' });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('feature_disabled');
    expect((await a.get('/api/audit').query({ format: 'csv' })).body.error).toBe('feature_disabled');
  });
});

describe('data alert switches (Canh bao sync)', () => {
  it('lists the switches with the thresholds, saves them on / off, and shows them on the page', async () => {
    const a = await admin();
    const first = (await a.get('/api/admin/settings/thresholds')).body;
    expect(first.alerts.map((x) => x.type)).toEqual(['escrow_broken', 'no_key_rising', 'full_stale', 'dc_cert_expiring']);
    expect(first.alerts.every((x) => x.enabled === true)).toBe(true);
    expect(first.items.find((t) => t.key === 'anomaly.escrow_ratio')).toMatchObject({ group: 'dataalerts', alert: 'escrow_broken' });
    const off = await a.put('/api/admin/settings/thresholds', { 'alert.full_stale': false, 'alert.no_key_rising': 'off' });
    expect(off.status).toBe(200);
    expect(off.body.alerts.filter((x) => !x.enabled).map((x) => x.type)).toEqual(['no_key_rising', 'full_stale']);
    expect((await a.put('/api/admin/settings/thresholds', { 'alert.full_stale': 'maybe' })).status).toBe(400);
    expect((await a.get('/api/admin/settings/features')).body['alert.full_stale']).toBeUndefined(); // not a feature any more
    const page = (await (await webLogin(app, 'admin.hq')).agent.get('/admin/settings/thresholds')).text;
    expect(page).toContain('Cảnh báo dữ liệu (bật/tắt được)');
    expect(page).toContain('name="alert.full_stale"');
  });
});

describe('thresholds', () => {
  it('shows percent values as 0-100, saves within range only, and audits the change', async () => {
    const a = await admin();
    const list = (await a.get('/api/admin/settings/thresholds')).body.items;
    const ratio = list.find((t) => t.key === 'anomaly.min_computer_ratio');
    expect(ratio).toMatchObject({ unit: 'percent', group: 'run' });
    expect(list.find((t) => t.key === 'computer.recent_months')).toMatchObject({ unit: 'months', group: 'activity', value: 3 });
    expect(ratio.value).toBe(ratio.defaultValue);
    expect(ratio.value).toBeGreaterThan(1); // shown as a percent, not a ratio

    const bad = await a.put('/api/admin/settings/thresholds', { 'anomaly.min_computer_ratio': 150, 'watchdog.delta_max_minutes': 1.5 });
    expect(bad.status).toBe(400);
    expect(bad.body.fields.map((f) => f.field).sort()).toEqual(['anomaly.min_computer_ratio', 'watchdog.delta_max_minutes']);

    const ok = await a.put('/api/admin/settings/thresholds', { 'anomaly.min_computer_ratio': 65, 'watchdog.delta_max_minutes': 90 });
    expect(ok.status).toBe(200);
    expect(ok.body.items.find((t) => t.key === 'anomaly.min_computer_ratio').value).toBe(65);
    expect(await services.settings.get('anomaly.min_computer_ratio')).toBeCloseTo(0.65);
    expect(await services.settings.get('watchdog.delta_max_minutes')).toBe(90);
    const rows = await asOwner(`SELECT detail FROM access_log WHERE action = 'admin_change' ORDER BY id DESC LIMIT 1`);
    expect(rows[0].detail.op).toBe('settings_thresholds');

    const page = await webLogin(app, 'admin.hq');
    const html = await page.agent.get('/admin/settings/thresholds');
    expect(html.status).toBe(200);
    expect(html.text).toContain('value="65"');
    expect(html.text).toContain('Cách các ngưỡng kết hợp');
    // AND pairs share one outlined box: 2 boxes (branch drop, escrow).
    expect(html.text.match(/class="thr-and"/g)).toHaveLength(2);
    expect(html.text).toMatch(/Một chi nhánh giảm quá[\s\S]*?thr-and-sep[\s\S]*?>giảm quá \(số máy\)</);
    const it = await apiLogin(app, 'it.hn');
    expect((await it.agent.get('/api/admin/settings/thresholds')).status).toBe(403);
  });
});

describe('Quản trị pages', () => {
  it('shows every admin page with the same tab bar', async () => {
    const { agent } = await webLogin(app, 'admin.hq');
    for (const p of ['/admin/branches', '/admin/users', '/admin/sync', '/admin/settings/mail-server', '/admin/settings/notifications',
      '/admin/settings/features', '/admin/settings/thresholds', '/admin/mail', '/admin/settings/retention']) {
      const res = await agent.get(p);
      expect(res.status, p).toBe(200);
      expect(res.text).toContain('class="admin-tabs"');
      expect(res.text).toMatch(new RegExp(`href="${p}" aria-current="page"`));
    }
    expect((await agent.get('/admin')).headers.location).toBe('/admin/branches');
  });

  it('is closed to everyone but Admin HQ', async () => {
    const { agent } = await webLogin(app, 'it.hn');
    expect((await agent.get('/admin/settings/mail-server')).status).toBe(403);
    expect((await agent.get('/admin/mail')).status).toBe(403);
  });
});
