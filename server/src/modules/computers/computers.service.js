import { withScope } from '../../db/scoped.js';
import { branchesFor } from '../../domain/scope.js';
import { featureDisabled, forbidden, notFound } from '../../http/errors.js';
import { toCsv } from '../../http/csv.js';
import { z } from 'zod';
import { parse } from '../../http/validate.js';
import {
  branchOptions,
  getComputer,
  countWithoutLogon,
  listComputers,
  listKeyMetadata,
  searchByKeyId,
  searchByObjectGuid,
  searchByText,
  updateComputerInfo,
} from './computers.repo.js';
import { keyHistoryOf } from '../sync/sync.repo.js';

import { PAGE_SIZES, pageSize } from '../settings/page-size.js';

/** Empty form field -> null (clears the value). */
const optional = (schema) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), schema.nullish().transform((x) => x ?? null));

/** What IT may type about a computer: machine serial and user e-mail (both optional). */
const computerInfoInput = z.object({
  deviceSerial: optional(z.string().trim().max(64)),
  ownerEmail: optional(z.string().trim().toLowerCase().max(254).pipe(z.email({ message: 'invalid_email' }))),
});
const CSV_MAX_ROWS = 100_000;

// What the single search box takes as a Key ID: its first characters (from 4 hex; the BitLocker
// recovery screen shows the first 8) or a full GUID. Such a text is also searched as a name.
const KEY_PREFIX = /^[0-9a-f]{4}[0-9a-f-]{0,31}$/i;
const KEY_FULL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Normalises what IT types: braces, spaces and a trailing dash are dropped. */
export function normalizeQuery(q) {
  return q.trim().replace(/[{}\s]/g, '').replace(/-$/, '');
}

export function looksLikeKeyId(q) {
  return (KEY_PREFIX.test(q) || KEY_FULL.test(q)) && q.replace(/-/g, '').length <= 32;
}

/**
 * Key ID form of what IT typed: the hex digits with the dashes where a GUID has them (8-4-4-4-12),
 * so the dashes are optional ("1a2b3c4d5e6f" -> "1a2b3c4d-5e6f").
 */
export function keyIdForm(q) {
  const hex = q.replace(/-/g, '').toLowerCase();
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].filter(Boolean).join('-');
}

/** Finding computers and reading key metadata (never key values). */
export class ComputersService {
  constructor({ pool, audit, settings = null }) {
    this.pool = pool;
    this.audit = audit;
    this.settings = settings;
  }

  #branches(scope) {
    const branches = branchesFor(scope, 'keys');
    if (branches !== 'all' && branches.length === 0) throw forbidden();
    return branches;
  }

  /**
   * One search box: a Key ID (8 chars or full GUID), or the start of a computer name, machine
   * serial or user e-mail. Something that looks like a Key ID but matches no key is searched as
   * text too (a serial can look like 8 hex characters).
   * Returns { kind: 'key' | 'name', rows, total, page, pages }.
   */
  async search(scope, rawQuery, pageNo = 1, client = {}) {
    const branches = this.#branches(scope);
    const q = normalizeQuery(rawQuery);
    if (q.length < 2) return { kind: 'name', query: q, rows: [], total: 0, page: 1, pages: 1 };

    const PAGE_SIZE = await pageSize(this.settings, PAGE_SIZES.computers);
    return withScope(this.pool, branches, async (tx) => {
      // Search terms are logged (they are not secrets); only on the first page.
      if (pageNo === 1) await this.audit.append(tx, { ...this.audit.actor(scope, client), action: 'search', detail: { q } });
      const byText = async () => {
        const r = await searchByText(tx, branches, q, { limit: PAGE_SIZE, offset: (pageNo - 1) * PAGE_SIZE });
        return { ...r, page: pageNo, pageSize: PAGE_SIZE, pages: Math.max(1, Math.ceil(r.total / PAGE_SIZE)) };
      };
      if (!looksLikeKeyId(q)) return { kind: 'name', query: q, ...(await byText()) };

      const keyId = keyIdForm(q);
      const keys = await searchByKeyId(tx, branches, keyId);
      if (KEY_FULL.test(keyId)) {
        if (keys.length) return { kind: 'key', query: q, rows: keys, total: keys.length, page: 1, pages: 1 };
        // A full GUID that is no Key ID: maybe a computer's objectGUID.
        const computers = await searchByObjectGuid(tx, branches, keyId);
        if (computers.length) return { kind: 'name', query: q, rows: computers, total: computers.length, page: 1, pageSize: PAGE_SIZE, pages: 1 };
        return { kind: 'key', query: q, rows: [], total: 0, page: 1, pages: 1 };
      }
      // A few hex characters may start a Key ID and also be part of a name ("0231" in HN-LT-0231):
      // keys first, and the computers that match as text alongside (`computers`).
      const text = await byText();
      if (!keys.length) return { kind: 'name', query: q, ...text };
      return { kind: 'key', query: q, rows: keys, total: keys.length, page: 1, pages: 1, computers: text };
    });
  }

  /**
   * Browse every computer in the caller's scope (no search term, so nothing is logged).
   * filters: { branchId (id or 'na'), status: 'all' | 'no_key' | 'has_key', includeDeleted }
   * Returns { rows, total, page, pages, branches, seesUnmapped } for the filter list
   * (only an all-branch scope sees computers in no branch).
   */
  async list(scope, filters = {}, pageNo = 1) {
    const branches = this.#branches(scope);
    const PAGE_SIZE = await pageSize(this.settings, PAGE_SIZES.computers);
    return withScope(this.pool, branches, async (tx) => {
      const r = await listComputers(tx, branches, filters, { limit: PAGE_SIZE, offset: (pageNo - 1) * PAGE_SIZE });
      const noLogonCount = await countWithoutLogon(tx, branches, filters);
      return { ...r, noLogonCount, page: pageNo, pageSize: PAGE_SIZE, pages: Math.max(1, Math.ceil(r.total / PAGE_SIZE)), branches: await branchOptions(tx, branches), seesUnmapped: branches === 'all' };
    });
  }

  /**
   * CSV of the computer list with the same filters as list() (never a key value).
   * The export itself is logged.
   */
  async exportCsv(scope, filters = {}, client = {}) {
    const branches = this.#branches(scope);
    if (this.settings && !(await this.settings.feature('feature.computer_export'))) throw featureDisabled();
    const { rows } = await withScope(this.pool, branches, async (tx) => {
      const r = await listComputers(tx, branches, filters, { limit: CSV_MAX_ROWS, offset: 0 });
      await this.audit.append(tx, { ...this.audit.actor(scope, client), action: 'export_computers', detail: { filters, rows: r.rows.length } });
      return r;
    });
    return toCsv(
      ['name', 'object_guid', 'dns_name', 'branch', 'distinguished_name', 'os', 'device_serial', 'owner_email',
        'keys', 'latest_key_utc', 'ad_created_utc', 'first_seen_utc', 'last_logon_utc', 'in_scope', 'out_of_scope_since_utc'],
      rows.map((c) => [
        c.name, c.object_guid, c.dns_name, c.branch_code ?? 'N/A', c.distinguished_name, c.os, c.device_serial, c.owner_email,
        c.key_count, c.latest_key_at, c.ad_created_at, c.first_seen_at, c.last_logon_at, c.deleted_in_ad_at ? 'no' : 'yes', c.deleted_in_ad_at,
      ]),
    );
  }

  /** The computer for the edit form (not logged as a view). Out of scope => 404. */
  async getInfo(scope, computerId) {
    const branches = this.#branches(scope);
    const computer = await withScope(this.pool, branches, (tx) => getComputer(tx, branches, computerId));
    if (!computer) throw notFound('Computer not found.');
    return computer;
  }

  /**
   * Saves the machine serial and user e-mail of a computer. Anyone who may see the
   * computer's keys may edit them. Logged with the values before and after.
   */
  async updateInfo(scope, computerId, raw, client = {}) {
    const branches = this.#branches(scope);
    const input = parse(computerInfoInput, raw);
    return withScope(this.pool, branches, async (tx) => {
      const c = await getComputer(tx, branches, computerId);
      if (!c) throw notFound('Computer not found.');
      await updateComputerInfo(tx, c.id, input, scope.upn);
      await this.audit.append(tx, {
        ...this.audit.actor(scope, client),
        action: 'computer_edit',
        computerId: String(c.id),
        branchId: c.branch_id,
        detail: {
          before: { deviceSerial: c.device_serial, ownerEmail: c.owner_email },
          after: input,
        },
      });
      return { computerId: Number(c.id), ...input };
    });
  }

  /** Computer details + key metadata. Out of scope => 404, same as missing. */
  async get(scope, computerId, client = {}) {
    const branches = this.#branches(scope);
    return withScope(this.pool, branches, async (tx) => {
      const computer = await getComputer(tx, branches, computerId);
      if (!computer) throw notFound('Computer not found.');
      const keys = await listKeyMetadata(tx, computerId);
      // Keys moved to / from this computer (unjoin + rejoin) and Key IDs shared with another computer.
      const keyHistory = await keyHistoryOf(tx, computerId);
      await this.audit.append(tx, {
        ...this.audit.actor(scope, client),
        action: 'view_computer',
        computerId: String(computer.id),
        branchId: computer.branch_id,
      });
      return { computer, keys, keyHistory };
    });
  }
}
