// Tunable values from app_setting (reasons list, limits, thresholds). Read often, changed rarely:
// cached for a short time so a change from the admin side applies within CACHE_MS.

import { tk } from '../../i18n/index.js';

const CACHE_MS = 30_000;

/** Features Admin HQ can switch on or off (Quan tri > Tinh nang), with their defaults. */
export const FEATURES = [
  { key: 'feature.manual_sync', default: true }, // Admin HQ can ask the worker for a sync from the web
  { key: 'feature.audit_export', default: true }, // CSV export of the access log
  { key: 'feature.computer_export', default: true }, // CSV export of the computer list (no keys)
  { key: 'feature.reveal_alerts', default: true }, // alert on reveals outside working hours
  { key: 'reveal.ticket_required', default: false }, // a ticket number is required to reveal a key
];
/**
 * Alerts of the watchdog that Admin HQ can switch off (Quan tri > Dong bo AD > Canh bao sync), next to their
 * thresholds: system faults (group system) and data alerts (group data). Stored as app_setting "alert.<type>".
 */
export const ALERT_SWITCHES = [
  // group 'system': measured live by the watchdog (a switched-off one is not watched at all)
  { group: 'system', type: 'worker_silent', label: tk('Worker (agent) mất kết nối'), help: tk('Không có heartbeat quá ngưỡng: mail "Worker Offline". Tắt thì không theo dõi worker, kể cả các kiểm tra phụ thuộc worker.') },
  { group: 'system', type: 'ldap_error', label: tk('Worker không đọc được AD'), help: tk('DC offline, sai quyền hoặc lỗi TLS (không có ngưỡng chỉnh).') },
  { group: 'system', type: 'sync_stale', label: tk('Lâu không có lượt sync thành công'), help: tk('Không có lượt delta hoặc full thành công quá ngưỡng.') },
  { group: 'system', type: 'sync_run_aborted', label: tk('Lượt sync bị treo'), help: tk('Có lượt ở trạng thái "đang chạy" quá ngưỡng nên bị hủy.') },
  { group: 'system', type: 'canary_stale', label: tk('Canary cũ'), help: tk('Thay đổi thử trên AD không còn đến được server.') },
  { group: 'system', type: 'dc_usn_stalled', label: tk('USN của DC đứng yên'), help: tk('DC không còn nhận thay đổi trong thời gian quá ngưỡng.') },
  // group 'data': computed from stored data, still true for days after the cause is fixed
  { group: 'data', type: 'escrow_broken', label: tk('Máy mới không lưu key lên AD'), help: tk('Máy tạo trong 7 ngày qua (đã quá 48 giờ) mà tỉ lệ chưa có key vượt ngưỡng.') },
  { group: 'data', type: 'no_key_rising', label: tk('Tỉ lệ máy không có key tăng'), help: tk('Tỉ lệ máy chưa có key của một chi nhánh tăng so với tuần trước.') },
  { group: 'data', type: 'full_stale', label: tk('Full sync quá hạn'), help: tk('Lâu không có lượt full thành công. Lượt delta vẫn được theo dõi riêng (sự cố hệ thống).') },
  { group: 'data', type: 'dc_cert_expiring', label: tk('Chứng chỉ DC sắp hết hạn'), help: tk('Chứng chỉ LDAPS của DC còn dưới 30 ngày (không có ngưỡng chỉnh).') },
];
/**
 * Checks run when a full sync reports success (anomaly.js): a breach quarantines the run. Admin HQ can switch each one off
 * (Quan tri > Dong bo AD > Canh bao sync).
 * Stored as app_setting "check.<code>".
 */
export const CHECK_SWITCHES = [
  { code: 'computers_drop', label: tk('Lượt full thấy quá ít máy'), help: tk('Lượt full thấy ít hơn ngưỡng % số máy đang có thì bị giữ lại.') },
  { code: 'keys_drop', label: tk('Lượt full thấy quá ít key'), help: tk('Lượt full thấy ít hơn ngưỡng % số key đang có thì bị giữ lại.') },
  { code: 'branch_drop', label: tk('Một chi nhánh giảm đột ngột'), help: tk('Số máy một chi nhánh giảm quá ngưỡng so với mức thường.') },
  { code: 'key_attr_unreadable', label: tk('Có key nhưng không đọc được mật khẩu'), help: tk('Worker đọc được object key nhưng mật khẩu rỗng, thường do tài khoản sync mất quyền đọc thuộc tính confidential. Chạy cả lượt delta và full. Tắt thì key vẫn được lưu nhưng không có mật khẩu và không có cảnh báo nào.') },
  { code: 'mass_delete', label: tk('Quá nhiều máy sắp bị gắn "không còn trong phạm vi"'), help: tk('Lượt full không thấy quá ngưỡng % số máy đang giám sát.') },
];
const FEATURE_DEFAULTS = Object.fromEntries(FEATURES.map((f) => [f.key, f.default]));

export class SettingsService {
  #cache = null;
  #loadedAt = 0;

  constructor(pool, now = Date.now) {
    this.pool = pool;
    this.now = now;
  }

  async all() {
    if (this.#cache && this.now() - this.#loadedAt < CACHE_MS) return this.#cache;
    const { rows } = await this.pool.query('SELECT key, value FROM app_setting');
    this.#cache = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    this.#loadedAt = this.now();
    return this.#cache;
  }

  /** Drops the cache: the next read goes to the database. */
  invalidate() {
    this.#cache = null;
  }

  async get(key, fallback = null) {
    const all = await this.all();
    return key in all && all[key] !== null ? all[key] : fallback;
  }

  /** Whether a switchable feature (see FEATURES) is on. */
  async feature(key) {
    if (!(key in FEATURE_DEFAULTS)) throw new Error(`unknown feature ${key}`);
    return (await this.get(key, FEATURE_DEFAULTS[key])) === true;
  }

  /** Whether a data alert type is switched on (default: on). */
  async alertEnabled(type) {
    return (await this.get(`alert.${type}`, true)) !== false;
  }

  /** Whether a run check is switched on (default: on). */
  async checkEnabled(code) {
    return (await this.get(`check.${code}`, true)) !== false;
  }

  /** All switchable features: { [key]: boolean }. */
  async features() {
    const out = {};
    for (const f of FEATURES) out[f.key] = await this.feature(f.key);
    return out;
  }

  async set(key, value) {
    await this.pool.query(
      `INSERT INTO app_setting (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(value)],
    );
    this.#cache = null;
  }
}
