import { withAllBranches } from '../../db/scoped.js';
import { DATA_ALERT_TYPES } from '../alerts/alerts.service.js';
import { niceRange } from '../../web/charts.js';
import { inventoryPerDay } from '../dashboard/dashboard.repo.js';
import { translator } from '../../i18n/index.js';
import { adminRecipients, adminsWithoutEmail } from '../mail/mail.repo.js';
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
// Number and date formats of the mail being rendered: render() sets them (it is synchronous, so nothing interleaves).
let locale = 'vi-VN';
const num = (n) => new Intl.NumberFormat(locale).format(n ?? 0);
const pctText = (n) => `${new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n ?? 0)}%`;
const signedPct = (n) => (n > 0 ? `+${pctText(n).slice(0, -1)}` : n < 0 ? `−${pctText(-n).slice(0, -1)}` : '0');
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
    const admins = opts.admins ? await adminRecipients(this.pool) : [];
    const recipients = [...opts.extra, ...admins]; // plain addresses get the default language, users their own
    const r = await this.mail.enqueueLocalized({
      kind: 'daily_report',
      recipients,
      build: (lang) => {
        const mail = this.render(data, lang);
        return { subject: mail.subject, body: mail.text, html: mail.html };
      },
      missing: opts.admins ? await adminsWithoutEmail(this.pool) : [],
      reason: 'No recipient: no Admin HQ user with an e-mail address and no extra address (Admin > Notifications > Daily report).',
    });
    return { ...r, recipients: new Set(recipients.map((x) => String(x.email ?? x).trim().toLowerCase())).size };
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
      const months = Number(await this.settings.get('computer.recent_months', 3)); // bo may lau khong dang nhap AD (qua N thang); may chua co du lieu van tinh
      const range = [bounds.start, bounds.end, months];
      const recent = '(c.last_logon_at IS NULL OR c.last_logon_at >= now() - make_interval(months => $3))';
      const { rows: [changes] } = await tx.query(
        `SELECT
           (SELECT count(*)::int FROM computer c WHERE c.first_seen_at >= $1 AND c.first_seen_at < $2 AND ${recent}) AS new_computers,
           (SELECT count(*)::int FROM computer c WHERE c.deleted_in_ad_at >= $1 AND c.deleted_in_ad_at < $2 AND ${recent}) AS left_computers,
           (SELECT count(*)::int FROM recovery_key k JOIN computer c ON c.id = k.computer_id
             WHERE k.first_synced_at >= $1 AND k.first_synced_at < $2 AND ${recent}) AS new_keys,
           (SELECT count(*)::int FROM recovery_key k JOIN computer c ON c.id = k.computer_id
             WHERE c.deleted_in_ad_at >= $1 AND c.deleted_in_ad_at < $2 AND ${recent}) AS keys_of_left,
           (SELECT count(*)::int FROM key_owner_change o JOIN computer c ON c.id = o.to_computer_id
             WHERE o.at >= $1 AND o.at < $2 AND ${recent}) AS keys_moved`,
        range,
      );
      const { rows: byBranch } = await tx.query(
        `SELECT b.code, b.name, x.new_computers, x.left_computers, x.new_keys FROM (
           SELECT c.branch_id,
                  count(*) FILTER (WHERE c.first_seen_at >= $1 AND c.first_seen_at < $2 AND ${recent})::int AS new_computers,
                  count(*) FILTER (WHERE c.deleted_in_ad_at >= $1 AND c.deleted_in_ad_at < $2 AND ${recent})::int AS left_computers,
                  coalesce(sum(CASE WHEN ${recent} THEN (SELECT count(*) FROM recovery_key k
                                 WHERE k.computer_id = c.id AND k.first_synced_at >= $1 AND k.first_synced_at < $2) ELSE 0 END), 0)::int AS new_keys
             FROM computer c GROUP BY c.branch_id) x
           LEFT JOIN branch b ON b.id = x.branch_id
          WHERE x.new_computers + x.left_computers + x.new_keys > 0
          ORDER BY x.new_computers + x.left_computers + x.new_keys DESC, b.code NULLS FIRST
          LIMIT 15`,
        range,
      );
      const { rows: runs } = await tx.query(
        `SELECT status, count(*)::int AS n FROM sync_run WHERE started_at >= $1 AND started_at < $2 GROUP BY status`,
        range.slice(0, 2),
      );
      const { rows: alerts } = await tx.query(
        `SELECT type, severity, opened_at, detail->>'subject' AS subject, detail->>'subject_en' AS subject_en FROM sync_alert
          WHERE resolved_at IS NULL
            AND NOT (type = ANY($1::text[]) AND snoozed_until > now())
          ORDER BY severity, opened_at`,
        [DATA_ALERT_TYPES],
      );
      const { rows: [dup] } = await tx.query('SELECT count(*)::int AS n FROM key_duplicate WHERE resolved_at IS NULL');

      // End-of-day totals: 12 days ending today, so each shown day has the day before it.
      const inv = await inventoryPerDay(tx, 'all', CHART_DAYS + 2, this.tz, { recentMonths: months, withKey: true });
      const end = period === 'today' ? inv.length - 1 : inv.length - 2;
      const pct = (r) => (r.computers > 0 ? Math.round((1000 * r.computers_with_key) / r.computers) / 10 : 0);
      const series = inv.slice(end - CHART_DAYS + 1, end + 1).map((r, i) => {
        const prev = inv[end - CHART_DAYS + i];
        return {
          day: r.day, computers: r.computers, keys: r.keys, dComputers: r.computers - prev.computers, dKeys: r.keys - prev.keys,
          withKey: r.computers_with_key, pct: pct(r), dPct: Math.round((pct(r) - pct(prev)) * 10) / 10,
        };
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
      const workerOff = alerts.find((a) => a.type === 'worker_offline') ?? null;
      const problem = alerts.find((a) => a.type === 'sync_problem') ?? null;
      return {
        period,
        recentMonths: months,
        day,
        start: bounds.start,
        end: bounds.end,
        changes,
        byBranch,
        series,
        sync: {
          workerOnline: !workerOff,
          workerOfflineSince: workerOff?.opened_at ?? null,
          // AD / the sync: only judged while the worker runs.
          adState: workerOff ? 'unknown' : problem ? 'problem' : 'ok',
          problemSince: problem?.opened_at ?? null,
          alerts: alerts.filter((a) => !['worker_offline', 'sync_problem', 'sync_offline'].includes(a.type)),
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
  render(d, lang = 'vi') {
    const { t } = translator(lang);
    locale = lang === 'vi' ? 'vi-VN' : 'en-GB';
    const when = (x) => (x ? new Intl.DateTimeFormat(locale, { timeZone: this.tz, dateStyle: 'short', timeStyle: 'short' }).format(new Date(x)) : '—');
    const alertSubject = (a) => (lang === 'en' ? a.subject_en ?? a.subject : a.subject);
    const c = d.changes;
    const last = d.series[d.series.length - 1];
    const periodText = d.period === 'today' ? t('ngày {day} (tính đến {until})', { day: dmy(d.day), until: when(d.end) }) : t('ngày {day}', { day: dmy(d.day) });
    // Two statuses: the worker (Online / Offline) and AD / the sync (Binh thuong / Co su co / chua xac dinh).
    const workerText = d.sync.workerOnline ? 'Online' : 'Offline';
    const adText = { ok: t('bình thường'), problem: t('có sự cố'), unknown: t('chưa xác định') }[d.sync.adState];
    const syncText = t('worker {worker}, AD {ad}', { worker: workerText, ad: adText });
    const tpl = this.templates.render('daily_report', {
      day: dmy(d.day),
      period: periodText,
      syncStatus: syncText,
      computers: num(last?.computers),
      keys: num(last?.keys),
      computersChange: signed(last?.dComputers ?? 0),
      keysChange: signed(last?.dKeys ?? 0),
    }, { lang });
    const runText = (r) => t('{ok} thành công, {failed} lỗi, {held} bị giữ lại', { ok: num(r.success ?? 0), failed: num(r.failed ?? 0), held: num(r.quarantined ?? 0) });

    const note = t('Chỉ tính máy hoạt động gần đây (đăng nhập AD trong {months} tháng, gồm máy chưa có dữ liệu đăng nhập) và key của các máy đó.', { months: d.recentMonths });

    // ---- plain text ----
    const lines = [
      tpl.body,
      '',
      t('WORKER: {state}{since}', { state: workerText, since: d.sync.workerOnline ? '' : t(' từ {at}', { at: when(d.sync.workerOfflineSince) }) }),
      t('ĐỒNG BỘ AD: {state}{since}', { state: adText, since: d.sync.adState === 'problem' ? t(' từ {at}', { at: when(d.sync.problemSince) }) : '' }),
      ...d.sync.workers.map((w) => t('- Worker {id}{version}: heartbeat {at} ({alive}), LDAP {ldap}{dc}', { id: w.id, version: w.version ? ` v${w.version}` : '', at: when(w.at), alive: w.alive ? t('đang chạy') : t('không phản hồi'), ldap: w.ldapOk === false ? t('lỗi {error}', { error: w.error ?? '' }) : 'OK', dc: w.dc ? `, DC ${w.dc}` : '' })),
      d.sync.workers.length ? null : t('- Chưa có worker nào gửi heartbeat'),
      t('- Lượt sync thành công gần nhất: {last}; full gần nhất: {full}', { last: when(d.sync.lastSuccess?.finished_at), full: when(d.sync.lastFull?.finished_at) }),
      t('- Lượt sync trong kỳ: {runs}', { runs: runText(d.sync.runs) }),
      d.sync.quarantined ? t('- {n} lượt đang chờ Admin HQ duyệt', { n: num(d.sync.quarantined) }) : null,
      ...d.sync.alerts.map((a) => t('- Cảnh báo: {subject}', { subject: alertSubject(a) })),
      d.sync.duplicates ? t('- {n} Key ID trùng giữa nhiều máy chưa xem xét', { n: num(d.sync.duplicates) }) : null,
      '',
      t('MÁY: {total} ({change}): {added} mới ghi nhận, {left} không còn trong phạm vi giám sát', { total: num(last?.computers), change: signed(last?.dComputers ?? 0), added: num(c.new_computers), left: num(c.left_computers) }),
      t('TỈ LỆ MÁY CÓ KEY: {pct} ({change} điểm %): {withKey}/{computers} máy', { pct: pctText(last?.pct), change: signedPct(last?.dPct ?? 0), withKey: num(last?.withKey), computers: num(last?.computers) }),
      t('KEY: {total} ({change}): {added} mới ghi nhận{ofLeft}{moved}', { total: num(last?.keys), change: signed(last?.dKeys ?? 0), added: num(c.new_keys), ofLeft: c.keys_of_left ? t(', {n} key thuộc máy vừa rời phạm vi giám sát (vẫn lưu)', { n: num(c.keys_of_left) }) : '', moved: c.keys_moved ? t(', {n} key chuyển sang máy mới (join lại AD)', { n: num(c.keys_moved) }) : '' }),
      '',
      ...(d.byBranch.length ? [t('THEO CHI NHÁNH (có thay đổi):'), ...d.byBranch.map((b) => t('- {code}: máy +{added} / −{left}, key +{keys}', { code: b.code ?? 'N/A', added: b.new_computers, left: b.left_computers, keys: b.new_keys })), ''] : []),
      t('{days} NGÀY GẦN NHẤT (cuối mỗi ngày):', { days: CHART_DAYS }),
      ...d.series.map((s) => t('- {day}: {computers} máy ({dc}), {keys} key ({dk}), có key {pct} ({dp})', { day: dm(s.day), computers: num(s.computers), dc: signed(s.dComputers), keys: num(s.keys), dk: signed(s.dKeys), pct: pctText(s.pct), dp: signedPct(s.dPct) })),
      '',
      note,
      t('Email không chứa recovery key. Tắt hoặc đổi giờ gửi: Quản trị > Thông báo > Báo cáo hằng ngày.'),
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
    const chart = (title, key, dKey, color, fmt = num, dfmt = signed, unit = '') => {
      const vals = d.series.map((s) => s[key]);
      const { lo, hi } = niceRange(Math.min(...vals), Math.max(...vals));
      const H = 110;
      const h = (v) => Math.max(4, Math.round(4 + ((v - lo) / (hi - lo || 1)) * (H - 4)));
      const cols = d.series.map((s) => `
          <td width="${Math.floor(100 / d.series.length)}%" align="center" valign="bottom" style="padding:0 3px;">
            <div style="${font}font-size:11px;color:#1c1d21;padding-bottom:2px;">${esc(fmt(s[key]))}</div>
            <table role="presentation" width="70%" cellpadding="0" cellspacing="0"><tr>
              <td height="${h(s[key])}" style="height:${h(s[key])}px;line-height:${h(s[key])}px;font-size:0;background:${color};border-radius:3px 3px 0 0;">&nbsp;</td>
            </tr></table>
          </td>`).join('');
      const labels = d.series.map((s) => `<td align="center" style="${font}font-size:11px;${muted}padding-top:4px;border-top:1px solid #62646c;">${dm(s.day)}</td>`).join('');
      const deltas = d.series.map((s) => `<td align="center" style="${font}font-size:11px;color:${s[dKey] < 0 ? '#b42318' : s[dKey] > 0 ? '#1b7a43' : '#62646c'};">${esc(dfmt(s[dKey]))}</td>`).join('');
      return `
        <h3 style="${font}font-size:15px;margin:22px 0 2px;color:#1c1d21;">${esc(title)}</h3>
        <div style="${font}font-size:12px;${muted}margin-bottom:8px;">${esc(t('Số cuối mỗi ngày; trục bắt đầu từ {from} để thấy rõ thay đổi nhỏ. Dòng dưới: tăng/giảm so với ngày trước{unit}.', { from: fmt(lo), unit }))}</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>${cols}</tr><tr>${labels}</tr><tr>${deltas}</tr>
        </table>`;
    };
    const syncRows = [
      ...d.sync.workers.map((w) => [`Worker ${w.id}${w.version ? ` v${w.version}` : ''}`,
        `${w.alive ? esc(t('Đang chạy')) : `<strong style="color:#b42318;">${esc(t('Không phản hồi'))}</strong>`} · heartbeat ${esc(when(w.at))} · LDAP ${w.ldapOk === false ? `<strong style="color:#b42318;">${esc(t('lỗi {error}', { error: w.error ?? '' }))}</strong>` : 'OK'}${w.dc ? ` · DC ${esc(w.dc)}` : ''}`]),
      ...(d.sync.workers.length ? [] : [['Worker', `<strong style="color:#b42318;">${esc(t('Chưa có worker nào gửi heartbeat'))}</strong>`]]),
      [t('Sync thành công gần nhất'), `${esc(when(d.sync.lastSuccess?.finished_at))} · full: ${esc(when(d.sync.lastFull?.finished_at))}`],
      [t('Lượt sync trong kỳ'), esc(runText(d.sync.runs))],
      ...(d.sync.quarantined ? [[t('Chờ duyệt'), `<strong style="color:#9a5b00;">${esc(t('{n} lượt bị giữ lại', { n: num(d.sync.quarantined) }))}</strong>`]] : []),
      ...d.sync.alerts.map((a) => [t('Cảnh báo'), `<span style="color:${a.severity === 'high' ? '#b42318' : '#9a5b00'};">${esc(alertSubject(a))}</span>`]),
      ...(d.sync.duplicates ? [[t('Key ID trùng'), esc(t('{n} cặp chưa xem xét', { n: num(d.sync.duplicates) }))]] : []),
    ].map(([k, v]) => `<tr><td width="34%" style="${cell}${muted}">${esc(k)}</td><td style="${cell}">${v}</td></tr>`).join('');
    const branchRows = d.byBranch.map((b) => `<tr><td style="${cell}"><strong>${esc(b.code ?? 'N/A')}</strong> <span style="${muted}">${esc(b.name ?? t('chưa thuộc chi nhánh'))}</span></td>
      <td align="right" style="${cell}">+${esc(num(b.new_computers))}</td><td align="right" style="${cell}">−${esc(num(b.left_computers))}</td><td align="right" style="${cell}">+${esc(num(b.new_keys))}</td></tr>`).join('');
    const thCell = (s, align = 'left') => `<th align="${align}" style="${font}font-size:12px;${muted}font-weight:600;padding:6px 8px;border-bottom:2px solid #dcdee4;">${esc(s)}</th>`;
    const link = d.appUrl ? `<p style="${font}font-size:14px;margin:20px 0 0;"><a href="${esc(d.appUrl.replace(/\/$/, ''))}/dashboard" style="color:#1f5fbf;">${esc(t('Mở trang Tổng quan →'))}</a></p>` : '';

    const html = `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(tpl.subject)}</title></head>
<body style="margin:0;padding:0;background:#f6f7f9;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f9;"><tr><td align="center" style="padding:16px;">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#ffffff;border:1px solid #dcdee4;border-radius:8px;">
<tr><td style="${font}padding:20px 24px;">
  <div style="font-size:12px;${muted}text-transform:uppercase;letter-spacing:.04em;">${esc(t('BitLocker · Báo cáo hằng ngày'))}</div>
  <h2 style="font-size:20px;margin:4px 0 4px;color:#1c1d21;">${esc(periodText.charAt(0).toUpperCase() + periodText.slice(1))}</h2>
  <div style="font-size:14px;${muted}">${esc(tpl.body)}</div>

  <h3 style="font-size:15px;margin:20px 0 6px;color:#1c1d21;">Worker ${badge(d.sync.workerOnline, workerText)}${d.sync.workerOnline ? '' : ` <span style="font-size:13px;font-weight:400;${muted}">${esc(t('từ {at}', { at: when(d.sync.workerOfflineSince) }))}</span>`}
    &nbsp; ${esc(t('Đồng bộ AD'))} ${d.sync.adState === 'unknown' ? `<span style="font-size:13px;font-weight:600;${muted}">${esc(t('chưa xác định'))}</span>` : badge(d.sync.adState === 'ok', d.sync.adState === 'ok' ? t('Bình thường') : t('Có sự cố'))}</h3>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${syncRows}</table>

  <h3 style="font-size:15px;margin:22px 0 8px;color:#1c1d21;">${esc(t('Thay đổi trong kỳ'))}</h3>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    ${stat(t('Máy trên hệ thống'), num(last?.computers), signed(last?.dComputers ?? 0), esc(t('{added} mới ghi nhận · {left} không còn trong phạm vi giám sát', { added: num(c.new_computers), left: num(c.left_computers) })))}
    ${stat('Recovery key', num(last?.keys), signed(last?.dKeys ?? 0), `${esc(t('{added} mới ghi nhận', { added: num(c.new_keys) }))}${c.keys_of_left ? ` · ${esc(t('{n} thuộc máy rời phạm vi giám sát (vẫn lưu)', { n: num(c.keys_of_left) }))}` : ''}${c.keys_moved ? ` · ${esc(t('{n} chuyển máy', { n: num(c.keys_moved) }))}` : ''}`)}
  </tr></table>
  ${d.byBranch.length ? `
  <h3 style="font-size:15px;margin:22px 0 6px;color:#1c1d21;">${esc(t('Chi nhánh có thay đổi'))}</h3>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr>${thCell(t('Chi nhánh'))}${thCell(t('Máy mới'), 'right')}${thCell(t('Rời phạm vi'), 'right')}${thCell(t('Key mới'), 'right')}</tr>${branchRows}
  </table>` : ''}
  ${chart(t('Số máy, {days} ngày gần nhất', { days: CHART_DAYS }), 'computers', 'dComputers', '#2a78d6')}
  ${chart(t('Số key, {days} ngày gần nhất', { days: CHART_DAYS }), 'keys', 'dKeys', '#eb6834')}
  ${chart(t('Tỉ lệ máy có recovery key, {days} ngày gần nhất', { days: CHART_DAYS }), 'pct', 'dPct', '#1b7a43', pctText, signedPct, t(' (điểm %)'))}
  ${link}
  <p style="font-size:12px;${muted}margin:20px 0 0;border-top:1px solid #dcdee4;padding-top:10px;">${esc(note)} ${esc(t('Email không chứa recovery key. Tắt hoặc đổi giờ gửi: Quản trị > Thông báo > Báo cáo hằng ngày.'))}</p>
</td></tr></table>
</td></tr></table>
</body></html>`;
    return { subject: tpl.subject, text: lines.join('\n'), html };
  }
}
