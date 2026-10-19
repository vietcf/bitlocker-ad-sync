export const ALERT_MAIL_DEFAULTS = {
  enabled: true, // mail this group of alerts at all
  admins: true, // to every Admin HQ user with an e-mail
  extra: [], // more addresses (e.g. the security team)
};

/**
 * The alert mails are in four groups, each with its own options (Quan tri > Thong bao):
 *  agent  the sync worker stopped (no heartbeat);
 *  ad     the connection to AD or the sync has a problem (failed / held runs, LDAPS, certificate, duplicate Key IDs...);
 *  key    keys seen out of working hours, key exports;
 *  backup a backup that failed.
 * A type not listed (and every "<type>_recovered") goes with its base type; an unknown type goes to 'ad'.
 */
export const ALERT_GROUPS = {
  agent: {
    label: 'Agent (worker) ngừng hoạt động',
    help: 'Worker không gửi heartbeat nữa (service bị dừng, máy chủ worker tắt hoặc treo).',
    types: ['worker_offline'],
  },
  ad: {
    label: 'Kết nối AD và đồng bộ có vấn đề',
    help: 'Không đọc được AD (DC offline, sai quyền, chứng chỉ LDAPS), sync lỗi hoặc bất thường bị giữ lại, lâu không có lượt sync, Key ID trùng.',
    types: ['sync_problem', 'sync_failed', 'sync_anomaly', 'key_duplicate'],
  },
  key: {
    label: 'Xem key ngoài giờ và bảo mật dữ liệu',
    help: 'Hiện key ngoài giờ làm việc, xuất key hàng loạt.',
    types: ['reveal_out_of_hours', 'key_export'],
  },
  backup: {
    label: 'Sao lưu',
    help: 'Một lượt sao lưu (theo lịch hoặc "Sao lưu ngay") bị lỗi.',
    types: ['backup_failed'],
  },
};

/** 'agent' | 'ad' | 'key' for an alert type. */
export function alertGroupOf(type) {
  const base = String(type).replace(/_recovered$/, '');
  return Object.entries(ALERT_GROUPS).find(([, g]) => g.types.includes(base))?.[0] ?? 'ad';
}

/**
 * Options of each group: { agent, ad, key }. Settings saved before the groups existed hold one set
 * ({ enabled, admins, extra }): it is the starting point of all three.
 */
export async function loadAlertOptions(settings) {
  const stored = (await settings.get('notify.alerts', {})) ?? {};
  const legacy = Object.fromEntries(['enabled', 'admins', 'extra'].filter((k) => stored[k] !== undefined).map((k) => [k, stored[k]]));
  return Object.fromEntries(Object.keys(ALERT_GROUPS).map((g) => [g, { ...ALERT_MAIL_DEFAULTS, ...legacy, ...(stored[g] ?? {}) }]));
}

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
    const jobs = [this.#queueMail(subject, text, alertGroupOf(type))];
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

  async #queueMail(subject, body, group) {
    const o = (await loadAlertOptions(this.settings))[group];
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
