import { createHmac, timingSafeEqual } from 'node:crypto';

export const GENESIS_HASH = Buffer.alloc(32);

// Actions written to access_log:
// login, login_failed, password_change, search, view_computer, reveal, export_log, export_computers, export_keys, export_report, log_purge, computer_edit,
// admin_change, computer_moved, sync_manual, sync_ack, key_duplicate_review,
// backup_run, backup_download
//
// A log entry (never carries a recovery password):
// { at: Date, userSid, userUpn, action, computerId (string|null), keyId, branchId,
//   reason, reasonNote, ticketNo, clientIp, userAgent, detail }

/** JSON with object keys sorted, so the same value always serialises the same way. */
export function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Fixed-order serialisation of a row. `id` is left out on purpose: it is assigned by the DB
 * on insert and can skip numbers on rollback; order is protected by prev_hash instead.
 */
export function canonical(e) {
  return stableStringify([
    e.at.toISOString(),
    e.userSid,
    e.userUpn,
    e.action,
    e.computerId,
    e.keyId?.toLowerCase() ?? null,
    e.branchId,
    e.reason,
    e.reasonNote,
    e.ticketNo,
    e.clientIp,
    e.userAgent,
    e.detail ?? null,
  ]);
}

/** hash_n = HMAC-SHA256(K_log, hash_{n-1} || canonical(row_n)) */
export function chainHash(key, prevHash, entry) {
  return createHmac('sha256', key).update(prevHash).update(canonical(entry), 'utf8').digest();
}

/**
 * Verifies stored rows given in id order (each row = entry + { id, prevHash, hash }).
 * `expectedPrev` is the hash the first row must point to (GENESIS_HASH, or a checkpoint).
 * Returns { ok: true, checked, lastHash } or { ok: false, checked, brokenAtId, problem }.
 */
/**
 * Rows of action export_log written before the fix hashed a Date in detail.filters.from / to as {} (the stored
 * JSON has the ISO text). Same row with those two values read as {}: only used when the normal hash does not match.
 */
function legacyExportLog(e) {
  const f = e.detail?.filters;
  if (e.action !== 'export_log' || !f || (typeof f.from !== 'string' && typeof f.to !== 'string')) return null;
  const filters = { ...f };
  if (typeof f.from === 'string') filters.from = {};
  if (typeof f.to === 'string') filters.to = {};
  return { ...e, detail: { ...e.detail, filters } };
}

export function verifyChain(key, rows, expectedPrev = GENESIS_HASH) {
  let prev = expectedPrev;
  let checked = 0;
  for (const r of rows) {
    if (!timingSafeEqual(r.prevHash, prev)) {
      return { ok: false, checked, brokenAtId: r.id, problem: 'prev_hash_mismatch' };
    }
    const legacy = legacyExportLog(r);
    if (!timingSafeEqual(chainHash(key, prev, r), r.hash) && !(legacy && timingSafeEqual(chainHash(key, prev, legacy), r.hash))) {
      return { ok: false, checked, brokenAtId: r.id, problem: 'hash_mismatch' };
    }
    prev = r.hash;
    checked++;
  }
  return { ok: true, checked, lastHash: prev };
}
