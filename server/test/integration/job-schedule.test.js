import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { appPool, asOwner, resetDatabase } from './db.js';
import { addUser, buildApp, webLogin } from './app.js';
import { Scheduler } from '../../src/jobs/scheduler.js';
import { JOB_SCHEDULE, jobMinutes, jobTime } from '../../src/jobs/job-schedule.js';

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

describe('scheduler reads the interval at every tick', () => {
  afterEach(() => vi.useRealTimers());

  it('follows a changed interval without a restart', async () => {
    vi.useFakeTimers();
    const client = { query: async () => ({ rows: [{ ok: true }] }), release() {} };
    const scheduler = new Scheduler({ pool: { connect: async () => client }, logger: { debug() {}, error() {} }, tz: 'UTC' });
    let minutes = 1;
    let runs = 0;
    scheduler.every('t', async () => minutes, () => { runs += 1; }, 1_000);

    await vi.advanceTimersByTimeAsync(2_000); // the first run, after the delay
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(40_000); // not yet a minute since
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(40_000); // a minute has passed (checked every 15 s)
    expect(runs).toBe(2);

    minutes = 5; // changed on the screen
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(runs).toBe(2);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(runs).toBe(3);
    scheduler.stop();
  });

  it('a daily job follows a changed time of day', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-18T01:00:00Z') });
    const client = { query: async () => ({ rows: [{ ok: true }] }), release() {} };
    const scheduler = new Scheduler({ pool: { connect: async () => client }, logger: { debug() {}, error() {} }, tz: 'UTC' });
    let at = '03:00';
    let runs = 0;
    scheduler.daily('d', async () => at, () => { runs += 1; });
    await vi.advanceTimersByTimeAsync(90 * 60_000); // 02:30
    expect(runs).toBe(0);
    at = '02:15'; // moved earlier, already past
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(20 * 60 * 60_000); // 22:31, not again the same day
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(5 * 60 * 60_000); // 03:31 the next day: once more
    expect(runs).toBe(2);
    scheduler.stop();
  });
});

describe('job schedule settings', () => {
  it('have defaults, and a wrong stored value falls back to the default', async () => {
    expect(await jobMinutes(services.settings, JOB_SCHEDULE.mailIntervalMinutes)).toBe(1);
    expect(await jobMinutes(services.settings, JOB_SCHEDULE.watchdogIntervalMinutes)).toBe(5);
    expect(await jobTime(services.settings, JOB_SCHEDULE.retentionTime)).toBe('03:00');
    await services.settings.set(JOB_SCHEDULE.mailIntervalMinutes.key, 0);
    await services.settings.set(JOB_SCHEDULE.retentionTime.key, '25:99');
    expect(await jobMinutes(services.settings, JOB_SCHEDULE.mailIntervalMinutes)).toBe(1);
    expect(await jobTime(services.settings, JOB_SCHEDULE.retentionTime)).toBe('03:00');
  });
});

describe('Quan tri: job schedules on their pages', () => {
  it('show the defaults and save changes (mail interval, clean-up time, watchdog interval)', async () => {
    const web = await webLogin(app, 'admin.hq');
    expect((await web.agent.get('/admin/settings/mail-server')).text).toMatch(/name="sendIntervalMinutes" value="1"/);
    expect((await web.agent.get('/admin/settings/retention')).text).toMatch(/name="runAt" value="03:00"/);
    expect((await web.agent.get('/admin/settings/thresholds')).text).toContain('Watchdog kiểm tra mỗi (phút)');

    const smtp = { _csrf: web.csrf, host: 'smtp.corp.local', port: '25', security: 'none', from: 'bl@corp.local', sendIntervalMinutes: '10' };
    expect((await web.agent.post('/admin/settings/mail-server').type('form').send(smtp)).status).toBe(302);
    expect((await web.agent.post('/admin/settings/mail-server').type('form').send({ ...smtp, sendIntervalMinutes: '0' })).status).toBe(400);
    expect((await web.agent.post('/admin/settings/mail-server').type('form').send({ ...smtp, sendIntervalMinutes: '61' })).status).toBe(400);

    const retention = { _csrf: web.csrf, mailDays: '90', syncDays: '180', keepAccessLog: 'on', runAt: '04:30' };
    expect((await web.agent.post('/admin/settings/retention').type('form').send(retention)).status).toBe(302);
    expect((await web.agent.post('/admin/settings/retention').type('form').send({ ...retention, runAt: '25:00' })).status).toBe(400);

    const security = { _csrf: web.csrf, pwMinLength: '12', idleMinutes: '15', maxHours: '8' };
    expect((await web.agent.post('/admin/settings/security').type('form').send(security)).status).toBe(302);
    expect((await web.agent.post('/admin/settings/security').type('form').send({ ...security, pwMinLength: 'xx' })).status).toBe(400);

    services.settings.invalidate();
    expect(await jobMinutes(services.settings, JOB_SCHEDULE.mailIntervalMinutes)).toBe(10);
    expect(await jobTime(services.settings, JOB_SCHEDULE.retentionTime)).toBe('04:30');
    // The interval does not end up in the SMTP settings object.
    const [{ value }] = await asOwner(`SELECT value FROM app_setting WHERE key = 'mail.smtp'`);
    expect(value).not.toHaveProperty('sendIntervalMinutes');
    const log = await asOwner(`SELECT detail FROM access_log WHERE action = 'admin_change' ORDER BY id`);
    expect(log.some((l) => l.detail.op === 'settings_smtp' && l.detail.sendIntervalMinutes === 10)).toBe(true);
    expect(log.some((l) => l.detail.op === 'settings_retention' && l.detail.runAt === '04:30')).toBe(true);
    expect(log.some((l) => l.detail.op === 'settings_security')).toBe(true);
  });

  it('the watchdog interval is a threshold with its default and limits', async () => {
    const web = await webLogin(app, 'admin.hq');
    const page = (await web.agent.get('/admin/settings/thresholds')).text;
    expect(page).toMatch(/name="jobs.watchdog_interval_minutes"[^>]*value="5"/);
    const form = { _csrf: web.csrf };
    // Posting the thresholds form with the interval out of range is refused, a valid one is saved.
    const defaults = Object.fromEntries([...page.matchAll(/name="([^"]+)" type="number" value="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    expect((await web.agent.post('/admin/settings/thresholds').type('form').send({ ...form, ...defaults, 'jobs.watchdog_interval_minutes': '0' })).status).toBe(400);
    expect((await web.agent.post('/admin/settings/thresholds').type('form').send({ ...form, ...defaults, 'jobs.watchdog_interval_minutes': '2' })).status).toBe(302);
    services.settings.invalidate();
    expect(await jobMinutes(services.settings, JOB_SCHEDULE.watchdogIntervalMinutes)).toBe(2);
  });
});
