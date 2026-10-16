// Formatting helpers available in every template (res.locals.h).
import { anomalyText } from '../modules/sync/anomaly.js';
import { errorText, fieldText } from './messages.js';

const TZ = 'Asia/Ho_Chi_Minh';
const dateTimeFmt = new Intl.DateTimeFormat('vi-VN', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' });
const dateFmt = new Intl.DateTimeFormat('vi-VN', { timeZone: TZ, dateStyle: 'short' });

export const ROLE_LABELS = { it: 'IT chi nhánh', lead: 'Trưởng IT chi nhánh', admin: 'Admin HQ', auditor: 'Auditor' };

export const KEY_STATUS = {
  active: { label: 'Đang dùng', tone: 'good' },
  superseded: { label: 'Có key mới hơn', tone: 'muted' },
};

export const RUN_STATUS = {
  running: { label: 'Đang chạy', tone: 'info' },
  success: { label: 'Thành công', tone: 'good' },
  quarantined: { label: 'Cách ly', tone: 'warn' },
  failed: { label: 'Lỗi', tone: 'bad' },
  aborted: { label: 'Bị hủy', tone: 'bad' },
};

export const ACTION_LABELS = {
  login: 'Đăng nhập',
  login_failed: 'Đăng nhập lỗi',
  password_change: 'Đổi mật khẩu',
  search: 'Tìm kiếm',
  view_computer: 'Xem máy',
  reveal: 'Hiện key',
  reveal_denied: 'Bị chặn hiện key (cũ)',
  rotation_done: 'Xác nhận xoay key (cũ)',
  export_log: 'Xuất log',
  export_computers: 'Xuất danh sách máy',
  export_keys: 'Xuất key',
  export_report: 'Xuất báo cáo',
  log_purge: 'Xóa nhật ký cũ (theo hạn lưu trữ)',
  computer_edit: 'Sửa thông tin máy',
  admin_change: 'Thay đổi quản trị',
  computer_moved: 'Máy đổi chi nhánh',
  sync_manual: 'Yêu cầu sync',
  sync_ack: 'Xử lý sync cách ly',
  key_duplicate_review: 'Xem xét Key ID trùng',
  backup_run: 'Sao lưu',
  backup_download: 'Tải file sao lưu',
};

/** Shown for a computer in no branch (outside every branch OU). */
export const NO_BRANCH = 'N/A';

export const helpers = {
  branchCode: (code) => code ?? NO_BRANCH,
  errorText,
  fieldText,
  anomalyText,
  dateTime: (d) => (d ? dateTimeFmt.format(new Date(d)) : '—'),
  date: (d) => (d ? dateFmt.format(new Date(d)) : '—'),
  role: (r) => ROLE_LABELS[r] ?? r,
  keyStatus: (s) => KEY_STATUS[s] ?? { label: s, tone: 'muted' },
  runStatus: (s) => RUN_STATUS[s] ?? { label: s, tone: 'muted' },
  action: (a) => ACTION_LABELS[a] ?? a,
  /** "HN, HCM" | "Tat ca chi nhanh" | "Khong co" for a branch set and a list of branches. */
  branchSet(set, branches) {
    if (set === 'all') return 'Tất cả chi nhánh';
    if (!set?.length) return 'Không có';
    return set.map((id) => branches.find((b) => b.id === id)?.code ?? `#${id}`).join(', ');
  },
  grant: (g) => `${ROLE_LABELS[g.role] ?? g.role}${g.branchId === null ? ' (tất cả)' : ` · ${g.branchCode ?? g.branchId}`}`,
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
  number: (n) => (n === null || n === undefined ? '—' : new Intl.NumberFormat('vi-VN').format(n)),
};
