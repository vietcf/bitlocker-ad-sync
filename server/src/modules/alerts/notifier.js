export const ALERT_MAIL_DEFAULTS = {
  enabled: true, // mail alerts at all
  admins: true, // to every Admin HQ user with an e-mail
  extra: [], // more addresses (e.g. the security team)
};

/**
 * Sends alerts to people: e-mail through the mail outbox (Settings > Thong bao: Admin HQ users
 * and extra addresses, plus NOTIFY_TO from .env) and/or a Teams incoming webhook.
 * Always also writes a warning to the app log (in English: type and severity, not the Vietnamese text).
 * A failed send is logged, never thrown: alerting must not break the action that triggered it.
 * Messages never contain a recovery password or lists of computers.
 */
export class Notifier {
  constructor({ config, logger, mail, settings, adminEmails, adminsWithoutEmail = async () => [] }) {
    this.logger = logger;
    this.to = config.NOTIFY_TO;
    this.teamsUrl = config.TEAMS_WEBHOOK_URL;
    this.mail = mail;
    this.settings = settings;
    this.adminEmails = adminEmails; // () => Promise<string[]>
    this.adminsWithoutEmail = adminsWithoutEmail; // () => Promise<string[]> (usernames, for the mail log)
  }

  /** type: alert type (for the log); severity: 'high' | 'medium' | 'info'; subject/text: rendered from the mail templates. */
  async send({ type, severity, subject, text }) {
    this.logger.warn({ alert: { type, severity } }, `alert: ${type} (${severity})`);
    const jobs = [this.#queueMail(subject, text)];
    if (this.teamsUrl) {
      jobs.push(
        fetch(this.teamsUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: `**${subject}**\n\n${text}` }),
          signal: AbortSignal.timeout(10_000),
        }).then((r) => {
          if (!r.ok) throw new Error(`Teams webhook HTTP ${r.status}`);
        }),
      );
    }
    for (const r of await Promise.allSettled(jobs)) {
      if (r.status === 'rejected') this.logger.error({ err: r.reason }, 'alert delivery failed');
    }
  }

  async #queueMail(subject, body) {
    const o = { ...ALERT_MAIL_DEFAULTS, ...(await this.settings.get('notify.alerts', {})) };
    if (!o.enabled) return;
    const to = [...this.to, ...o.extra, ...(o.admins ? await this.adminEmails() : [])];
    // Nobody to mail: still stored (status no_recipient) so the mail log shows the alert.
    await this.mail.enqueue({
      kind: 'alert', to, subject, body,
      missing: o.admins ? await this.adminsWithoutEmail() : [],
      reason: 'No recipient: no Admin HQ user with an e-mail address, no extra address (Quan tri > Thong bao) and no NOTIFY_TO.',
    });
  }
}
