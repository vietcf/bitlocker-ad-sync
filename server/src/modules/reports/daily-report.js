import { withAllBranches } from '../../db/scoped.js';
import { niceRange } from '../../web/charts.js';
import { inventoryPerDay } from '../dashboard/dashboard.repo.js';
import { adminEmails, adminsWithoutEmail } from '../mail/mail.repo.js';
import { countUnackedQuarantined, lastSuccessfulRun, lastSuccessfulRunOfMode, listHeartbeats } from '../sync/sync.repo.js';

/** Settings > Thong bao > Bao cao hang ngay (setting notify.daily_report). */
export const DAILY_REPORT_DEFAULTS = {
  enabled: false,
  time: '07:30', // HH:MM in APP_TZ
  period: 'yesterday', // yesterday: the whole previous day | today: today up to the sending time
  admins: true, // every Admin HQ user with an e-mail
  extra: [], // more addresses
};

const LAST_DAY_KEY = 'notify.daily_report.last_day';
const CHART_DAYS = 10;

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dm = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const dmy = (iso) => `${dm(iso)}/${iso.slice(0, 4)}`;
const num = (n) => new Intl.NumberFormat('vi-VN').format(n ?? 0);
const signed = (n) => (n > 0 ? `+${num(n)}` : n < 0 ? `−${num(-n)}` : '0');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Daily e-mail report for Admin HQ: sync agent status, computers and keys added / removed in the day,
 * and the number of computers and keys over the last 10 days (charts as HTML tables, which every mail
 * client shows; no image, no script). Never contains a recovery password or a list of keys.
 * tick() runs every minute (job daily-report) and sends once a day at the configured time.
 */
export class DailyReportService {
  constructor({ pool, settings, mail, templates, tz = 'Asia/Ho_Chi_Minh', now = () => new Date() }) {
    this.pool = pool;
    this.settings = settings;
    this.mail = mail;
    this.templates = templates;
    this.tz = tz;
    this.now = now;
  }

  async options() {
    return { ...DAILY_REPORT_DEFAULTS, ...(await this.settings.get('notify.daily_report', {})) };
  }

  /** { day: 'YYYY-MM-DD', time: 'HH:MM' } now, in APP_TZ. */
  localNow() {
    const s = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(this.now()); // "2026-10-16, 07:30"
    const [day, time] = s.split(', ');
    return { day, time };
  }

  /** Last day a scheduled report was sent (read from the database, not the settings cache). */
  async lastDay() {
    const { rows } = await this.pool.query('SELECT value FROM app_setting WHERE key = $1', [LAST_DAY_KEY]);
    return rows[0]?.value ?? null;
  }

  async #setLastDay(day) {
    await this.pool.query(
      `INSERT INTO app_setting (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [LAST_DAY_KEY, JSON.stringify(day)],
    );
  }

  /** Marks today as done (e.g. turned on after today's time has passed: first report tomorrow). */
  async skipToday() {
    await this.#setLastDay(this.localNow().day);
  }

  /** Called every minute: sends today's report once the configured time has passed. */
  async tick() {
    const o = await this.options();
    if (!o.enabled) return { skipped: 'disabled' };
    const { day, time } = this.localNow();
    if (time < o.time) return { skipped: 'not_yet' };
    if ((await this.lastDay()) === day) return { skipped: 'sent' };
    await this.#setLastDay(day); // first, so a failure is not retried every minute
    return this.send(o);
  }

  /** Builds and queues the report now (also "Gui thu ngay"). Returns { id, queued, recipients }. */
  async send(o = null) {
    const opts = o ?? (await this.options());
    const data = await this.build(opts.period);
    const mail = this.render(data);
    const admins = opts.admins ? await adminEmails(this.pool) : [];
    const to = [...opts.extra, ...admins];
    const r = await this.mail.enqueue({
      kind: 'daily_report',
      to,
      subject: mail.subject,
      body: mail.text,
      html: mail.html,
      missing: opts.admins ? await adminsWithoutEmail(this.pool) : [],
      reason: 'No recipient: no Admin HQ user with an e-mail address and no extra address (Quan tri > Thong bao > Bao cao hang ngay).',
    });
    return { ...r, recipients: [...new Set(to)].length };
  }

  /** The figures of the report. period: 'yesterday' | 'today'. */
  async build(period = 'yesterday') {
    const today = this.localNow().day;
    const day = period === 'today' ? today : addDays(today, -1);
    return withAllBranches(this.pool, async (tx) => {
      const { rows: [bounds] } = await tx.query(
        `SELECT ($1::date)::timestamp AT TIME ZONE $2 AS start,
                CASE WHEN $3 THEN now() ELSE (($1::date) + 1)::timestamp AT TIME ZONE $2 END AS end`,
        [day, this.tz, period === 'today'],
      );
      const range = [bounds.start, bounds.end];
      const { rows: [changes] } = await tx.query(
        `SELECT
           (SELECT count(*)::int FROM computer WHERE first_seen_at >= $1 AND first_seen_at < $2) AS new_computers,
           (SELECT count(*)::int FROM computer WHERE deleted_in_ad_at >= $1 AND deleted_in_ad_at < $2) AS left_computers,
           (SELECT count(*)::int FROM recovery_key WHERE first_synced_at >= $1 AND first_synced_at < $2) AS new_keys,
           (SELECT count(*)::int FROM recovery_key k JOIN computer c ON c.id = k.computer_id
             WHERE c.deleted_in_ad_at >= $1 AND c.deleted_in_ad_at < $2) AS keys_of_left,
           (SELECT count(*)::int FROM key_owner_change WHERE at >= $1 AND at < $2) AS keys_moved`,
        range,
      );
      const { rows: byBranch } = await tx.query(
        `SELECT b.code, b.name, x.new_computers, x.left_computers, x.new_keys FROM (
           SELECT c.branch_id,
                  count(*) FILTER (WHERE c.first_seen_at >= $1 AND c.first_seen_at < $2)::int AS new_computers,
                  count(*) FILTER (WHERE c.deleted_in_ad_at >= $1 AND c.deleted_in_ad_at < $2)::int AS left_computers,
                  coalesce(sum((SELECT count(*) FROM recovery_key k
                                 WHERE k.computer_id = c.id AND k.first_synced_at >= $1 AND k.first_synced_at < $2)), 0)::int AS new_keys
             FROM computer c GROUP BY c.branch_id) x
           LEFT JOIN branch b ON b.id = x.branch_id
          WHERE x.new_computers + x.left_computers + x.new_keys > 0
          ORDER BY x.new_computers + x.left_computers + x.new_keys DESC, b.code NULLS FIRST
          LIMIT 15`,
        range,
      );
      const { rows: runs } = await tx.query(
        `SELECT status, count(*)::int AS n FROM sync_run WHERE started_at >= $1 AND started_at < $2 GROUP BY status`,
        range,
      );
      const { rows: alerts } = await tx.query(
        `SELECT type, severity, opened_at, detail->>'subject' AS subject FROM sync_alert
          WHERE resolved_at IS NULL ORDER BY severity, opened_at`,
      );
      const { rows: [dup] } = await tx.query('SELECT count(*)::int AS n FROM key_duplicate WHERE resolved_at IS NULL');

      // End-of-day totals: 12 days ending today, so each shown day has the day before it.
      const inv = await inventoryPerDay(tx, 'all', CHART_DAYS + 2, this.tz);
      const end = period === 'today' ? inv.length - 1 : inv.length - 2;
      const series = inv.slice(end - CHART_DAYS + 1, end + 1).map((r, i) => {
        const prev = inv[end - CHART_DAYS + i];
        return { day: r.day, computers: r.computers, keys: r.keys, dComputers: r.computers - prev.computers, dKeys: r.keys - prev.keys };
      });

      const heartbeatMax = Number(await this.settings.get('watchdog.heartbeat_max_minutes', 15));
      const workers = (await listHeartbeats(tx)).map((h) => ({
        id: h.worker_id,
        version: h.version,
        dc: h.dc_name,
        at: h.at,
        alive: (this.now() - new Date(h.at)) / 60_000 <= heartbeatMax,
        ldapOk: h.ldap_ok,
        error: h.last_error_code,
      }));
      const offline = alerts.find((a) => a.type === 'sync_offline') ?? null;
      return {
        period,
        day,
        start: bounds.start,
        end: bounds.end,
        changes,
        byBranch,
        series,
        sync: {
          online: !offline,
          offlineSince: offline?.opened_at ?? null,
          alerts: alerts.filter((a) => a.type !== 'sync_offline'),
          workers,
          lastSuccess: await lastSuccessfulRun(tx),
          lastFull: await lastSuccessfulRunOfMode(tx, 'full'),
          runs: Object.fromEntries(runs.map((r) => [r.status, r.n])),
          quarantined: await countUnackedQuarantined(tx),
          duplicates: dup.n,
        },
        appUrl: (await this.settings.get('mail.smtp', {}))?.appUrl || null,
      };
    });
  }

  /** { subject, text, html } of the report. */
  render(d) {
    const when = (t) => (t ? new Intl.DateTimeFormat('vi-VN', { timeZone: this.tz, dateStyle: 'short', timeStyle: 'short' }).format(new Date(t)) : '—');
    const c = d.changes;
    const last = d.series[d.series.length - 1];
    const periodText = d.period === 'today' ? `ngày ${dmy(d.day)} (tính đến ${when(d.end)})` : `ngày ${dmy(d.day)}`;
    const syncText = d.sync.online ? 'Online' : 'Offline';
    const t = this.templates.render('daily_report', {
      day: dmy(d.day),
      period: periodText,
      syncStatus: syncText,
      computers: num(last?.computers),
      keys: num(last?.keys),
      computersChange: signed(last?.dComputers ?? 0),
      keysChange: signed(last?.dKeys ?? 0),
    });
    const runText = (r) => `${num(r.success ?? 0)} thành công, ${num(r.failed ?? 0)} lỗi, ${num(r.quarantined ?? 0)} bị giữ lại`;

    // ---- plain text ----
    const lines = [
      t.body,
      '',
      `ĐỒNG BỘ AD: ${syncText}${d.sync.online ? '' : ` từ ${when(d.sync.offlineSince)}`}`,
      ...d.sync.workers.map((w) => `- Worker ${w.id}${w.version ? ` v${w.version}` : ''}: heartbeat ${when(w.at)} (${w.alive ? 'đang chạy' : 'không phản hồi'}), LDAP ${w.ldapOk === false ? `lỗi ${w.error ?? ''}` : 'OK'}${w.dc ? `, DC ${w.dc}` : ''}`),
      d.sync.workers.length ? null : '- Chưa có worker nào gửi heartbeat',
      `- Lượt sync thành công gần nhất: ${when(d.sync.lastSuccess?.finished_at)}; full gần nhất: ${when(d.sync.lastFull?.finished_at)}`,
      `- Lượt sync trong kỳ: ${runText(d.sync.runs)}`,
      d.sync.quarantined ? `- ${num(d.sync.quarantined)} lượt đang chờ Admin HQ duyệt` : null,
      ...d.sync.alerts.map((a) => `- Cảnh báo: ${a.subject}`),
      d.sync.duplicates ? `- ${num(d.sync.duplicates)} Key ID trùng giữa nhiều máy chưa xem xét` : null,
      '',
      `MÁY: ${num(last?.computers)} (${signed(last?.dComputers ?? 0)}): ${num(c.new_computers)} mới ghi nhận, ${num(c.left_computers)} không còn trong AD`,
      `KEY: ${num(last?.keys)} (${signed(last?.dKeys ?? 0)}): ${num(c.new_keys)} mới ghi nhận${c.keys_of_left ? `, ${num(c.keys_of_left)} key thuộc máy vừa rời AD (vẫn lưu)` : ''}${c.keys_moved ? `, ${num(c.keys_moved)} key chuyển sang máy mới (join lại AD)` : ''}`,
      '',
      ...(d.byBranch.length ? ['THEO CHI NHÁNH (có thay đổi):', ...d.byBranch.map((b) => `- ${b.code ?? 'N/A'}: máy +${b.new_computers} / −${b.left_computers}, key +${b.new_keys}`), ''] : []),
      `${CHART_DAYS} NGÀY GẦN NHẤT (cuối mỗi ngày):`,
      ...d.series.map((s) => `- ${dm(s.day)}: ${num(s.computers)} máy (${signed(s.dComputers)}), ${num(s.keys)} key (${signed(s.dKeys)})`),
      '',
      'Email không chứa recovery key. Tắt hoặc đổi giờ gửi: Quản trị > Thông báo > Báo cáo hằng ngày.',
    ].filter((l) => l !== null);

    // ---- HTML (inline styles and tables only: what mail clients render) ----
    const font = "font-family:Segoe UI,Arial,sans-serif;";
    const muted = 'color:#62646c;';
    const cell = `${font}font-size:14px;color:#1c1d21;padding:6px 8px;border-bottom:1px solid #dcdee4;`;
    const badge = (ok, label) => `<span style="${font}display:inline-block;padding:2px 10px;border-radius:10px;font-size:13px;font-weight:600;color:${ok ? '#1b7a43' : '#b42318'};background:${ok ? '#e6f4ec' : '#fdecea'};">${esc(label)}</span>`;
    const stat = (label, value, change, sub) => `
      <td width="50%" valign="top" style="padding:0 6px 0 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dcdee4;border-radius:8px;">
          <tr><td style="${font}padding:12px 14px;">
            <div style="font-size:13px;${muted}">${esc(label)}</div>
            <div style="font-size:26px;font-weight:700;color:#1c1d21;">${esc(value)} <span style="font-size:15px;font-weight:600;color:${change.startsWith('−') ? '#b42318' : change === '0' ? '#62646c' : '#1b7a43'};">${esc(change)}</span></div>
            <div style="font-size:13px;${muted}">${sub}</div>
          </td></tr>
        </table>
      </td>`;
    const chart = (title, key, dKey, color) => {
      const vals = d.series.map((s) => s[key]);
      const { lo, hi } = niceRange(Math.min(...vals), Math.max(...vals));
      const H = 110;
      const h = (v) => Math.max(4, Math.round(4 + ((v - lo) / (hi - lo || 1)) * (H - 4)));
      const cols = d.series.map((s) => `
          <td width="${Math.floor(100 / d.series.length)}%" align="center" valign="bottom" style="padding:0 3px;">
            <div style="${font}font-size:11px;color:#1c1d21;padding-bottom:2px;">${esc(num(s[key]))}</div>
            <table role="presentation" width="70%" cellpadding="0" cellspacing="0"><tr>
              <td height="${h(s[key])}" style="height:${h(s[key])}px;line-height:${h(s[key])}px;font-size:0;background:${color};border-radius:3px 3px 0 0;">&nbsp;</td>
            </tr></table>
          </td>`).join('');
      const labels = d.series.map((s) => `<td align="center" style="${font}font-size:11px;${muted}padding-top:4px;border-top:1px solid #62646c;">${dm(s.day)}</td>`).join('');
      const deltas = d.series.map((s) => `<td align="center" style="${font}font-size:11px;color:${s[dKey] < 0 ? '#b42318' : s[dKey] > 0 ? '#1b7a43' : '#62646c'};">${esc(signed(s[dKey]))}</td>`).join('');
      return `
        <h3 style="${font}font-size:15px;margin:22px 0 2px;color:#1c1d21;">${esc(title)}</h3>
        <div style="${font}font-size:12px;${muted}margin-bottom:8px;">Số cuối mỗi ngày; trục bắt đầu từ ${esc(num(lo))} để thấy rõ thay đổi nhỏ. Dòng dưới: tăng/giảm so với ngày trước.</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>${cols}</tr><tr>${labels}</tr><tr>${deltas}</tr>
        </table>`;
    };
    const syncRows = [
      ...d.sync.workers.map((w) => [`Worker ${w.id}${w.version ? ` v${w.version}` : ''}`,
        `${w.alive ? 'Đang chạy' : '<strong style="color:#b42318;">Không phản hồi</strong>'} · heartbeat ${esc(when(w.at))} · LDAP ${w.ldapOk === false ? `<strong style="color:#b42318;">lỗi ${esc(w.error ?? '')}</strong>` : 'OK'}${w.dc ? ` · DC ${esc(w.dc)}` : ''}`]),
      ...(d.sync.workers.length ? [] : [['Worker', '<strong style="color:#b42318;">Chưa có worker nào gửi heartbeat</strong>']]),
      ['Sync thành công gần nhất', `${esc(when(d.sync.lastSuccess?.finished_at))} · full: ${esc(when(d.sync.lastFull?.finished_at))}`],
      ['Lượt sync trong kỳ', esc(runText(d.sync.runs))],
      ...(d.sync.quarantined ? [['Chờ duyệt', `<strong style="color:#9a5b00;">${esc(num(d.sync.quarantined))} lượt bị giữ lại</strong>`]] : []),
      ...d.sync.alerts.map((a) => ['Cảnh báo', `<span style="color:${a.severity === 'high' ? '#b42318' : '#9a5b00'};">${esc(a.subject)}</span>`]),
      ...(d.sync.duplicates ? [['Key ID trùng', `${esc(num(d.sync.duplicates))} cặp chưa xem xét`]] : []),
    ].map(([k, v]) => `<tr><td width="34%" style="${cell}${muted}">${esc(k)}</td><td style="${cell}">${v}</td></tr>`).join('');
    const branchRows = d.byBranch.map((b) => `<tr><td style="${cell}"><strong>${esc(b.code ?? 'N/A')}</strong> <span style="${muted}">${esc(b.name ?? 'chưa thuộc chi nhánh')}</span></td>
      <td align="right" style="${cell}">+${esc(num(b.new_computers))}</td><td align="right" style="${cell}">−${esc(num(b.left_computers))}</td><td align="right" style="${cell}">+${esc(num(b.new_keys))}</td></tr>`).join('');
    const th = (s, align = 'left') => `<th align="${align}" style="${font}font-size:12px;${muted}font-weight:600;padding:6px 8px;border-bottom:2px solid #dcdee4;">${esc(s)}</th>`;
    const link = d.appUrl ? `<p style="${font}font-size:14px;margin:20px 0 0;"><a href="${esc(d.appUrl.replace(/\/$/, ''))}/dashboard" style="color:#1f5fbf;">Mở trang Tổng quan →</a></p>` : '';

    const html = `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(t.subject)}</title></head>
<body style="margin:0;padding:0;background:#f6f7f9;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f9;"><tr><td align="center" style="padding:16px;">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#ffffff;border:1px solid #dcdee4;border-radius:8px;">
<tr><td style="${font}padding:20px 24px;">
  <div style="font-size:12px;${muted}text-transform:uppercase;letter-spacing:.04em;">BitLocker · Báo cáo hằng ngày</div>
  <h2 style="font-size:20px;margin:4px 0 4px;color:#1c1d21;">${esc(periodText.charAt(0).toUpperCase() + periodText.slice(1))}</h2>
  <div style="font-size:14px;${muted}">${esc(t.body)}</div>

  <h3 style="font-size:15px;margin:20px 0 6px;color:#1c1d21;">Đồng bộ AD ${badge(d.sync.online, syncText)}${d.sync.online ? '' : ` <span style="font-size:13px;font-weight:400;${muted}">từ ${esc(when(d.sync.offlineSince))}</span>`}</h3>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${syncRows}</table>

  <h3 style="font-size:15px;margin:22px 0 8px;color:#1c1d21;">Thay đổi trong kỳ</h3>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    ${stat('Máy trên hệ thống', num(last?.computers), signed(last?.dComputers ?? 0), `${esc(num(c.new_computers))} mới ghi nhận · ${esc(num(c.left_computers))} không còn trong AD`)}
    ${stat('Recovery key', num(last?.keys), signed(last?.dKeys ?? 0), `${esc(num(c.new_keys))} mới ghi nhận${c.keys_of_left ? ` · ${esc(num(c.keys_of_left))} thuộc máy rời AD (vẫn lưu)` : ''}${c.keys_moved ? ` · ${esc(num(c.keys_moved))} chuyển máy` : ''}`)}
  </tr></table>
  ${d.byBranch.length ? `
  <h3 style="font-size:15px;margin:22px 0 6px;color:#1c1d21;">Chi nhánh có thay đổi</h3>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr>${th('Chi nhánh')}${th('Máy mới', 'right')}${th('Rời AD', 'right')}${th('Key mới', 'right')}</tr>${branchRows}
  </table>` : ''}
  ${chart(`Số máy, ${CHART_DAYS} ngày gần nhất`, 'computers', 'dComputers', '#2a78d6')}
  ${chart(`Số key, ${CHART_DAYS} ngày gần nhất`, 'keys', 'dKeys', '#eb6834')}
  ${link}
  <p style="font-size:12px;${muted}margin:20px 0 0;border-top:1px solid #dcdee4;padding-top:10px;">Email không chứa recovery key. Tắt hoặc đổi giờ gửi: Quản trị &gt; Thông báo &gt; Báo cáo hằng ngày.</p>
</td></tr></table>
</td></tr></table>
</body></html>`;
    return { subject: t.subject, text: lines.join('\n'), html };
  }
}
