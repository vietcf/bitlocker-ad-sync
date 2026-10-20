import { z } from 'zod';
import { can } from '../../domain/scope.js';
import { checkbox, id, page as pageNo, parse } from '../../http/validate.js';
import { badRequest, forbidden, notFound } from '../../http/errors.js';
import { ALERT_GROUPS, loadAlertOptions } from '../alerts/notifier.js';
import { getMail, listMails, mailCounts, retryMail } from '../mail/mail.repo.js';
import { SMTP_DEFAULTS } from '../mail/mail.service.js';
import { NEW_OBJECTS_DEFAULTS } from '../mail/new-objects.js';
import { DAILY_REPORT_DEFAULTS } from '../reports/daily-report.js';
import { JOB_SCHEDULE, TIME_OF_DAY, jobMinutes, jobTime } from '../../jobs/job-schedule.js';
import { LOCKOUT_DEFAULTS, LOCKOUT_LIMITS, loadLockoutPolicy } from '../auth/lockout.js';
import { PASSWORD_LENGTH_LIMITS, describePasswordPolicy, loadPasswordPolicy } from '../auth/password.js';
import { encryptSecret } from '../mail/secret.js';
import { ALERT_SWITCHES, CHECK_SWITCHES, FEATURES } from './settings.service.js';
import { KEY_EXPORT_MODES } from '../keys/keys.service.js';
import { RETENTION_LIMITS } from './retention.service.js';
import { THRESHOLDS, fromForm, toForm } from './thresholds.js';

import { PAGE_SIZES, PAGE_SIZE_LIMITS, pageSize } from './page-size.js';

const email = z.string().trim().toLowerCase().max(254).pipe(z.email({ message: 'invalid_email' }));
/** Textarea lines / commas (or a JSON array) -> unique e-mails. */
const emailList = z.preprocess(
  (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[\s,;]+/)).map((s) => String(s).trim()).filter(Boolean),
  z.array(email).max(50).transform((l) => [...new Set(l)]),
);

const smtpInput = z.object({
  enabled: checkbox,
  host: z.string().trim().max(255),
  port: z.coerce.number().int().min(1).max(65535),
  security: z.enum(['none', 'starttls', 'tls']),
  username: z.string().trim().max(255).default(''),
  // Empty = keep the stored password; clearPassword removes it.
  password: z.string().max(512).optional(),
  clearPassword: checkbox,
  from: email,
  // Bo trong (API) = kiem tra chung chi; form web luon gui 'on'/'off'.
  rejectUnauthorized: z.preprocess((v) => (v === undefined ? 'on' : v), checkbox),
  appUrl: z.preprocess((v) => (v === '' ? undefined : v), z.url({ protocol: /^https?$/ }).max(255).optional()),
  // How often the mail job sends what is waiting (minutes).
  sendIntervalMinutes: z.coerce.number().int().min(JOB_SCHEDULE.mailIntervalMinutes.min).max(JOB_SCHEDULE.mailIntervalMinutes.max)
    .default(JOB_SCHEDULE.mailIntervalMinutes.default),
}).superRefine((s, ctx) => {
  if (s.enabled && !s.host) ctx.addIssue({ code: 'custom', path: ['host'], message: 'host_required' });
});

// Per group of alert mails: alertsAgentEnabled / alertsAgentAdmins / alertsAgentExtra, same for Ad, Key and Backup.
const GROUP_FIELDS = { agent: 'Agent', ad: 'Ad', key: 'Key', backup: 'Backup' };
const alertGroupShape = Object.fromEntries(Object.values(GROUP_FIELDS).flatMap((G) => [
  [`alerts${G}Enabled`, checkbox], [`alerts${G}Admins`, checkbox], [`alerts${G}Extra`, emailList],
]));
const notifyInput = z.object({
  // One set for all groups (older clients): used for a group whose own fields are not sent.
  alertsEnabled: checkbox,
  alertsAdmins: checkbox,
  alertsExtra: emailList,
  ...alertGroupShape,
  newComputers: checkbox,
  newKeys: checkbox,
  newBranchUsers: checkbox,
  newAdmins: checkbox,
  skipFirstFull: checkbox,
  maxItems: z.coerce.number().int().min(10).max(1000).default(100),
  reportEnabled: checkbox,
  reportTime: z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'invalid_time').default(DAILY_REPORT_DEFAULTS.time),
  reportPeriod: z.enum(['yesterday', 'today']).default(DAILY_REPORT_DEFAULTS.period),
  reportAdmins: checkbox,
  reportExtra: emailList,
});

/** Quan tri > Bao mat: session limits (minutes without any request; hours after sign-in). */
export const SESSION_LIMITS = { idleMinutes: [5, 480], maxHours: [1, 24] };
const securityInput = z.object({
  pwMinLength: z.coerce.number().int().min(PASSWORD_LENGTH_LIMITS[0]).max(PASSWORD_LENGTH_LIMITS[1]),
  pwUpper: checkbox,
  pwLower: checkbox,
  pwDigit: checkbox,
  pwSpecial: checkbox,
  idleMinutes: z.coerce.number().int().min(SESSION_LIMITS.idleMinutes[0]).max(SESSION_LIMITS.idleMinutes[1]),
  maxHours: z.coerce.number().int().min(SESSION_LIMITS.maxHours[0]).max(SESSION_LIMITS.maxHours[1]),
  // Locking an account after wrong passwords.
  lockEnabled: checkbox,
  lockAttempts: z.coerce.number().int().min(LOCKOUT_LIMITS.maxAttempts[0]).max(LOCKOUT_LIMITS.maxAttempts[1]).default(LOCKOUT_DEFAULTS.maxAttempts),
  lockMinutes: z.coerce.number().int().min(LOCKOUT_LIMITS.lockMinutes[0]).max(LOCKOUT_LIMITS.lockMinutes[1]).default(LOCKOUT_DEFAULTS.lockMinutes),
  lockAdmin: checkbox,
});

const days = ([min, max]) => z.coerce.number().int().min(min).max(max);
const retentionInput = z.object({
  mailDays: days(RETENTION_LIMITS.mailDays),
  syncDays: days(RETENTION_LIMITS.syncDays),
  // Checked = never delete the access log (the default).
  keepAccessLog: checkbox,
  accessLogDays: z.preprocess((v) => (v === '' || v === null ? undefined : v), days(RETENTION_LIMITS.accessLogDays).optional()),
  // Time of day of the daily clean-up.
  runAt: z.string().trim().regex(TIME_OF_DAY, 'invalid_time').default(JOB_SCHEDULE.retentionTime.default),
}).superRefine((r, ctx) => {
  if (!r.keepAccessLog && !r.accessLogDays) ctx.addIssue({ code: 'custom', path: ['accessLogDays'], message: 'access_log_days_required' });
});
const testInput = z.object({ to: email });
const mailQuery = z.object({
  status: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['pending', 'sent', 'failed', 'no_recipient']).optional()),
  q: z.string().trim().max(100).default(''),
  page: pageNo,
});

/** Admin HQ > Quan tri: mail server, notifications, feature switches, mail log. Every change is audited. */
export class SettingsAdminService {
  constructor({ pool, settings, audit, mail, secretKey, retention, dailyReport = null, sessionDefaults = { idleMinutes: 15, maxHours: 8 } }) {
    this.sessionDefaults = sessionDefaults;
    this.dailyReport = dailyReport;
    this.pool = pool;
    this.settings = settings;
    this.audit = audit;
    this.mail = mail;
    this.secretKey = secretKey;
    this.retention = retention;
  }

  #check(scope) {
    if (!can(scope, 'admin')) throw forbidden();
  }

  #log(scope, client, detail) {
    return this.audit.log({ ...this.audit.actor(scope, client), action: 'admin_change', detail });
  }

  // ---- read -----------------------------------------------------------------------------

  /** SMTP settings without the password (only whether one is stored). */
  async smtp(scope) {
    this.#check(scope);
    const { password, ...s } = { ...SMTP_DEFAULTS, ...(await this.settings.get('mail.smtp', {})) };
    return { ...s, passwordSet: !!password, sendIntervalMinutes: await jobMinutes(this.settings, JOB_SCHEDULE.mailIntervalMinutes) };
  }

  async notifications(scope) {
    this.#check(scope);
    return {
      alerts: await loadAlertOptions(this.settings),
      alertGroups: ALERT_GROUPS,
      newObjects: { ...NEW_OBJECTS_DEFAULTS, ...(await this.settings.get('notify.new_objects', {})) },
      dailyReport: {
        ...DAILY_REPORT_DEFAULTS,
        ...(await this.settings.get('notify.daily_report', {})),
        lastDay: this.dailyReport ? await this.dailyReport.lastDay() : null,
      },
    };
  }

  /** Session limits now in force, and the .env defaults. */
  async security(scope) {
    this.#check(scope);
    return {
      idleMinutes: Number(await this.settings.get('session.idle_minutes', this.sessionDefaults.idleMinutes)),
      maxHours: Number(await this.settings.get('session.max_hours', this.sessionDefaults.maxHours)),
      defaults: this.sessionDefaults,
      limits: { ...SESSION_LIMITS, pwMinLength: PASSWORD_LENGTH_LIMITS },
      lockout: await loadLockoutPolicy(this.settings),
      lockoutLimits: LOCKOUT_LIMITS,
      password: await loadPasswordPolicy(this.settings),
      passwordText: describePasswordPolicy(await loadPasswordPolicy(this.settings)),
    };
  }

  async saveSecurity(scope, raw, client = {}) {
    this.#check(scope);
    const input = parse(securityInput, raw);
    if (input.idleMinutes > input.maxHours * 60) {
      throw badRequest('idle_longer_than_max', 'The idle time cannot be longer than the maximum session length.');
    }
    const password = { minLength: input.pwMinLength, upper: input.pwUpper, lower: input.pwLower, digit: input.pwDigit, special: input.pwSpecial };
    await this.settings.set('session.idle_minutes', input.idleMinutes);
    await this.settings.set('session.max_hours', input.maxHours);
    await this.settings.set('password.policy', password);
    const lockout = { enabled: input.lockEnabled, maxAttempts: input.lockAttempts, lockMinutes: input.lockMinutes, applyToAdmin: input.lockAdmin };
    await this.settings.set('security.lockout', lockout);
    await this.#log(scope, client, { op: 'settings_security', idleMinutes: input.idleMinutes, maxHours: input.maxHours, lockout, password });
  }

  /** Builds and queues the daily report now ("Gui thu ngay"); does not count as today's report. */
  async sendDailyReportNow(scope, client = {}) {
    this.#check(scope);
    const r = await this.dailyReport.send();
    await this.#log(scope, client, { op: 'daily_report_send_now', mailId: r.id, queued: r.queued });
    return r;
  }

  async features(scope) {
    this.#check(scope);
    const pageSizes = {};
    for (const spec of Object.values(PAGE_SIZES)) pageSizes[spec.key] = await pageSize(this.settings, spec);
    return { ...(await this.settings.features()), 'export.keys': await this.settings.get('export.keys', 'off'), ...pageSizes };
  }

  async mailLog(scope, raw) {
    this.#check(scope);
    const { page, ...filters } = parse(mailQuery, raw);
    const PAGE_SIZE = await pageSize(this.settings, PAGE_SIZES.mail);
    const r = await listMails(this.pool, filters, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
    return {
      ...r,
      filters,
      page,
      pageSize: PAGE_SIZE,
      pages: Math.max(1, Math.ceil(r.total / PAGE_SIZE)),
      counts: await mailCounts(this.pool),
      retentionDays: Number(await this.settings.get('mail.retention_days', 90)),
    };
  }

  async mailDetail(scope, mailId) {
    this.#check(scope);
    const m = await getMail(this.pool, parse(id, mailId));
    if (!m) throw notFound('Mail not found.');
    return m;
  }

  // ---- write ----------------------------------------------------------------------------

  async saveSmtp(scope, raw, client = {}) {
    this.#check(scope);
    const { password, clearPassword, sendIntervalMinutes, ...input } = parse(smtpInput, raw);
    const before = { ...SMTP_DEFAULTS, ...(await this.settings.get('mail.smtp', {})) };
    let stored = before.password;
    if (clearPassword) stored = null;
    else if (password) stored = encryptSecret(this.secretKey, password);
    await this.settings.set('mail.smtp', { ...input, appUrl: input.appUrl ?? '', password: stored });
    await this.settings.set(JOB_SCHEDULE.mailIntervalMinutes.key, sendIntervalMinutes);
    await this.#log(scope, client, {
      op: 'settings_smtp',
      ...input,
      sendIntervalMinutes,
      passwordChanged: stored !== before.password, // never the password itself
    });
  }

  /** Sends a test mail with the saved SMTP settings; returns { ok, error }. */
  async testSmtp(scope, raw, client = {}) {
    this.#check(scope);
    const { to } = parse(testInput, raw);
    const smtp = { ...SMTP_DEFAULTS, ...(await this.settings.get('mail.smtp', {})) };
    if (!smtp.host) throw badRequest('smtp_not_configured', 'Save the SMTP server settings first.');
    let error = null;
    try {
      await this.mail.sendTest(to, smtp);
    } catch (err) {
      error = String(err.message ?? err).slice(0, 300);
    }
    await this.#log(scope, client, { op: 'settings_smtp_test', to, ok: !error });
    return { ok: !error, error };
  }

  async saveNotifications(scope, raw, client = {}) {
    this.#check(scope);
    const n = parse(notifyInput, raw);
    const alerts = {};
    for (const [group, G] of Object.entries(GROUP_FIELDS)) {
      const own = (f) => raw?.[`alerts${G}${f}`] !== undefined;
      alerts[group] = {
        enabled: own('Enabled') ? n[`alerts${G}Enabled`] : n.alertsEnabled,
        admins: own('Admins') ? n[`alerts${G}Admins`] : n.alertsAdmins,
        extra: own('Extra') ? n[`alerts${G}Extra`] : n.alertsExtra,
      };
    }
    const newObjects = {
      computers: n.newComputers,
      keys: n.newKeys,
      branchUsers: n.newBranchUsers,
      admins: n.newAdmins,
      skipFirstFull: n.skipFirstFull,
      maxItems: n.maxItems,
    };
    const before = { ...DAILY_REPORT_DEFAULTS, ...(await this.settings.get('notify.daily_report', {})) };
    const dailyReport = { enabled: n.reportEnabled, time: n.reportTime, period: n.reportPeriod, admins: n.reportAdmins, extra: n.reportExtra };
    await this.settings.set('notify.alerts', alerts);
    await this.settings.set('notify.new_objects', newObjects);
    await this.settings.set('notify.daily_report', dailyReport);
    // Turned on (or time changed) after today's sending time: the first report goes out tomorrow,
    // not right away.
    if (this.dailyReport && dailyReport.enabled && (!before.enabled || before.time !== dailyReport.time)
      && this.dailyReport.localNow().time >= dailyReport.time) {
      await this.dailyReport.skipToday();
    }
    await this.#log(scope, client, { op: 'settings_notifications', alerts, newObjects, dailyReport });
  }

  /** raw: { [featureKey]: checkbox value }; features not sent are switched off (HTML checkboxes). */
  async saveFeatures(scope, raw, client = {}) {
    this.#check(scope);
    const values = {};
    for (const f of FEATURES) values[f.key] = parse(checkbox, raw?.[f.key]);
    values['export.keys'] = parse(z.enum(KEY_EXPORT_MODES), raw?.['export.keys'] ?? 'off');
    // Rows per page of each list: left out = the default.
    const size = z.coerce.number().int().min(PAGE_SIZE_LIMITS[0]).max(PAGE_SIZE_LIMITS[1]);
    for (const spec of Object.values(PAGE_SIZES)) {
      const v = raw?.[spec.key];
      values[spec.key] = v === undefined || v === '' ? spec.default : parse(size, v);
    }
    for (const [k, v] of Object.entries(values)) await this.settings.set(k, v);
    await this.#log(scope, client, { op: 'settings_features', features: values });
  }

  /** Anomaly / watchdog thresholds as shown in the form: [{ ...definition, value, defaultValue }]. */
  async thresholds(scope) {
    this.#check(scope);
    const out = [];
    for (const t of THRESHOLDS) {
      out.push({ ...t, value: toForm(t, await this.settings.get(t.key, t.default)), defaultValue: toForm(t, t.default) });
    }
    return out;
  }

  /** The data alerts that can be switched off: [{ type, key, label, help, enabled }]. */
  async alertSwitches(scope) {
    this.#check(scope);
    const out = [];
    for (const a of ALERT_SWITCHES) out.push({ ...a, key: `alert.${a.type}`, enabled: await this.settings.alertEnabled(a.type) });
    return out;
  }

  /** The full-run checks that can be switched off: [{ code, key, label, help, enabled }]. */
  async checkSwitches(scope) {
    this.#check(scope);
    const out = [];
    for (const c of CHECK_SWITCHES) out.push({ ...c, key: `check.${c.code}`, enabled: await this.settings.checkEnabled(c.code) });
    return out;
  }

  /** raw: { [key]: shown value }; a key left out keeps its value. Each must be within [min, max]. Alert switches: on / off. */
  async saveThresholds(scope, raw, client = {}) {
    this.#check(scope);
    const changes = {};
    const fields = [];
    for (const t of THRESHOLDS) {
      const v = raw?.[t.key];
      if (v === undefined || v === '') continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n < t.min || n > t.max || (t.unit !== 'percent' && !Number.isInteger(n))) {
        fields.push({ field: t.key, message: `out_of_range:${t.min}-${t.max}` });
        continue;
      }
      changes[t.key] = fromForm(t, n);
    }
    for (const [key] of [...ALERT_SWITCHES.map((a) => [`alert.${a.type}`]), ...CHECK_SWITCHES.map((c) => [`check.${c.code}`])]) {
      let v = raw?.[key];
      if (Array.isArray(v)) v = v.at(-1); // form: hidden "off" then the checked checkbox "on"
      if (v === undefined || v === '') continue;
      if (v === true || v === 'on' || v === 'true' || v === '1') changes[key] = true;
      else if (v === false || v === 'off' || v === 'false' || v === '0') changes[key] = false;
      else fields.push({ field: key, message: 'on_or_off' });
    }
    if (fields.length) throw badRequest('invalid_request', 'The request data is invalid.', { fields });
    for (const [k, v] of Object.entries(changes)) await this.settings.set(k, v);
    await this.#log(scope, client, { op: 'settings_thresholds', changes });
  }

  /** Retention settings plus the last access-log purge (if any). */
  async retentionSettings(scope) {
    this.#check(scope);
    const { rows } = await this.pool.query(
      'SELECT purged_at, purged_by, before_at, up_to_id, rows FROM access_log_purge ORDER BY id DESC LIMIT 1',
    );
    return { ...(await this.retention.values()), runAt: await jobTime(this.settings, JOB_SCHEDULE.retentionTime), lastPurge: rows[0] ?? null };
  }

  async saveRetention(scope, raw, client = {}) {
    this.#check(scope);
    const r = parse(retentionInput, raw);
    const accessLogDays = r.keepAccessLog ? null : r.accessLogDays;
    await this.settings.set('mail.retention_days', r.mailDays);
    await this.settings.set('retention.sync_days', r.syncDays);
    await this.settings.set('retention.access_log_days', accessLogDays);
    await this.settings.set(JOB_SCHEDULE.retentionTime.key, r.runAt);
    await this.#log(scope, client, { op: 'settings_retention', mailDays: r.mailDays, syncDays: r.syncDays, accessLogDays, runAt: r.runAt });
  }

  /** Runs the nightly clean-up now. Returns the deleted counts. */
  async runRetention(scope, client = {}) {
    this.#check(scope);
    const result = await this.retention.run(scope.upn);
    await this.#log(scope, client, { op: 'retention_run', ...result });
    return result;
  }

  async retryMail(scope, mailId, client = {}) {
    this.#check(scope);
    const mid = parse(id, mailId);
    if (!(await retryMail(this.pool, mid))) throw badRequest('not_failed', 'Only a failed mail can be sent again.');
    const again = await getMail(this.pool, mid);
    if (again) this.mail.report('retry_requested', again, { by: scope.upn });
    await this.#log(scope, client, { op: 'mail_retry', mailId: mid });
  }
}
