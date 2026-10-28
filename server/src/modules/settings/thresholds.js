// Thresholds of the sync anomaly checks and the watchdog, editable under Quan tri > Nguong canh bao.
// Stored in app_setting under `key`. unit 'percent' is stored as a ratio (0.95) and shown as 95;
// the other units are stored as shown. Defaults match loadThresholds() and the watchdog.

import { tk } from '../../i18n/index.js';

export const THRESHOLDS = [
  // When a sync run reports success (POST /complete): a breach quarantines the run.
  { key: 'anomaly.min_empty_pwd_keys', group: 'run', check: 'key_attr_unreadable', unit: 'count', default: 1, min: 1, max: 100000,
    label: tk('Lượt báo khi có ít nhất (số key không đọc được mật khẩu)') },
  { key: 'anomaly.min_computer_ratio', group: 'run', check: 'computers_drop', unit: 'percent', default: 0.95, min: 50, max: 100,
    label: tk('Lượt full phải thấy ít nhất (% số máy đang có)') },
  { key: 'anomaly.min_key_ratio', group: 'run', check: 'keys_drop', unit: 'percent', default: 0.95, min: 50, max: 100,
    label: tk('Lượt full phải thấy ít nhất (% số key đang có)') },
  { key: 'full_sync.max_delete_ratio', group: 'run', check: 'mass_delete', unit: 'percent', default: 0.05, min: 0, max: 100,
    label: tk('Lượt full không thấy tối đa (% số máy) trước khi bị giữ lại') },
  { key: 'anomaly.branch_drop_ratio', group: 'run', check: 'branch_drop', unit: 'percent', default: 0.2, min: 1, max: 100,
    label: tk('Một chi nhánh giảm quá (% so với mức thường)') },
  { key: 'anomaly.branch_drop_min', group: 'run', check: 'branch_drop', unit: 'count', default: 10, min: 1, max: 100000,
    label: tk('... và giảm quá (số máy)') },

  // Watchdog: how often it checks, and what opens an alert.
  { key: 'jobs.watchdog_interval_minutes', group: 'watchdog', unit: 'minutes', default: 5, min: 1, max: 60,
    label: tk('Watchdog kiểm tra mỗi (phút)') },
  { key: 'watchdog.heartbeat_max_minutes', group: 'watchdog', alert: 'worker_silent', unit: 'minutes', default: 15, min: 5, max: 1440,
    label: tk('Không có heartbeat của worker quá (phút)') },
  { key: 'watchdog.delta_max_minutes', group: 'watchdog', alert: 'sync_stale', unit: 'minutes', default: 60, min: 15, max: 10080,
    label: tk('Không có lượt sync thành công quá (phút)') },
  { key: 'watchdog.full_max_hours', group: 'dataalerts', alert: 'full_stale', unit: 'hours', default: 26, min: 1, max: 720,
    label: tk('Không có lượt full thành công quá (giờ)') },
  { key: 'watchdog.running_max_hours', group: 'watchdog', alert: 'sync_run_aborted', unit: 'hours', default: 2, min: 1, max: 72,
    label: tk('Lượt sync "đang chạy" quá (giờ) thì hủy') },
  { key: 'anomaly.usn_stall_hours', group: 'watchdog', alert: 'dc_usn_stalled', unit: 'hours', default: 6, min: 1, max: 168,
    label: tk('USN của DC không đổi quá (giờ)') },
  { key: 'anomaly.canary_max_age_minutes', group: 'watchdog', alert: 'canary_stale', unit: 'minutes', default: 90, min: 10, max: 10080,
    label: tk('Giá trị canary cũ quá (phút)') },
  { key: 'anomaly.escrow_ratio', group: 'dataalerts', alert: 'escrow_broken', unit: 'percent', default: 0.5, min: 1, max: 100,
    label: tk('Máy mới (2–7 ngày) chưa có key quá (%)') },
  { key: 'anomaly.escrow_min_new', group: 'dataalerts', alert: 'escrow_broken', unit: 'count', default: 5, min: 1, max: 100000,
    label: tk('... chỉ xét khi số máy mới ít nhất là') },
  { key: 'anomaly.no_key_pp_increase', group: 'dataalerts', alert: 'no_key_rising', unit: 'points', default: 5, min: 1, max: 100,
    label: tk('Tỉ lệ máy chưa có key của chi nhánh tăng quá (điểm %, so với tuần trước)') },

  // Data alerts: after "handled" the alert is closed and the watchdog looks again after this long.
  { key: 'alerts.fix_grace_hours', group: 'dataalerts', unit: 'hours', default: 24, min: 1, max: 720,
    label: tk('Sau khi bấm "Đã xử lý", theo dõi lại cảnh báo đó sau (giờ)') },

  // Computers: when the last AD logon still counts as "recent" (label on the computer page and list).
  { key: 'computer.recent_months', group: 'activity', unit: 'months', default: 3, min: 1, max: 60,
    label: tk('Máy được coi là "Hoạt động gần đây" nếu có đăng nhập AD trong (tháng)') },
];

/** Stored value -> value shown in the form. */
export const toForm = (t, stored) => (t.unit === 'percent' ? Math.round(Number(stored) * 1000) / 10 : Number(stored));
/** Form value -> stored value. */
export const fromForm = (t, shown) => (t.unit === 'percent' ? Number(shown) / 100 : Number(shown));
