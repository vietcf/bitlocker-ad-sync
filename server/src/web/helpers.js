// Formatting helpers available in every template (res.locals.h), bound to the request's language.
import { anomalyText } from '../modules/sync/anomaly.js';
import { describePasswordPolicy } from '../modules/auth/password.js';
import { runRef } from '../modules/sync/run-ref.js';
import { tk, translator } from '../i18n/index.js';
import { errorText, fieldText } from './messages.js';

const TZ = 'Asia/Ho_Chi_Minh';
const LOCALES = { vi: 'vi-VN', en: 'en-GB' };

const formatters = new Map();
function formatters_(lang) {
  if (!formatters.has(lang)) {
    const locale = LOCALES[lang] ?? LOCALES.en;
    formatters.set(lang, {
      dateTime: new Intl.DateTimeFormat(locale, { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' }),
      date: new Intl.DateTimeFormat(locale, { timeZone: TZ, dateStyle: 'short' }),
      number: new Intl.NumberFormat(locale),
    });
  }
  return formatters.get(lang);
}

// Display names of roles, key and run states, audit actions (Vietnamese source text = translation key).
export const ROLE_LABELS = { it: tk('IT chi nhánh'), lead: tk('Trưởng IT chi nhánh'), admin: 'Admin HQ', auditor: 'Auditor' };

export const KEY_STATUS = {
  active: { label: tk('Đang dùng'), tone: 'good' },
  superseded: { label: tk('Có key mới hơn'), tone: 'muted' },
};

export const RUN_STATUS = {
  running: { label: tk('Đang chạy'), tone: 'info' },
  success: { label: tk('Thành công'), tone: 'good' },
  quarantined: { label: tk('Cách ly'), tone: 'warn' },
  failed: { label: tk('Lỗi'), tone: 'bad' },
  aborted: { label: tk('Bị hủy'), tone: 'bad' },
};

export const ACTION_LABELS = {
  login: tk('Đăng nhập'),
  login_failed: tk('Đăng nhập lỗi'),
  password_change: tk('Đổi mật khẩu'),
  search: tk('Tìm kiếm'),
  view_computer: tk('Xem máy'),
  reveal: tk('Hiện key'),
  reveal_denied: tk('Bị chặn hiện key (cũ)'),
  rotation_done: tk('Xác nhận xoay key (cũ)'),
  export_log: tk('Xuất log'),
  export_computers: tk('Xuất danh sách máy'),
  export_keys: tk('Xuất key'),
  export_report: tk('Xuất báo cáo'),
  log_purge: tk('Xóa nhật ký cũ (theo hạn lưu trữ)'),
  computer_edit: tk('Sửa thông tin máy'),
  admin_change: tk('Thay đổi quản trị'),
  computer_moved: tk('Máy đổi chi nhánh'),
  sync_manual: tk('Yêu cầu sync'),
  sync_ack: tk('Xử lý sync cách ly'),
  key_duplicate_review: tk('Kiểm tra Key ID trùng'),
  alert_ack: tk('Xử lý cảnh báo sync'),
  alert_snooze: tk('Bỏ qua cảnh báo sync'),
  backup_run: tk('Sao lưu'),
  backup_download: tk('Tải file sao lưu'),
};

/** Shown for a computer in no branch (outside every branch OU). */
export const NO_BRANCH = 'N/A';

/** Helpers for one language ('en' | 'vi'). */
export function makeHelpers(language) {
  const { lang, t } = translator(language);
  const fmt = formatters_(lang);
  const roleName = (r) => (ROLE_LABELS[r] ? t(ROLE_LABELS[r]) : r);
  return {
    lang,
    branchCode: (code) => code ?? NO_BRANCH,
    errorText: (err) => errorText(err, t),
    fieldText: (message) => fieldText(message, t),
    anomalyText: (a) => anomalyText(a, t),
    /** The password rules in words (settings page). */
    passwordPolicy: (policy) => describePasswordPolicy(policy, t),
    /** Readable number of a sync run: 20261018-0042 (the day it started + its sequence number). */
    runRef: (run) => runRef(run.id, run.started_at),
    /** Recent AD logon of a computer: { label, cls } (recent = within `months`, setting computer.recent_months; AD records it with ~14 days of delay). */
    activity: (d, months = 3) => {
      if (!d) return { label: t('Chưa có dữ liệu'), cls: 'badge-muted' };
      const recent = Date.now() - new Date(d).getTime() <= months * 30.44 * 86_400_000;
      return recent ? { label: t('Hoạt động gần đây'), cls: 'badge-good' } : { label: t('Không hoạt động gần đây'), cls: 'badge-warn' };
    },
    /** Tooltip explaining the last AD logon. */
    activityTip: (months) =>
      t('Lần máy này đăng nhập (xác thực) vào domain gần nhất, theo thuộc tính lastLogonTimestamp của máy trên AD. AD chỉ cập nhật khi giá trị cũ hơn khoảng 14 ngày nên số liệu có thể lệch tối đa ~14 ngày. Chỉ cho biết "chưa thấy máy đăng nhập domain", không có nghĩa máy đã hỏng hay bị bỏ. "Hoạt động gần đây" = trong {months} tháng (Quản trị > Ngưỡng cảnh báo). "Chưa có dữ liệu" = máy chưa từng đăng nhập hoặc worker chưa báo giá trị này.', { months }),
    dateTime: (d) => (d ? fmt.dateTime.format(new Date(d)) : '—'),
    date: (d) => (d ? fmt.date.format(new Date(d)) : '—'),
    role: roleName,
    keyStatus: (s) => (KEY_STATUS[s] ? { ...KEY_STATUS[s], label: t(KEY_STATUS[s].label) } : { label: s, tone: 'muted' }),
    runStatus: (s) => (RUN_STATUS[s] ? { ...RUN_STATUS[s], label: t(RUN_STATUS[s].label) } : { label: s, tone: 'muted' }),
    action: (a) => (ACTION_LABELS[a] ? t(ACTION_LABELS[a]) : a),
    /** "HN, HCM" | "All branches" | "None" for a branch set and a list of branches. */
    branchSet(set, branches) {
      if (set === 'all') return t('Tất cả chi nhánh');
      if (!set?.length) return t('Không có');
      return set.map((id) => branches.find((b) => b.id === id)?.code ?? `#${id}`).join(', ');
    },
    grant: (g) => `${roleName(g.role)}${g.branchId === null ? ` (${t('tất cả')})` : ` · ${g.branchCode ?? g.branchId}`}`,
    /** Current query string with some values replaced (for pagination and filters). */
    query(current, changes) {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries({ ...current, ...changes })) {
        if (v !== undefined && v !== null && v !== '') p.set(k, v instanceof Date ? v.toISOString().slice(0, 10) : String(v));
      }
      const s = p.toString();
      return s ? `?${s}` : '';
    },
    /** YYYY-MM-DD of n days ago in APP_TZ (quick period links). */
    daysAgo: (n) => new Intl.DateTimeFormat('en-CA', { timeZone: process.env.APP_TZ ?? 'Asia/Ho_Chi_Minh' }).format(new Date(Date.now() - n * 86_400_000)),
    number: (n) => (n === null || n === undefined ? '—' : fmt.number.format(n)),
  };
}
