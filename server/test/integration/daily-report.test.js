import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appPool, asOwner, resetDatabase, seedTwoBranches } from './db.js';
import { addUser, buildApp, webLogin } from './app.js';
import { DailyReportService } from '../../src/modules/reports/daily-report.js';

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
  await seedTwoBranches(); // HN-LT-0001 (HN), HCM-LT-0001 (HCM), SRV-0001 (N/A), one key each
  await asOwner(`
    UPDATE computer SET first_seen_at = now() - interval '30 days';
    UPDATE recovery_key SET first_synced_at = now() - interval '30 days';
    -- Yesterday: one new computer with a key in HN, HCM-LT-0001 left AD.
    INSERT INTO computer (object_guid, name, distinguished_name, branch_id, first_seen_at)
    VALUES (gen_random_uuid(), 'HN-PC-NEW', 'CN=HN-PC-NEW,OU=Computers,OU=HN,DC=corp,DC=local', 1, now() - interval '1 day');
    UPDATE computer SET deleted_in_ad_at = now() - interval '1 day' WHERE name = 'HCM-LT-0001';
    UPDATE branch SET name = '<b>Ha Noi</b>' WHERE code = 'HN';`);
  await asOwner(
    `INSERT INTO recovery_key (computer_id, key_id, recovery_password, ad_created_at, first_synced_at)
     SELECT id, 'dddddddd-0000-0000-0000-000000000004', '111111-222222-333333-444444-555555-666666-777777-888888', now(), now() - interval '1 day'
       FROM computer WHERE name = 'HN-PC-NEW'`,
  );
  await addUser(pool, 'admin.hq', [{ branchId: null, role: 'admin' }]);
  await asOwner(`UPDATE app_user SET email = 'admin@corp.local' WHERE username = 'admin.hq'`);
});

const report = (now = () => new Date()) =>
  new DailyReportService({ pool, settings: services.settings, mail: services.mail, templates: services.templates, tz: 'Asia/Ho_Chi_Minh', now });

describe('daily report', () => {
  it('counts the changes of yesterday and the totals of the last 10 days', async () => {
    const d = await report().build('yesterday');
    expect(d.changes).toMatchObject({ new_computers: 1, left_computers: 1, new_keys: 1, keys_of_left: 1 });
    expect(d.series).toHaveLength(10);
    const last = d.series[9];
    expect(last.day).toBe(d.day);
    expect(last).toMatchObject({ computers: 3, keys: 4, dComputers: 0, dKeys: 1 }); // +1 -1 computers, +1 key
    expect(d.byBranch.map((b) => b.code).sort()).toEqual(['HCM', 'HN']);
    expect(d.sync).toMatchObject({ online: true, workers: [], quarantined: 0, duplicates: 0 });
  });

  it('renders text and HTML: sync status, charts, escaped names, never a password', async () => {
    const r = report();
    const m = r.render(await r.build('yesterday'));
    expect(m.subject).toMatch(/^Báo cáo BitLocker \d\d\/\d\d\/\d{4}: đồng bộ AD Online, máy 0, key \+1$/);
    expect(m.text).toContain('MÁY: 3 (0): 1 mới ghi nhận, 1 không còn trong AD');
    expect(m.text).toContain('Chưa có worker nào gửi heartbeat');
    expect(m.html).toContain('Số máy, 10 ngày gần nhất');
    expect(m.html).toContain('&lt;b&gt;Ha Noi&lt;/b&gt;');
    expect(m.html).not.toContain('<b>Ha Noi</b>');
    for (const part of [m.text, m.html]) expect(part).not.toMatch(/\d{6}-\d{6}-\d{6}/);
  });

  it('sends once a day after the configured time, only when turned on', async () => {
    const r = report();
    expect(await r.tick()).toEqual({ skipped: 'disabled' });
    await services.settings.set('notify.daily_report', { enabled: true, time: '00:00', period: 'yesterday', admins: true, extra: ['boss@corp.local'] });
    const sent = await r.tick();
    expect(sent).toMatchObject({ queued: true, recipients: 2 });
    expect(await r.tick()).toEqual({ skipped: 'sent' });
    const mails = await asOwner(`SELECT kind, recipients, html IS NOT NULL AS has_html FROM mail_outbox WHERE kind = 'daily_report'`);
    expect(mails).toEqual([{ kind: 'daily_report', recipients: ['admin@corp.local', 'boss@corp.local'], has_html: true }]);
    await services.settings.set('notify.daily_report', { enabled: true, time: '23:59', period: 'yesterday', admins: true, extra: [] });
    await asOwner(`DELETE FROM app_setting WHERE key = 'notify.daily_report.last_day'`);
    const early = report(() => new Date('2026-10-16T00:30:00Z')); // 07:30 in Ha Noi
    expect(await early.tick()).toEqual({ skipped: 'not_yet' });
  });

  it('is configured in Quan tri > Thong bao, can be sent now and viewed as HTML', async () => {
    const web = await webLogin(app, 'admin.hq');
    const page = await web.agent.get('/admin/settings/notifications');
    expect(page.text).toContain('Báo cáo hằng ngày');
    const saved = await web.agent.post('/admin/settings/notifications').type('form').send({
      _csrf: web.csrf, alertsEnabled: 'on', alertsAdmins: 'on', alertsExtra: '', maxItems: '100',
      reportEnabled: 'on', reportTime: '06:45', reportPeriod: 'today', reportAdmins: 'on', reportExtra: 'boss@corp.local',
    });
    expect(saved.status).toBe(302);
    services.settings.invalidate();
    expect(await services.settings.get('notify.daily_report')).toEqual({ enabled: true, time: '06:45', period: 'today', admins: true, extra: ['boss@corp.local'] });
    const bad = await web.agent.post('/admin/settings/notifications').type('form').send({ _csrf: web.csrf, maxItems: '100', reportTime: '25:00' });
    expect(bad.status).toBe(400);

    const now = await web.agent.post('/admin/settings/notifications/daily-report/send').type('form').send({ _csrf: web.csrf });
    expect(now.status).toBe(302);
    const [{ id }] = await asOwner(`SELECT id FROM mail_outbox WHERE kind = 'daily_report'`);
    expect(now.headers.location).toBe(`/admin/mail/${id}`);
    expect((await web.agent.get(`/admin/mail/${id}`)).text).toContain('Xem bản HTML');
    const html = await web.agent.get(`/admin/mail/${id}/html`);
    expect(html.status).toBe(200);
    expect(html.headers['content-security-policy']).toMatch(/^sandbox/);
    expect(html.text).toContain('Đồng bộ AD');
  });
});
