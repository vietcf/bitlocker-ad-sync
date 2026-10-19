import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appPool, asOwner, resetDatabase } from './db.js';
import { addUser, apiLogin, buildApp, webLogin } from './app.js';
import { alertGroupOf, loadAlertOptions } from '../../src/modules/alerts/notifier.js';

let pool;
let app;
let services;

beforeAll(() => {
  pool = appPool();
  ({ app, services } = buildApp(pool, { notifier: 'real' }));
});
afterAll(() => pool?.end());
beforeEach(async () => {
  await resetDatabase();
  services.settings.invalidate();
  await addUser(pool, 'admin.hq', [{ branchId: null, role: 'admin' }]);
  await asOwner(`UPDATE app_user SET email = 'admin.hq@corp.local'`);
});

const mails = async () => (await asOwner(`SELECT subject, recipients FROM mail_outbox WHERE kind = 'alert' ORDER BY id`));
const send = (type) => services.notifier.send({ type, severity: 'high', subject: type, text: 'x' });

describe('alert mails in three groups', () => {
  it('maps every alert type to a group, recovered messages with their type, unknown types to the AD group', () => {
    expect(alertGroupOf('worker_offline')).toBe('agent');
    expect(alertGroupOf('worker_offline_recovered')).toBe('agent');
    for (const t of ['sync_problem', 'sync_failed', 'sync_anomaly', 'key_duplicate', 'something_new']) expect(alertGroupOf(t)).toBe('ad');
    for (const t of ['reveal_out_of_hours', 'key_export']) expect(alertGroupOf(t)).toBe('key');
    for (const t of ['backup_failed', 'backup_failed_recovered']) expect(alertGroupOf(t)).toBe('backup');
  });

  it('each group is switched on or off on its own, and has its own extra addresses', async () => {
    const s = await apiLogin(app, 'admin.hq');
    const r = await s.agent.put('/api/admin/settings/notifications').set('X-CSRF-Token', s.csrf).send({
      alertsAgentEnabled: false,
      alertsAdEnabled: true, alertsAdAdmins: false, alertsAdExtra: 'ad-team@corp.local',
      alertsKeyEnabled: true, alertsKeyAdmins: true, alertsKeyExtra: 'security@corp.local',
    });
    expect(r.status).toBe(200);
    services.settings.invalidate();
    await send('worker_offline');
    await send('sync_failed');
    await send('reveal_out_of_hours');
    await send('backup_failed');
    expect(await mails()).toEqual([
      { subject: 'sync_failed', recipients: ['ad-team@corp.local'] },
      { subject: 'reveal_out_of_hours', recipients: ['admin.hq@corp.local', 'security@corp.local'] },
    ]);
  });

  it('a setting saved before the groups existed applies to all three', async () => {
    await services.settings.set('notify.alerts', { enabled: false, admins: true, extra: [] });
    const groups = Object.values(await loadAlertOptions(services.settings));
    expect(groups).toHaveLength(4);
    expect(groups.every((g) => g.enabled === false)).toBe(true);
    await send('worker_offline');
    expect(await mails()).toEqual([]);
    await services.settings.set('notify.alerts', { enabled: true, admins: true, extra: ['all@corp.local'] });
    await send('key_export');
    expect((await mails())[0].recipients).toEqual(['admin.hq@corp.local', 'all@corp.local']);
  });

  it('the web page shows the three groups and saves them', async () => {
    const web = await webLogin(app, 'admin.hq');
    const page = (await web.agent.get('/admin/settings/notifications')).text;
    for (const t of ['Agent (worker) ngừng hoạt động', 'Kết nối AD và đồng bộ có vấn đề', 'Xem key ngoài giờ và bảo mật dữ liệu', 'Sao lưu</legend>']) expect(page).toContain(t);
    const save = await web.agent.post('/admin/settings/notifications').type('form').send({ _csrf: web.csrf, alertsAgentEnabled: 'on', alertsAgentAdmins: 'on', alertsAgentExtra: '', alertsAdExtra: '', alertsKeyExtra: '', maxItems: '100' });
    expect(save.status).toBe(302);
    services.settings.invalidate();
    const o = await loadAlertOptions(services.settings);
    expect([o.agent.enabled, o.ad.enabled, o.key.enabled, o.backup.enabled]).toEqual([true, false, false, false]);
  });
});
