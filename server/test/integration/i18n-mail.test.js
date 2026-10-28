import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appPool, asOwner, resetDatabase, seedTwoBranches } from './db.js';
import { addUser, buildApp, webLogin } from './app.js';
import { DailyReportService } from '../../src/modules/reports/daily-report.js';

// Emails, the daily report and the Excel export follow the language of the person they are for.

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
  await seedTwoBranches();
  await addUser(pool, 'admin.vi', [{ branchId: null, role: 'admin' }]); // Vietnamese (test default)
  await addUser(pool, 'admin.en', [{ branchId: null, role: 'admin' }]);
  await addUser(pool, 'auditor', [{ branchId: 1, role: 'auditor' }]);
  await asOwner(`UPDATE app_user SET email = username || '@corp.local'`);
  await asOwner(`UPDATE app_user SET language = 'en' WHERE username IN ('admin.en', 'auditor')`);
});

const alertMails = () => asOwner(`SELECT subject, body, recipients FROM mail_outbox WHERE kind = 'alert' ORDER BY id`);

describe('alert e-mails', () => {
  it('each recipient gets the mail in their own language; a plain address gets English', async () => {
    await services.settings.set('notify.alerts', { ad: { enabled: true, admins: true, extra: ['team@corp.local'] } });
    await services.alerts.notifyOnce('sync_failed', 'high', { runId: 7, runRef: '20261028-0007', mode: 'full', dc: 'DC01', errorCode: 'ldap_bind_failed' });
    const mails = await alertMails();
    expect(mails).toHaveLength(2);
    const vi = mails.find((m) => m.recipients.includes('admin.vi@corp.local'));
    const en = mails.find((m) => m.recipients.includes('admin.en@corp.local'));
    expect(vi.recipients).toEqual(['admin.vi@corp.local']);
    expect(vi.subject).toBe('[BitLocker][HIGH] Sync AD lỗi: ldap_bind_failed');
    expect(en.recipients).toEqual(['admin.en@corp.local', 'team@corp.local']);
    expect(en.subject).toBe('[BitLocker][HIGH] AD sync failed: ldap_bind_failed');
    expect(en.body).toContain('Sync run 20261028-0007');
  });

  it('the watchdog summary lists the problems in the recipient\'s language, and the alert row keeps both', async () => {
    const subject = await services.alerts.record('sync_stale', 'high', { maxMinutes: 60, lastRunId: 1, lastRunAt: 'now' });
    expect(subject).toEqual({ vi: 'Không có lượt sync thành công quá 60 phút', en: 'No successful sync run for more than 60 minutes' });
    const [row] = await asOwner(`SELECT detail FROM sync_alert WHERE type = 'sync_stale'`);
    expect(row.detail).toMatchObject({ subject: subject.vi, subject_en: subject.en });
    await services.alerts.raise('sync_problem', 'high', (lang) => ({ count: 1, conditions: `- ${subject[lang]}`, checkedAt: 'now' }));
    const mails = await alertMails();
    expect(mails.find((m) => m.recipients.includes('admin.vi@corp.local')).body).toContain('Không có lượt sync thành công quá 60 phút');
    expect(mails.find((m) => m.recipients.includes('admin.en@corp.local')).body).toContain('No successful sync run for more than 60 minutes');
  });

  it('a recovery mail is in the recipient\'s language too', async () => {
    await services.alerts.record('sync_stale', 'high', { maxMinutes: 60, lastRunId: 1, lastRunAt: 'now' });
    await services.alerts.clear('sync_stale');
    const mails = await alertMails();
    expect(mails.find((m) => m.recipients.includes('admin.vi@corp.local')).subject).toBe('[BitLocker][INFO] Đã khôi phục: Không có lượt sync thành công quá 60 phút');
    expect(mails.find((m) => m.recipients.includes('admin.en@corp.local')).subject).toBe('[BitLocker][INFO] Recovered: No successful sync run for more than 60 minutes');
  });
});

describe('daily report', () => {
  it('is rendered in English or Vietnamese from the same figures', async () => {
    const r = new DailyReportService({ pool, settings: services.settings, mail: services.mail, templates: services.templates, tz: 'Asia/Ho_Chi_Minh' });
    const data = await r.build('yesterday');
    const en = r.render(data, 'en');
    const vi = r.render(data, 'vi');
    expect(en.subject).toMatch(/^BitLocker report \d\d\/\d\d\/\d{4}: worker Online, AD normal, computers /);
    expect(en.text).toContain('SHARE OF COMPUTERS WITH A KEY');
    expect(en.html).toContain('lang="en"');
    expect(vi.subject).toMatch(/^Báo cáo BitLocker /);
    expect(vi.text).toContain('TỈ LỆ MÁY CÓ KEY');
    expect(en.text).not.toMatch(/[ạảãâấầẩẫậăắằẳẵặéèẻẽẹêếềểễệíìỉĩịóòỏõọôốồổỗộơớờởỡợúùủũụưứừửữựýỳỷỹỵđ]/i);
    expect(en.html).not.toMatch(/[ạảãâấầẩẫậăắằẳẵặéèẻẽẹêếềểễệíìỉĩịóòỏõọôốồổỗộơớờởỡợúùủũụưứừửữựýỳỷỹỵđ]/i);
  });

  it('sends one mail per language', async () => {
    await services.settings.set('notify.daily_report', { enabled: true, time: '00:00', period: 'yesterday', admins: true, extra: [] });
    const r = new DailyReportService({ pool, settings: services.settings, mail: services.mail, templates: services.templates, tz: 'Asia/Ho_Chi_Minh' });
    await r.send();
    const mails = await asOwner(`SELECT recipients, subject FROM mail_outbox WHERE kind = 'daily_report' ORDER BY id`);
    expect(mails).toHaveLength(2);
    expect(mails.find((m) => m.recipients.includes('admin.vi@corp.local')).subject).toMatch(/^Báo cáo BitLocker/);
    expect(mails.find((m) => m.recipients.includes('admin.en@corp.local')).subject).toMatch(/^BitLocker report/);
  });
});

describe('Excel export', () => {
  const unzip = (buf) => {
    const files = {};
    let i = 0;
    while (i + 30 < buf.length && buf.readUInt32LE(i) === 0x04034b50) {
      const method = buf.readUInt16LE(i + 8);
      const size = buf.readUInt32LE(i + 18);
      const nameLen = buf.readUInt16LE(i + 26);
      const extraLen = buf.readUInt16LE(i + 28);
      const name = buf.toString('utf8', i + 30, i + 30 + nameLen);
      const data = buf.subarray(i + 30 + nameLen + extraLen, i + 30 + nameLen + extraLen + size);
      files[name] = (method === 8 ? inflateRawSync(data) : data).toString('utf8');
      i += 30 + nameLen + extraLen + size;
    }
    return files;
  };
  const exportAs = async (username) => {
    const { agent } = await webLogin(app, username);
    const res = await agent.get('/reports/export.xlsx').buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    return unzip(res.body);
  };

  it('headers and sheet names follow the language of the person exporting', async () => {
    const en = await exportAs('auditor');
    const sheetNames = [...en['xl/workbook.xml'].matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
    expect(sheetNames).toContain('Overview');
    expect(sheetNames.every((n) => n.length <= 31)).toBe(true);
    const text = Object.values(en).join(' ');
    expect(text).toContain('BitLocker recovery key report');
    expect(text).not.toMatch(/[ạảãâấầẩẫậăắằẳẵặéèẻẽẹêếềểễệíìỉĩịóòỏõọôốồổỗộơớờởỡợúùủũụưứừửữựýỳỷỹỵđ]/i);
    await asOwner(`UPDATE app_user SET language = 'vi' WHERE username = 'auditor'`);
    const vi = await exportAs('auditor');
    expect(Object.values(vi).join(' ')).toContain('Báo cáo BitLocker recovery key');
  });
});
