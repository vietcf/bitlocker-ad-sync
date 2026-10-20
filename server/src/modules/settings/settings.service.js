// Tunable values from app_setting (reasons list, limits, thresholds). Read often, changed rarely:
// cached for a short time so a change from the admin side applies within CACHE_MS.

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
 * Data alerts of the watchdog that Admin HQ can switch off (Quan tri > Dong bo AD > Canh bao sync), next to their
 * thresholds. System faults (worker, AD, overdue sync...) cannot be switched off. Stored as app_setting "alert.<type>".
 */
export const ALERT_SWITCHES = [
  { type: 'escrow_broken', label: 'Máy mới không lưu key lên AD', help: 'Máy tạo trong 7 ngày qua (đã quá 48 giờ) mà tỉ lệ chưa có key vượt ngưỡng.' },
  { type: 'no_key_rising', label: 'Tỉ lệ máy không có key tăng', help: 'Tỉ lệ máy chưa có key của một chi nhánh tăng so với tuần trước.' },
  { type: 'full_stale', label: 'Full sync quá hạn', help: 'Lâu không có lượt full thành công. Lượt delta vẫn được theo dõi riêng (sự cố hệ thống).' },
  { type: 'dc_cert_expiring', label: 'Chứng chỉ DC sắp hết hạn', help: 'Chứng chỉ LDAPS của DC còn dưới 30 ngày (không có ngưỡng chỉnh).' },
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
