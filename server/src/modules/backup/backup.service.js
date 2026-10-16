import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { withAllBranches } from '../../db/scoped.js';
import { can } from '../../domain/scope.js';
import { toCsv } from '../../http/csv.js';
import { badRequest, forbidden, notFound } from '../../http/errors.js';
import { checkbox, parse } from '../../http/validate.js';
import { decryptSecret, encryptSecret } from '../mail/secret.js';
import { isEncryptedZip, zipAes } from './zip-aes.js';

/** Quan tri > Sao luu (setting backup.options). */
export const BACKUP_DEFAULTS = {
  enabled: false,
  time: '01:30', // HH:MM in APP_TZ, once a day
  keys: true, // computers + recovery keys (CSV in an AES-256 zip)
  database: true, // pg_dump of the whole database (needs BACKUP_DATABASE_URL)
  keep: 14, // newest files kept per kind
  encrypt: true, // AES-256 with the backup password; off = plain ZIP (Admin HQ choice, shown as a risk)
};
export const BACKUP_PASSWORD_MIN = 16;

const PASSWORD_KEY = 'backup.password'; // encrypted (AES-256-GCM, key from LOG_HMAC_KEY)
const LAST_DAY_KEY = 'backup.last_day';
const LAST_RESULT_KEY = 'backup.last_result';
const PREFIX = { keys: 'bitlocker-keys', database: 'bitlocker-db' };
const FILE_RE = /^bitlocker-(keys|db)-(\d{8}-\d{6})\.zip$/;

const optionsInput = z.object({
  enabled: checkbox,
  time: z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'invalid_time'),
  keys: checkbox,
  database: checkbox,
  keep: z.coerce.number().int().min(1).max(365),
  encrypt: checkbox,
});
const passwordInput = z.object({ password: z.string().max(256), confirm: z.string().max(256) });

const iso = (d) => (d ? new Date(d).toISOString() : '');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const SYSTEM = { userSid: 'system', userUpn: 'system' };

/**
 * Scheduled and on-demand backups, written as AES-256 encrypted ZIP files (7-Zip / WinRAR open them):
 *  - keys:     every computer and every recovery key (with the recovery password), as CSV, so keys can
 *              be found even when the app or the database is down;
 *  - database: a pg_dump (custom format) of the whole database, for a full restore.
 * The password is set by Admin HQ, stored encrypted, never shown again and never written in the file.
 * No password = no backup (the files hold every recovery key).
 */
export class BackupService {
  constructor({ pool, settings, audit, alerts = null, config, secretKey, tz = 'Asia/Ho_Chi_Minh', logger = null, now = () => new Date(), runPgDump = null }) {
    this.pool = pool;
    this.settings = settings;
    this.audit = audit;
    this.alerts = alerts;
    this.config = config;
    this.secretKey = secretKey;
    this.tz = tz;
    this.log = logger ? logger.child({ component: 'backup' }) : null;
    this.now = now;
    this.runPgDump = runPgDump ?? ((url) => pgDump(config.PG_DUMP_PATH, url));
  }

  #check(scope) {
    if (!can(scope, 'admin')) throw forbidden();
  }

  get dir() {
    return path.resolve(this.config.BACKUP_DIR);
  }

  get databaseConfigured() {
    return !!this.config.BACKUP_DATABASE_URL;
  }

  async options() {
    return { ...BACKUP_DEFAULTS, ...(await this.settings.get('backup.options', {})) };
  }

  async #password() {
    const { rows } = await this.pool.query('SELECT value FROM app_setting WHERE key = $1', [PASSWORD_KEY]);
    return rows[0]?.value ? decryptSecret(this.secretKey, rows[0].value) : null;
  }

  async #getRaw(key) {
    const { rows } = await this.pool.query('SELECT value FROM app_setting WHERE key = $1', [key]);
    return rows[0]?.value ?? null;
  }

  async #setRaw(key, value) {
    await this.pool.query(
      `INSERT INTO app_setting (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(value)],
    );
  }

  localNow() {
    const s = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).format(this.now()); // "2026-10-16, 01:30:05"
    const [day, time] = s.split(', ');
    return { day, time: time.slice(0, 5), stamp: `${day.replace(/-/g, '')}-${time.replace(/:/g, '')}` };
  }

  // ---- Quan tri > Sao luu ------------------------------------------------------------------

  async status(scope) {
    this.#check(scope);
    return {
      options: await this.options(),
      passwordSet: !!(await this.#getRaw(PASSWORD_KEY)),
      databaseConfigured: this.databaseConfigured,
      dir: this.dir,
      lastResult: await this.#getRaw(LAST_RESULT_KEY),
      files: await this.listFiles(),
    };
  }

  async saveOptions(scope, raw, client = {}) {
    this.#check(scope);
    const o = parse(optionsInput, raw);
    if (o.enabled && !o.keys && !o.database) throw badRequest('backup_nothing_selected', 'Choose at least one kind of backup.');
    if (o.enabled && o.encrypt && !(await this.#getRaw(PASSWORD_KEY))) throw badRequest('backup_password_missing', 'Set the backup password first (or turn encryption off).');
    const before = await this.options();
    await this.settings.set('backup.options', o);
    // Turned on (or time changed) after today's time: the first scheduled backup runs tomorrow.
    if (o.enabled && (!before.enabled || before.time !== o.time) && this.localNow().time >= o.time) {
      await this.#setRaw(LAST_DAY_KEY, this.localNow().day);
    }
    await this.audit.log({ ...this.audit.actor(scope, client), action: 'admin_change', detail: { op: 'backup_options', ...o } });
  }

  /** Sets (or replaces) the encryption password. Older files keep the password they were made with. */
  async setPassword(scope, raw, client = {}) {
    this.#check(scope);
    const { password, confirm } = parse(passwordInput, raw);
    if ([...password].length < BACKUP_PASSWORD_MIN) {
      throw badRequest('backup_password_short', `The backup password must be at least ${BACKUP_PASSWORD_MIN} characters long.`, { min: BACKUP_PASSWORD_MIN });
    }
    if (password !== confirm) throw badRequest('mismatch', 'The two passwords do not match.');
    await this.#setRaw(PASSWORD_KEY, encryptSecret(this.secretKey, password));
    this.settings.invalidate();
    await this.audit.log({ ...this.audit.actor(scope, client), action: 'admin_change', detail: { op: 'backup_password', changed: true } });
  }

  /** Backup files on disk, newest first: [{ name, kind, size, at }]. */
  async listFiles() {
    let names;
    try {
      names = await fs.readdir(this.dir);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const out = [];
    for (const name of names) {
      const m = FILE_RE.exec(name);
      if (!m) continue;
      const file = path.join(this.dir, name);
      const st = await fs.stat(file);
      out.push({ name, kind: m[1] === 'db' ? 'database' : 'keys', size: st.size, at: st.mtime, encrypted: await fileIsEncrypted(file) });
    }
    return out.sort((a, b) => b.name.localeCompare(a.name));
  }

  /** Path of one backup file for download (Admin HQ only, logged). */
  async fileForDownload(scope, name, client = {}) {
    this.#check(scope);
    if (!FILE_RE.test(String(name))) throw notFound('Backup file not found.');
    const file = path.join(this.dir, name);
    try {
      await fs.access(file);
    } catch {
      throw notFound('Backup file not found.');
    }
    await this.audit.log({ ...this.audit.actor(scope, client), action: 'backup_download', detail: { file: name } });
    return file;
  }

  // ---- running ------------------------------------------------------------------------------

  /** Called every minute (job backup): runs the scheduled backup once a day after the set time. */
  async tick() {
    const o = await this.options();
    if (!o.enabled) return { skipped: 'disabled' };
    const { day, time } = this.localNow();
    if (time < o.time) return { skipped: 'not_yet' };
    if ((await this.#getRaw(LAST_DAY_KEY)) === day) return { skipped: 'done' };
    await this.#setRaw(LAST_DAY_KEY, day); // first, so a failure is not retried every minute
    return this.run({ trigger: 'schedule' });
  }

  /** "Sao luu ngay" (Admin HQ). */
  async runNow(scope, client = {}) {
    this.#check(scope);
    return this.run({ trigger: 'manual', actor: { ...this.audit.actor(scope, client) } });
  }

  /**
   * Makes the backups chosen in the options. Returns { ok, files: [{ kind, name, size }], errors: [{ kind, error }] }.
   * Every run is logged (backup_run); a failure raises the backup_failed alert, a full success clears it.
   */
  async run({ trigger = 'manual', actor = SYSTEM } = {}) {
    const o = await this.options();
    const password = o.encrypt ? await this.#password() : null;
    const startedAt = this.now();
    const files = [];
    const errors = [];
    const kinds = [o.keys && 'keys', o.database && 'database'].filter(Boolean);
    if (o.encrypt && !password) {
      errors.push({ kind: 'all', error: 'No backup password set (Quan tri > Sao luu), and encryption is on.' });
    } else if (!kinds.length) {
      errors.push({ kind: 'all', error: 'No kind of backup selected.' });
    } else {
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      const stamp = this.localNow().stamp;
      for (const kind of kinds) {
        try {
          if (kind === 'database' && !this.databaseConfigured) throw new Error('BACKUP_DATABASE_URL is not set: no database backup.');
          const { archive, counts } = kind === 'keys' ? await this.buildKeysArchive(password, trigger) : await this.buildDatabaseArchive(password, trigger);
          const name = `${PREFIX[kind]}-${stamp}.zip`;
          await writeAtomic(path.join(this.dir, name), archive);
          files.push({ kind, name, size: archive.length, sha256: sha256(archive), ...counts });
        } catch (err) {
          errors.push({ kind, error: String(err.message ?? err).slice(0, 500) });
        }
      }
      await this.#purge(o.keep);
    }
    const result = { ok: errors.length === 0, encrypted: o.encrypt, trigger, at: startedAt.toISOString(), ms: Date.now() - startedAt.getTime(), files, errors };
    await this.#setRaw(LAST_RESULT_KEY, result);
    await this.audit.log({ ...actor, action: 'backup_run', detail: { trigger, ok: result.ok, encrypted: o.encrypt, files: files.map(({ kind, name, size, sha256: h, computers, keys }) => ({ kind, name, size, sha256: h, computers, keys })), errors } });
    if (result.ok) {
      this.log?.info({ trigger, files: files.map((f) => f.name) }, 'backup done');
      await this.alerts?.clear('backup_failed', { files: files.map((f) => f.name).join(', ') });
    } else {
      this.log?.error({ trigger, errors }, 'backup failed');
      await this.alerts?.raise('backup_failed', 'high', { errors: errors.map((e) => `- ${e.kind}: ${e.error}`).join('\n'), trigger });
    }
    return result;
  }

  /** Every computer and recovery key (with the password) as CSV files in an AES-256 zip. */
  async buildKeysArchive(password, trigger = 'manual') { // password null: plain ZIP
    const data = await withAllBranches(this.pool, async (tx) => ({
      computers: (await tx.query(
        `SELECT c.id, c.object_guid, c.name, c.dns_name, c.distinguished_name, b.code AS branch_code, b.name AS branch_name,
                c.os, c.device_serial, c.owner_email, c.ad_created_at, c.when_changed, c.first_seen_at, c.deleted_in_ad_at,
                (SELECT count(*)::int FROM recovery_key k WHERE k.computer_id = c.id) AS keys
           FROM computer c LEFT JOIN branch b ON b.id = c.branch_id
          ORDER BY b.code NULLS FIRST, lower(c.name), c.id`,
      )).rows,
      keys: (await tx.query(
        `SELECT k.key_id, k.key_id_prefix, k.recovery_password, k.volume_guid, k.status, k.ad_created_at, k.first_synced_at,
                k.last_revealed_at, k.ad_dn, c.id AS computer_id, c.object_guid AS computer_guid, c.name AS computer_name,
                c.distinguished_name AS computer_dn, b.code AS branch_code, c.deleted_in_ad_at
           FROM recovery_key k JOIN computer c ON c.id = k.computer_id LEFT JOIN branch b ON b.id = c.branch_id
          ORDER BY b.code NULLS FIRST, lower(c.name), k.ad_created_at`,
      )).rows,
      history: (await tx.query(
        `SELECT m.key_id, m.at, m.reason, f.object_guid AS from_guid, f.name AS from_name, t.object_guid AS to_guid, t.name AS to_name
           FROM key_owner_change m JOIN computer f ON f.id = m.from_computer_id JOIN computer t ON t.id = m.to_computer_id
          ORDER BY m.at`,
      )).rows,
    }));
    const bom = '﻿';
    const computersCsv = bom + toCsv(
      ['computer_id', 'object_guid', 'name', 'dns_name', 'distinguished_name', 'branch', 'branch_name', 'os', 'device_serial', 'owner_email',
        'created_in_ad_utc', 'changed_in_ad_utc', 'first_seen_utc', 'in_ad', 'not_in_ad_since_utc', 'keys'],
      data.computers.map((c) => [c.id, c.object_guid, c.name, c.dns_name, c.distinguished_name, c.branch_code ?? 'N/A', c.branch_name, c.os,
        c.device_serial, c.owner_email, iso(c.ad_created_at), iso(c.when_changed), iso(c.first_seen_at), c.deleted_in_ad_at ? 'no' : 'yes',
        iso(c.deleted_in_ad_at), c.keys]),
    );
    const keysCsv = bom + toCsv(
      ['key_id', 'key_id_first8', 'recovery_password', 'key_dn', 'volume_guid', 'status', 'created_in_ad_utc', 'first_synced_utc', 'last_revealed_utc',
        'computer_id', 'computer_object_guid', 'computer_name', 'computer_dn', 'branch', 'computer_in_ad'],
      data.keys.map((k) => [k.key_id, k.key_id_prefix, k.recovery_password, k.ad_dn, k.volume_guid, k.status, iso(k.ad_created_at),
        iso(k.first_synced_at), iso(k.last_revealed_at), k.computer_id, k.computer_guid, k.computer_name, k.computer_dn, k.branch_code ?? 'N/A',
        k.deleted_in_ad_at ? 'no' : 'yes']),
    );
    const historyCsv = bom + toCsv(
      ['key_id', 'moved_utc', 'reason', 'from_computer_guid', 'from_computer_name', 'to_computer_guid', 'to_computer_name'],
      data.history.map((h) => [h.key_id, iso(h.at), h.reason, h.from_guid, h.from_name, h.to_guid, h.to_name]),
    );
    const counts = { computers: data.computers.length, keys: data.keys.length };
    const content = [
      { name: 'computers.csv', data: computersCsv },
      { name: 'recovery_keys.csv', data: keysCsv },
      { name: 'key_moves.csv', data: historyCsv },
    ];
    return { archive: this.#archive('bitlocker-keys-backup/1', content, counts, trigger, KEYS_README, password), counts };
  }

  /** pg_dump (custom format) of the whole database in an AES-256 zip. */
  async buildDatabaseArchive(password, trigger = 'manual') {
    const dump = await this.runPgDump(this.config.BACKUP_DATABASE_URL);
    const content = [{ name: 'bitlocker.dump', data: dump, compress: false }]; // pg_dump -Fc is compressed already
    return { archive: this.#archive('bitlocker-db-backup/1', content, { dumpBytes: dump.length }, trigger, DB_README, password), counts: { dumpBytes: dump.length } };
  }

  #archive(format, content, counts, trigger, readme, password) {
    const manifest = {
      format,
      encrypted: !!password,
      createdAt: this.now().toISOString(),
      timeZone: this.tz,
      trigger,
      ...counts,
      files: content.map((f) => {
        const buf = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
        return { name: f.name, bytes: buf.length, sha256: sha256(buf) };
      }),
    };
    return zipAes([
      { name: 'README.txt', data: readme },
      { name: 'manifest.json', data: `${JSON.stringify(manifest, null, 2)}\n` },
      ...content,
    ], password, { date: this.now() });
  }

  /** Keeps the newest `keep` files of each kind. */
  async #purge(keep) {
    const files = await this.listFiles();
    for (const kind of ['keys', 'database']) {
      for (const f of files.filter((x) => x.kind === kind).slice(keep)) {
        await fs.rm(path.join(this.dir, f.name), { force: true });
        this.log?.info({ file: f.name }, 'old backup removed');
      }
    }
  }
}

/** Reads the first bytes of a backup file: AES-256 encrypted or a plain ZIP. */
async function fileIsEncrypted(file) {
  const fh = await fs.open(file, 'r');
  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(16), 0, 16, 0);
    return isEncryptedZip(buffer.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

/** Writes through a temporary name, then renames: a half-written file never has the final name. */
async function writeAtomic(file, buf) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp`);
  await fs.writeFile(tmp, buf, { mode: 0o600 });
  await fs.rename(tmp, file);
}

/**
 * Runs pg_dump --format=custom for the database URL and returns its output. The password goes to
 * pg_dump through PGPASSWORD (not the command line), errors carry pg_dump's message only.
 */
export function pgDump(bin, url, { timeoutMs = 30 * 60_000 } = {}) {
  const u = new URL(url);
  const env = {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, '')),
  };
  const sslmode = u.searchParams.get('sslmode');
  if (sslmode) env.PGSSLMODE = sslmode;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['--format=custom', '--no-password', '--lock-wait-timeout=60000'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(e.code === 'ENOENT' ? `pg_dump not found (${bin}). Install the PostgreSQL 17 client or set PG_DUMP_PATH.` : e.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`pg_dump exited with code ${code}: ${err.trim().split('\n').slice(-3).join(' ')}`));
    });
  });
}

const KEYS_README = `SAO LƯU MÁY VÀ RECOVERY KEY BITLOCKER
=====================================

File này chứa TOÀN BỘ recovery key. Giữ kín như mật khẩu quản trị; không gửi qua email, không để
trên máy cá nhân. File mã hóa (AES-256): giải nén bằng 7-Zip hoặc WinRAR với mật khẩu sao lưu do Admin HQ
đặt. File không mã hóa: phải cất ở nơi đã mã hóa và giới hạn người đọc.

computers.csv       Mỗi máy (kể cả máy đã rời AD): id trong hệ thống, objectGUID (định danh trên AD),
                    tên, DNS, DN, chi nhánh, hệ điều hành, serial, email người dùng, thời điểm tạo /
                    sửa trên AD, lần đầu ghi nhận, còn trong AD hay không, số key.
recovery_keys.csv   Mỗi recovery key: Key ID (8 ký tự đầu hiện trên màn hình BitLocker), MẬT KHẨU KHÔI
                    PHỤC, DN của key trên AD, volume GUID, trạng thái, thời điểm tạo trên AD, ghi nhận, hiện key gần nhất,
                    máy chứa key (id, objectGUID, tên, DN, chi nhánh).
key_moves.csv       Key chuyển sang máy mới khi máy unjoin rồi join lại AD.
manifest.json       Thời điểm tạo, số máy, số key, SHA-256 của từng file để kiểm tra toàn vẹn.

Mọi thời điểm theo giờ UTC (cột ..._utc). Mở bằng Excel: Data > From Text/CSV, chọn UTF-8.
Tìm key: lọc cột key_id_first8 theo 8 ký tự người dùng đọc trên màn hình recovery.
`;

const DB_README = `SAO LƯU DATABASE (PostgreSQL)
=============================

File này chứa toàn bộ database, kể cả mọi recovery key. Giữ kín; file mã hóa giải nén bằng 7-Zip (AES-256).

bitlocker.dump   Bản pg_dump định dạng custom (PostgreSQL 17). Khôi phục bằng pg_restore,
                 xem README của hệ thống, mục "Sao lưu và khôi phục".
manifest.json    Thời điểm tạo, kích thước và SHA-256 của bitlocker.dump.

Lưu ý: một số giá trị trong DB (mật khẩu SMTP, khóa xác thực 2 bước, mật khẩu sao lưu) được mã hóa
bằng khóa suy ra từ LOG_HMAC_KEY; nhật ký truy cập được ký bằng LOG_HMAC_KEY. Phải sao lưu
LOG_HMAC_KEY (file .env) riêng, ở kho secret, để dùng được đầy đủ bản khôi phục.
`;
