import nodemailer from 'nodemailer';
import { decryptSecret } from './secret.js';
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
  constructor({ pool, settings, config, logger, secretKey, templates, createTransport }) {
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
  async enqueue({ kind, to, subject, body, html = null, reason = null, missing = [] }, db = this.pool) {
    const recipients = [...new Set(to.filter(Boolean).map((e) => e.trim().toLowerCase()))].sort();
    const missingUsers = [...new Set(missing)].sort();
    if (missingUsers.length) this.logger?.warn({ kind, subject, users: missingUsers }, 'mail: some intended recipients have no e-mail address');
    if (!recipients.length) {
      const why = reason ?? 'No recipient with an e-mail address.';
      this.logger?.warn({ kind, subject }, `mail not sent: ${why}`);
      const id = await insertMail(db, { kind, recipients: [], subject, body, html, status: 'no_recipient', reason: why, missing: missingUsers });
      return { id, queued: false };
    }
    return { id: await insertMail(db, { kind, recipients, subject, body, html, missing: missingUsers }), queued: true };
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
        continue;
      }
      try {
        await t.transport.sendMail({ from: t.from, to: m.recipients, subject: m.subject, text: m.body, ...(m.html ? { html: m.html } : {}) });
        await markSent(this.pool, m.id);
        sent++;
      } catch (err) {
        failed++;
        const retry = RETRY_MINUTES[m.attempts] ?? null;
        await markAttemptFailed(this.pool, m.id, err.message, retry);
        this.logger.warn({ mailId: m.id, attempt: m.attempts + 1, err: { message: err.message, code: err.code } }, 'mail: send failed');
      }
    }
    return { sent, failed };
  }

  /** Deletes sent and failed mails older than Settings > mail.retention_days. */
  async purge() {
    const days = Number(await this.settings.get('mail.retention_days', 90));
    return { deleted: await purgeMails(this.pool, days) };
  }

  /** Sends one test mail right away (not through the outbox) with the given settings. Throws on failure. */
  async sendTest(to, smtp) {
    const s = { ...SMTP_DEFAULTS, ...smtp };
    const transport = this.createTransport(smtpOptions(s, decryptSecret(this.secretKey, s.password)));
    const mail = this.templates.render('smtp_test');
    await transport.sendMail({ from: s.from, to, subject: mail.subject, text: mail.body });
  }
}
