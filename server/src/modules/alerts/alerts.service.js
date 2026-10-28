// Operational alerts (sync health, audit chain). One open row per alert type in sync_alert:
// repeats update it and re-notify at most every REMIND_HOURS (or once per calendar day with
// { daily: true }); when the condition clears the alert is resolved and a "recovered" message is
// sent (unless { announce: false }). The watchdog records its conditions without mail and sends one
// "worker_offline" / "sync_problem" summary alerts instead (jobs/watchdog.js).

export const REMIND_HOURS = 4;

/**
 * Alerts computed from stored data / trends: they stay true for days after the cause is fixed, so Admin HQ can
 * mark them handled or snooze them. The other alerts (worker, AD, sync) are measured live and clear themselves.
 */
export const DATA_ALERT_TYPES = ['escrow_broken', 'no_key_rising', 'full_stale', 'dc_cert_expiring'];
// "Handled" and "skip N days" both set snoozed_until: silent until then, reported again if the condition remains.
const SILENCED = '(type = ANY($1::text[]) AND snoozed_until > now())';

/** 'YYYY-MM-DD' of a date in the app's time zone. */
const dayOf = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: process.env.APP_TZ ?? 'Asia/Ho_Chi_Minh' }).format(d);

export class AlertsService {
  constructor({ pool, notifier, templates, eventLog = null }) {
    this.eventLog = eventLog;
    this.pool = pool;
    this.notifier = notifier;
    this.templates = templates;
  }

  /**
   * Opens (or refreshes) the alert of this type. Notifies when new, and again every
   * REMIND_HOURS while it stays open. The message is the mail template named like the type,
   * filled with `vars` (an object, or a function of the language 'vi' | 'en'). Returns true if a notification was sent.
   */
  async raise(type, severity, vars = {}, detail = {}, { daily = false } = {}) {
    const { alert } = await this.#upsert(type, severity, vars, detail);
    const due = !alert.last_notified_at || (daily
      ? dayOf(alert.last_notified_at) !== dayOf(new Date())
      : Date.now() - alert.last_notified_at.getTime() > REMIND_HOURS * 3600_000);
    if (!due) return false;
    await this.pool.query('UPDATE sync_alert SET last_notified_at = now() WHERE id = $1', [alert.id]);
    const render = this.#renderer(type, vars, severity);
    await this.notifier.send({ type, severity, render });
    this.eventLog?.emit('alert', { event: 'notified', alert_id: Number(alert.id), type, severity, subject: render('en').subject });
    return true;
  }

  /** Sends one message from the template named `type`, without an alert row (one-off notices). */
  async notifyOnce(type, severity, vars = {}) {
    await this.notifier.send({ type, severity, render: this.#renderer(type, vars, severity) });
  }

  /** render(lang) -> { subject, text } of the template `name`; `vars` is an object or a function of the language. */
  #renderer(name, vars, severity, extra = () => ({})) {
    return (lang) => {
      const m = this.templates.render(name, { ...(typeof vars === 'function' ? vars(lang) : vars), ...extra(lang) }, { severity, lang });
      return { subject: m.subject, text: m.body };
    };
  }

  /**
   * Opens (or refreshes) the alert of this type without notifying anyone (shown in the app only).
   * Returns its subject in both languages: { vi, en } (the template, without the prefix).
   */
  async record(type, severity, vars = {}, detail = {}) {
    return (await this.#upsert(type, severity, vars, detail)).subject;
  }

  async #upsert(type, severity, vars, detail) {
    const varsFor = (lang) => (typeof vars === 'function' ? vars(lang) : vars);
    // stored and shown in the app (in the viewer's language), without the prefix
    const vi = this.templates.render(type, varsFor('vi'), { lang: 'vi' });
    const en = this.templates.render(type, varsFor('en'), { lang: 'en' });
    const { rows } = await this.pool.query(
      `INSERT INTO sync_alert (type, severity, detail) VALUES ($1, $2, $3)
       ON CONFLICT (type) WHERE resolved_at IS NULL
       DO UPDATE SET detail = EXCLUDED.detail, severity = EXCLUDED.severity
       RETURNING id, last_notified_at, (xmax = 0) AS inserted, opened_at`,
      [type, severity, JSON.stringify({ subject: vi.subject, text: vi.body, subject_en: en.subject, text_en: en.body, ...detail })],
    );
    if (rows[0].inserted) {
      // the app log is in English
      this.eventLog?.emit('alert', { event: 'opened', time: rows[0].opened_at, alert_id: Number(rows[0].id), type, severity, subject: en.subject, text: en.body });
    }
    return { alert: rows[0], subject: { vi: vi.subject, en: en.subject } };
  }

  /**
   * Resolves the open alert of this type, if any, and announces the recovery with the template
   * "<type>_recovered" (or "recovered"), which also gets alertType and alertSubject.
   * { announce: false }: resolve silently.
   */
  async clear(type, vars = {}, { announce = true } = {}) {
    const { rows } = await this.pool.query(
      `UPDATE sync_alert SET resolved_at = now() WHERE type = $1 AND resolved_at IS NULL
       RETURNING id, severity, resolved_at, detail->>'subject' AS subject, detail->>'subject_en' AS subject_en`,
      [type],
    );
    if (!rows[0]) return false;
    const subjectOf = (lang) => (lang === 'en' ? rows[0].subject_en ?? rows[0].subject : rows[0].subject);
    this.eventLog?.emit('alert', { event: 'resolved', time: rows[0].resolved_at, alert_id: Number(rows[0].id), type, severity: rows[0].severity, subject: subjectOf('en') });
    if (!announce) return true;
    const name = this.templates.has(`${type}_recovered`) ? `${type}_recovered` : 'recovered';
    await this.notifier.send({
      type: `${type}_recovered`,
      severity: 'info',
      render: this.#renderer(name, vars, 'info', (lang) => ({ alertType: type, alertSubject: subjectOf(lang) })),
    });
    return true;
  }

  async listOpen() {
    const { rows } = await this.pool.query(
      `SELECT id, type, severity, opened_at, last_notified_at, detail, acked_at, acked_by, ack_note, snoozed_until,
              ${SILENCED} AS silenced
         FROM sync_alert WHERE resolved_at IS NULL ORDER BY severity, opened_at`,
      [DATA_ALERT_TYPES],
    );
    return rows;
  }

  /** True while the open alert of this type is marked handled / snoozed (data alerts only). */
  async isSilenced(type) {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM sync_alert WHERE type = $2 AND resolved_at IS NULL AND ${SILENCED}`,
      [DATA_ALERT_TYPES, type],
    );
    return rows.length > 0;
  }

  /**
   * "Handled" (the cause was fixed): the data alert is closed now, with who and why. The watchdog is told to leave this
   * type alone for a while (see SyncAdminService.ackAlert), then it looks again: still true -> a new alert opens.
   * Live system faults clear themselves and cannot be marked.
   */
  async acknowledge(id, { by, note }) {
    const { rows } = await this.pool.query(
      `UPDATE sync_alert SET acked_at = now(), acked_by = $2, ack_note = $3, snoozed_until = NULL, resolved_at = now()
        WHERE id = $1 AND resolved_at IS NULL AND type = ANY($4::text[])
        RETURNING id, type, severity, resolved_at, coalesce(detail->>'subject_en', detail->>'subject') AS subject`,
      [id, by, note || null, DATA_ALERT_TYPES],
    );
    const a = rows[0] ?? null;
    if (a) this.eventLog?.emit('alert', { event: 'resolved', time: a.resolved_at, alert_id: Number(a.id), type: a.type, severity: a.severity, subject: a.subject });
    return a;
  }

  /** Snooze a data alert for N days; it is reported again when the time is over and the condition remains. */
  async snooze(id, { by, days, note }) {
    const { rows } = await this.pool.query(
      `UPDATE sync_alert SET snoozed_until = now() + make_interval(days => $3), acked_at = NULL, acked_by = $2, ack_note = $4
        WHERE id = $1 AND resolved_at IS NULL AND type = ANY($5::text[]) RETURNING id, type, snoozed_until`,
      [id, by, days, note || null, DATA_ALERT_TYPES],
    );
    return rows[0] ?? null;
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
