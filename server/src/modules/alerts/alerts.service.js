// Operational alerts (sync health, audit chain). One open row per alert type in sync_alert:
// repeats update it and re-notify at most every REMIND_HOURS (or once per calendar day with
// { daily: true }); when the condition clears the alert is resolved and a "recovered" message is
// sent (unless { announce: false }). The watchdog records its conditions without mail and sends one
// "sync_offline" alert instead (jobs/watchdog.js).

export const REMIND_HOURS = 4;

/** 'YYYY-MM-DD' of a date in the app's time zone. */
const dayOf = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: process.env.APP_TZ ?? 'Asia/Ho_Chi_Minh' }).format(d);

export class AlertsService {
  constructor({ pool, notifier, templates }) {
    this.pool = pool;
    this.notifier = notifier;
    this.templates = templates;
  }

  /**
   * Opens (or refreshes) the alert of this type. Notifies when new, and again every
   * REMIND_HOURS while it stays open. The message is the mail template named like the type,
   * filled with `vars`. Returns true if a notification was sent.
   */
  async raise(type, severity, vars = {}, detail = {}, { daily = false } = {}) {
    const { alert } = await this.#upsert(type, severity, vars, detail);
    const due = !alert.last_notified_at || (daily
      ? dayOf(alert.last_notified_at) !== dayOf(new Date())
      : Date.now() - alert.last_notified_at.getTime() > REMIND_HOURS * 3600_000);
    if (!due) return false;
    await this.pool.query('UPDATE sync_alert SET last_notified_at = now() WHERE id = $1', [alert.id]);
    const mail = this.templates.render(type, vars, { severity });
    await this.notifier.send({ type, severity, subject: mail.subject, text: mail.body });
    return true;
  }

  /** Sends one message from the template named `type`, without an alert row (one-off notices). */
  async notifyOnce(type, severity, vars = {}) {
    const mail = this.templates.render(type, vars, { severity });
    await this.notifier.send({ type, severity, subject: mail.subject, text: mail.body });
  }

  /**
   * Opens (or refreshes) the alert of this type without notifying anyone (shown in the app only).
   * Returns its subject (the template, without the prefix).
   */
  async record(type, severity, vars = {}, detail = {}) {
    return (await this.#upsert(type, severity, vars, detail)).subject;
  }

  async #upsert(type, severity, vars, detail) {
    const plain = this.templates.render(type, vars); // stored and shown in the app, without the prefix
    const subject = plain.subject;
    const text = plain.body;
    const { rows } = await this.pool.query(
      `INSERT INTO sync_alert (type, severity, detail) VALUES ($1, $2, $3)
       ON CONFLICT (type) WHERE resolved_at IS NULL
       DO UPDATE SET detail = EXCLUDED.detail, severity = EXCLUDED.severity
       RETURNING id, last_notified_at`,
      [type, severity, JSON.stringify({ subject, text, ...detail })],
    );
    return { alert: rows[0], subject };
  }

  /**
   * Resolves the open alert of this type, if any, and announces the recovery with the template
   * "<type>_recovered" (or "recovered"), which also gets alertType and alertSubject.
   * { announce: false }: resolve silently.
   */
  async clear(type, vars = {}, { announce = true } = {}) {
    const { rows } = await this.pool.query(
      `UPDATE sync_alert SET resolved_at = now() WHERE type = $1 AND resolved_at IS NULL
       RETURNING detail->>'subject' AS subject`,
      [type],
    );
    if (!rows[0]) return false;
    if (!announce) return true;
    const name = this.templates.has(`${type}_recovered`) ? `${type}_recovered` : 'recovered';
    const mail = this.templates.render(name, { ...vars, alertType: type, alertSubject: rows[0].subject }, { severity: 'info' });
    await this.notifier.send({ type: `${type}_recovered`, severity: 'info', subject: mail.subject, text: mail.body });
    return true;
  }

  async listOpen() {
    const { rows } = await this.pool.query(
      `SELECT id, type, severity, opened_at, last_notified_at, detail
         FROM sync_alert WHERE resolved_at IS NULL ORDER BY severity, opened_at`,
    );
    return rows;
  }

  async listRecent(limit = 20) {
    const { rows } = await this.pool.query(
      `SELECT id, type, severity, opened_at, resolved_at, detail
         FROM sync_alert ORDER BY opened_at DESC LIMIT $1`,
      [limit],
    );
    return rows;
  }
}
