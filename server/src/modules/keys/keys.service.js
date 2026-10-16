import { z } from 'zod';
import { withScope } from '../../db/scoped.js';
import { branchesFor } from '../../domain/scope.js';
import { isWithinWorkingHours } from '../../domain/time.js';
import { can } from '../../domain/scope.js';
import { badRequest, featureDisabled, forbidden, notFound } from '../../http/errors.js';
import { toCsv } from '../../http/csv.js';
import { parse } from '../../http/validate.js';
import {
  countKeysForExport,
  getKeyForUpdate,
  keysForExport,
  markManyRevealed,
  markRevealed,
  readRecoveryPassword,
} from './keys.repo.js';

export const REVEAL_SECONDS = 60;
const KEY_EXPORT_MAX = 50_000;

/** Who may export keys with their passwords (Quan tri > Tinh nang): off | admin | all (IT, lead, admin). */
export const KEY_EXPORT_MODES = ['off', 'admin', 'all'];

export const REASON_LABELS = {
  user_locked_out: 'Người dùng bị khóa máy (màn hình recovery)',
  hardware_change: 'Thay đổi phần cứng / mainboard',
  bios_update: 'Cập nhật BIOS / firmware',
  disk_recovery: 'Khôi phục dữ liệu ổ cứng',
  other: 'Lý do khác (ghi rõ trong ghi chú)',
};

const revealInput = z.object({
  reason: z.string().trim().min(1).max(64),
  reasonNote: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().max(500).optional()),
  ticketNo: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().max(64).optional()),
});

/** Revealing recovery passwords. */
export class KeysService {
  constructor({ pool, audit, settings, notifier, templates, now = () => new Date() }) {
    this.pool = pool;
    this.audit = audit;
    this.settings = settings;
    this.notifier = notifier;
    this.templates = templates;
    this.now = now;
  }

  #branches(scope) {
    const branches = branchesFor(scope, 'keys');
    if (branches !== 'all' && branches.length === 0) throw forbidden();
    return branches;
  }

  /** The reason options for the reveal form: [{ value, label }]. */
  async reasons() {
    const values = await this.settings.get('reveal.reasons', Object.keys(REASON_LABELS));
    return values.map((v) => ({ value: v, label: REASON_LABELS[v] ?? v }));
  }

  async ticketRequired() {
    return this.settings.feature('reveal.ticket_required');
  }

  /** Checks the reason form shared by a reveal and a key export. */
  async #reasonInput(rawInput) {
    const input = parse(revealInput, rawInput);
    const reasons = await this.settings.get('reveal.reasons', Object.keys(REASON_LABELS));
    if (!reasons.includes(input.reason)) throw badRequest('invalid_reason', 'Choose a valid reason.');
    if (input.reason === 'other' && !input.reasonNote) {
      throw badRequest('invalid_reason', 'The reason "other" needs a note.');
    }
    if ((await this.ticketRequired()) && !input.ticketNo) {
      throw badRequest('ticket_required', 'A ticket number is required.');
    }
    return input;
  }

  /** Whether this user may export keys (setting export.keys and their role). */
  async canExportKeys(scope) {
    const mode = await this.settings.get('export.keys', 'off');
    if (mode === 'all') return can(scope, 'keys');
    if (mode === 'admin') return can(scope, 'admin');
    return false;
  }

  /** For the export form: how many keys / computers the filters cover. */
  async exportPreview(scope, filters) {
    const branches = this.#branches(scope);
    if (!(await this.canExportKeys(scope))) throw featureDisabled();
    return withScope(this.pool, branches, (tx) => countKeysForExport(tx, branches, filters));
  }

  /**
   * CSV of the keys (with recovery passwords) of the computers matching the list filters, in the
   * user's scope. Like a reveal, with a reason; in ONE transaction every exported key gets its own
   * 'reveal' log row (so "who saw this key" stays answerable) plus one 'export_keys' summary row.
   * Admin HQ is alerted after commit. Returns { csv, keys }.
   */
  async exportKeys(scope, filters, rawInput, client = {}) {
    const branches = this.#branches(scope);
    if (!(await this.canExportKeys(scope))) throw featureDisabled();
    const input = await this.#reasonInput(rawInput);
    const actor = this.audit.actor(scope, client);

    const rows = await withScope(this.pool, branches, async (tx) => {
      const keys = await keysForExport(tx, branches, filters, KEY_EXPORT_MAX);
      for (const k of keys) {
        await this.audit.append(tx, {
          ...actor,
          action: 'reveal',
          computerId: String(k.computer_id),
          keyId: k.key_id,
          branchId: k.branch_id,
          reason: input.reason,
          reasonNote: input.reasonNote ?? null,
          ticketNo: input.ticketNo ?? null,
          detail: { export: true },
        });
      }
      await this.audit.append(tx, {
        ...actor,
        action: 'export_keys',
        reason: input.reason,
        reasonNote: input.reasonNote ?? null,
        ticketNo: input.ticketNo ?? null,
        detail: { filters, keys: keys.length, computers: new Set(keys.map((k) => k.computer_id)).size },
      });
      if (keys.length) await markManyRevealed(tx, keys.map((k) => k.id));
      return keys;
    });

    const mail = this.templates.render('key_export', {
      user: scope.upn,
      count: rows.length,
      reason: input.reason,
      reasonLabel: REASON_LABELS[input.reason] ?? input.reason,
      note: input.reasonNote ?? '—',
      ticket: input.ticketNo ?? '—',
    }, { severity: 'high' });
    await this.notifier.send({ type: 'key_export', severity: 'high', subject: mail.subject, text: mail.body });
    const csv = toCsv(
      ['computer', 'computer_object_guid', 'branch', 'distinguished_name', 'in_ad', 'key_id', 'volume_guid', 'device_serial', 'owner_email',
        'status', 'key_created_utc', 'key_recorded_utc', 'recovery_password'],
      rows.map((k) => [
        k.computer_name, k.computer_object_guid, k.branch_code ?? 'N/A', k.distinguished_name, k.deleted_in_ad_at ? 'no' : 'yes',
        k.key_id, k.volume_guid, k.device_serial, k.owner_email, k.status, k.ad_created_at, k.first_synced_at, k.recovery_password,
      ]),
    );
    return { csv, keys: rows.length };
  }

  /**
   * Reveals one recovery password. Order (design doc, "Luong hien key chi tiet"):
   * capability -> input -> scope (404) -> [log, read, note the time] in ONE transaction, so a key
   * is never returned without its log row -> alerts after commit. There is no limit on how many
   * keys a user may reveal; every reveal is logged and unusual ones raise an alert.
   * Returns { keyId, computerId, computerName, recoveryPassword, expiresInSec }.
   */
  async reveal(scope, keyId, rawInput, client = {}) {
    const branches = this.#branches(scope);
    const input = await this.#reasonInput(rawInput);
    const actor = this.audit.actor(scope, client);

    const result = await withScope(this.pool, branches, async (tx) => {
      const key = await getKeyForUpdate(tx, branches, keyId);
      if (!key) throw notFound('Key not found.');
      await this.audit.append(tx, {
        ...actor,
        action: 'reveal',
        computerId: String(key.computer_id),
        keyId: key.key_id,
        branchId: key.branch_id,
        reason: input.reason,
        reasonNote: input.reasonNote ?? null,
        ticketNo: input.ticketNo ?? null,
      });
      const recoveryPassword = await readRecoveryPassword(tx, key.id);
      await markRevealed(tx, key.id);
      return { key, recoveryPassword };
    });

    await this.#alertIfUnusual(scope, result.key);
    return {
      keyId: result.key.key_id,
      computerId: Number(result.key.computer_id),
      computerName: result.key.computer_name,
      recoveryPassword: result.recoveryPassword,
      expiresInSec: REVEAL_SECONDS,
    };
  }

  /** Alerts Admin HQ when a key is revealed outside working hours (Quan tri > Tinh nang). */
  async #alertIfUnusual(scope, key) {
    if (!(await this.settings.feature('feature.reveal_alerts'))) return;
    const hours = await this.settings.get('reveal.working_hours', null);
    if (!hours || isWithinWorkingHours(this.now(), hours)) return;
    const mail = this.templates.render('reveal_out_of_hours',
      { user: scope.upn, computer: key.computer_name, branch: key.branch_code ?? 'N/A' }, { severity: 'high' });
    await this.notifier.send({ type: 'reveal_out_of_hours', severity: 'high', subject: mail.subject, text: mail.body });
  }
}
