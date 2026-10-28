import nodemailer from 'nodemailer';
import { DEFAULT_LANG, normalizeLang } from '../../i18n/index.js';
import { decryptSecret } from './secret.js';
import { EventLog } from '../audit/event-log.js';
import { dueMails, insertMail, markAttemptFailed, markSent, markWaiting, purgeMails } from './mail.repo.js';

const BATCH = 20;
// Minutes before attempts 2, 3, 4, 5, 6; after that the mail is marked failed.
const RETRY_MINUTES = [1, 5, 15, 60, 240];
// A mail that could not even be tried (no SMTP server set up) is given up after this long.
const WAIT_GIVE_UP_HOURS = 24;

/** Default SMTP settings (also what the settings screen starts from). */
export const SMTP_DEFAULTS = {
  enabled: false,
  host: '',
  port: 587,
  security: 'starttls', // none | starttls | tls
  username: '',
  password: null,
  from: 'bitlocker-keys@corp.local',
  rejectUnauthorized: true,
  appUrl: '',
};

/** nodemailer options for the SMTP settings. */
function smtpOptions(s, password) {
  return {
    host: s.host,
    port: s.port,
    secure: s.security === 'tls', // TLS from the first byte (usually port 465)
    requireTLS: s.security === 'starttls', // STARTTLS is mandatory (usually 587)
    ignoreTLS: s.security === 'none',
    auth: s.username ? { user: s.username, pass: password ?? '' } : undefined,
    tls: { rejectUnauthorized: s.rejectUnauthorized },
    connectionTimeout: 15_000,
    socketTimeout: 30_000,
  };
}

/**
 * The outbox: other services enqueue mails; the mail-outbox job sends them.
 * SMTP comes from Settings > Mail server, or SMTP_URL in .env when that is not enabled.
 * `createTransport` is replaceable for tests.
 */
export class MailService {
  constructor({ pool, settings, config, logger, secretKey, templates, createTransport, eventLog = null }) {
    this.eventLog = eventLog;
    this.pool = pool;
    this.settings = settings;
    this.config = config;
    this.logger = logger;
    this.secretKey = secretKey;
    this.templates = templates;
    this.createTransport = createTransport ?? ((opts) => nodemailer.createTransport(opts));
  }

  async smtpSettings() {
    return { ...SMTP_DEFAULTS, ...(await this.settings.get('mail.smtp', {})) };
  }

  /** { transport, from } or null when no SMTP server is configured. */
  async #transport() {
    const s = await this.smtpSettings();
    if (s.enabled && s.host) {
      const password = decryptSecret(this.secretKey, s.password);
      return {
        from: s.from,
        transport: this.createTransport(smtpOptions(s, password)),
      };
    }
    if (this.config.SMTP_URL) return { from: this.config.NOTIFY_FROM, transport: this.createTransport(this.config.SMTP_URL) };
    return null;
  }

  /**
   * Queues one mail. Recipients are de-duplicated. `missing`: usernames who should have got it but
   * have no e-mail address (shown in the mail log). With no recipient at all, the mail is still
   * stored, as 'no_recipient' with `reason`, so the mail log shows what was not sent and why.
   * `html`: an HTML version sent along with the plain-text `body` (optional).
   * Returns { id, queued } (queued = will be sent).
   */
  /** A change of state of an e-mail, (same facts as the mail log screen). */
  report(event, m, extra = {}) {
    this.eventLog?.emit('mail', {
      event,
      mail_id: Number(m.id),
      kind: m.kind,
      recipients: m.recipients,
      subject: m.subject,
      status: m.status,
      attempts: m.attempts ?? 0,
      missing_recipients: m.missing_recipients ?? [],
      error: m.last_error ?? null,
      body: EventLog.body(m.body),
      has_html: !!m.html,
      ...extra,
    });
  }

  async enqueue({ kind, to, subject, body, html = null, reason = null, missing = [] }, db = this.pool) {
    const recipients = [...new Set(to.filter(Boolean).map((e) => e.trim().toLowerCase()))].sort();
    const missingUsers = [...new Set(missing)].sort();
    if (missingUsers.length) this.logger?.warn({ kind, subject, users: missingUsers }, 'mail: some intended recipients have no e-mail address');
    if (!recipients.length) {
      const why = reason ?? 'No recipient with an e-mail address.';
      this.logger?.warn({ kind, subject }, `mail not sent: ${why}`);
      const id = await insertMail(db, { kind, recipients: [], subject, body, html, status: 'no_recipient', reason: why, missing: missingUsers });
      this.report('no_recipient', { id, kind, recipients: [], subject, body, html, status: 'no_recipient', last_error: why, missing_recipients: missingUsers });
      return { id, queued: false };
    }
    const id = await insertMail(db, { kind, recipients, subject, body, html, missing: missingUsers });
    this.report('queued', { id, kind, recipients, subject, body, html, status: 'pending', missing_recipients: missingUsers });
    return { id, queued: true };
  }

  /**
   * Queues one mail per language: `recipients` are e-mail strings (they get the default language) or
   * { email, language } (users carry their own; the user's language wins when an address appears twice).
   * `build(lang)` returns { subject, body, html? }. With nobody to send to, one no_recipient row is stored
   * in the default language. Returns { id, queued } of the first mail.
   */
  async enqueueLocalized({ kind, recipients = [], build, reason = null, missing = [] }, db = this.pool) {
    const byEmail = new Map();
    for (const r of recipients) {
      const email = String(typeof r === 'string' ? r : r?.email ?? '').trim().toLowerCase();
      if (!email) continue;
      const language = typeof r === 'string' ? null : normalizeLang(r.language);
      if (!byEmail.has(email) || (language && byEmail.get(email) === DEFAULT_LANG)) byEmail.set(email, language ?? byEmail.get(email) ?? DEFAULT_LANG);
    }
    const groups = new Map();
    for (const [email, language] of byEmail) groups.set(language, [...(groups.get(language) ?? []), email]);
    if (!groups.size) return this.enqueue({ kind, to: [], reason, missing, ...build(DEFAULT_LANG) }, db);
    let first = null;
    for (const [language, to] of groups) {
      const res = await this.enqueue({ kind, to, reason, missing: first ? [] : missing, ...build(language) }, db);
      first ??= res;
    }
    return first;
  }

  /** Sends what is due. Called every minute by the mail-outbox job. */
  async processOutbox() {
    const due = await dueMails(this.pool, BATCH);
    if (!due.length) return { sent: 0, failed: 0 };
    const t = await this.#transport();
    let sent = 0;
    let failed = 0;
    for (const m of due) {
      if (!t) {
        const giveUp = Date.now() - new Date(m.created_at).getTime() > WAIT_GIVE_UP_HOURS * 3_600_000;
        await markWaiting(this.pool, m.id, 'SMTP server not configured', giveUp);
        if (giveUp) this.report('failed', { ...m, status: 'failed', last_error: 'SMTP server not configured' });
        continue;
      }
      try {
        await t.transport.sendMail({ from: t.from, to: m.recipients, subject: m.subject, text: m.body, ...(m.html ? { html: m.html } : {}) });
        await markSent(this.pool, m.id);
        this.report('sent', { ...m, status: 'sent', attempts: m.attempts + 1 });
        sent++;
      } catch (err) {
        failed++;
        const retry = RETRY_MINUTES[m.attempts] ?? null;
        await markAttemptFailed(this.pool, m.id, err.message, retry);
        this.report(retry === null ? 'failed' : 'retry', { ...m, status: retry === null ? 'failed' : 'pending', attempts: m.attempts + 1, last_error: err.message },
          retry === null ? {} : { next_attempt_in_minutes: retry });
        this.logger.warn({ mailId: m.id, attempt: m.attempts + 1, err: { message: err.message, code: err.code } }, 'mail: send failed');
      }
    }
    return { sent, failed };
  }

  /** Deletes sent and failed mails older than Settings > mail.retention_days. */
  async purge() {
    const days = Number(await this.settings.get('mail.retention_days', 90));
    const deleted = await purgeMails(this.pool, days);
    if (deleted) this.eventLog?.emit('mail', { event: 'purged', deleted, older_than_days: days });
    return { deleted };
  }

  /** Sends one test mail right away (not through the outbox) with the given settings. Throws on failure. */
  async sendTest(to, smtp, lang = DEFAULT_LANG) {
    const s = { ...SMTP_DEFAULTS, ...smtp };
    const transport = this.createTransport(smtpOptions(s, decryptSecret(this.secretKey, s.password)));
    const mail = this.templates.render('smtp_test', {}, { lang });
    await transport.sendMail({ from: s.from, to, subject: mail.subject, text: mail.body });
  }
}
