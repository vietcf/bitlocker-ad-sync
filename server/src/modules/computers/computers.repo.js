import { branchFilter } from '../../db/scoped.js';

// Every query takes the caller's branch set and filters on it (first layer);
// the transaction's RLS scope is the second layer.

const COMPUTER_COLUMNS = `
  c.id, c.object_guid, c.name, c.dns_name, c.distinguished_name, c.os, c.branch_id, b.code AS branch_code, b.name AS branch_name,
  c.ad_created_at, c.first_seen_at, c.when_changed, c.deleted_in_ad_at,
  c.device_serial, c.owner_email, c.info_updated_at, c.info_updated_by`;

// Search form of a text: lower case, without the separators - _ . and spaces, so "lt0231",
// "LT-0231" and "lt 0231" all find "HN-LT-0231". Same expression as the indexes of migration 022.
const searchKey = (col) => `regexp_replace(lower(${col}), '[-_.[:space:]]', '', 'g')`;

/** The search form of what the user typed (see searchKey). */
export const normalizeSearchText = (q) => q.toLowerCase().replace(/[-_.\s]/g, '');

/** Shortest text searched anywhere in a value ("contains"); shorter texts match the start only. */
export const CONTAINS_MIN = 3;

/**
 * By computer name, machine serial or user e-mail, ignoring case and separators: anywhere in the
 * value from CONTAINS_MIN characters, else at the start. Best matches first: exact, then starting
 * with the text, then containing it. Each row says what matched (matched_on: name | serial | email).
 */
export async function searchByText(tx, branches, q, { limit, offset }) {
  const params = [];
  const scope = branchFilter('c.branch_id', branches, params);
  const text = normalizeSearchText(q);
  if (!text) return { rows: [], total: 0 };
  const esc = text.replace(/[\\%_]/g, '\\$&');
  params.push(text, `${esc}%`, text.length >= CONTAINS_MIN ? `%${esc}%` : `${esc}%`, limit, offset);
  const [exact, starts, pattern] = [params.length - 4, params.length - 3, params.length - 2].map((i) => `$${i}`);
  const cols = [searchKey('c.name'), searchKey('c.device_serial'), searchKey('c.owner_email')];
  const any = (op, p) => `(${cols.map((col) => `${col} ${op} ${p}`).join(' OR ')})`;
  const { rows } = await tx.query(
    `SELECT ${COMPUTER_COLUMNS},
            (SELECT count(*)::int FROM recovery_key k WHERE k.computer_id = c.id) AS key_count,
            CASE WHEN ${cols[0]} LIKE ${pattern} THEN 'name' WHEN ${cols[1]} LIKE ${pattern} THEN 'serial' ELSE 'email' END AS matched_on,
            count(*) OVER () AS total
       FROM computer c LEFT JOIN branch b ON b.id = c.branch_id
      WHERE ${scope} AND ${any('LIKE', pattern)}
      ORDER BY c.deleted_in_ad_at NULLS FIRST,
               CASE WHEN ${any('=', exact)} THEN 0 WHEN ${any('LIKE', starts)} THEN 1 ELSE 2 END,
               lower(c.name)
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { rows, total: Number(rows[0]?.total ?? 0) };
}

/** By the computer's objectGUID (its id in AD, unique and never reused). */
export async function searchByObjectGuid(tx, branches, guid) {
  const params = [];
  const scope = branchFilter('c.branch_id', branches, params);
  params.push(guid.toLowerCase());
  const { rows } = await tx.query(
    `SELECT ${COMPUTER_COLUMNS},
            (SELECT count(*)::int FROM recovery_key k WHERE k.computer_id = c.id) AS key_count
       FROM computer c LEFT JOIN branch b ON b.id = c.branch_id
      WHERE ${scope} AND c.object_guid = $${params.length}::uuid`,
    params,
  );
  return rows;
}

/**
 * By Key ID: its first characters (from 4, as read on the BitLocker recovery screen, which shows the
 * first 8), or the full GUID.
 */
export async function searchByKeyId(tx, branches, keyIdOrPrefix) {
  const params = [];
  const scope = branchFilter('c.branch_id', branches, params);
  const full = keyIdOrPrefix.length === 36;
  params.push(full ? keyIdOrPrefix.toLowerCase() : `${keyIdOrPrefix.toLowerCase()}%`);
  const match = full ? `k.key_id = $${params.length}::uuid` : `k.key_id::text LIKE $${params.length}`;
  const { rows } = await tx.query(
    `SELECT ${COMPUTER_COLUMNS}, k.key_id, k.status AS key_status, k.ad_created_at AS key_created_at, k.first_synced_at AS key_first_synced_at
       FROM recovery_key k
       JOIN computer c ON c.id = k.computer_id
       LEFT JOIN branch b ON b.id = c.branch_id
      WHERE ${scope} AND ${match}
      ORDER BY k.ad_created_at DESC
      LIMIT 50`,
    params,
  );
  return rows;
}

export async function getComputer(tx, branches, id) {
  const params = [id];
  const scope = branchFilter('c.branch_id', branches, params);
  const { rows } = await tx.query(
    `SELECT ${COMPUTER_COLUMNS}
       FROM computer c LEFT JOIN branch b ON b.id = c.branch_id
      WHERE c.id = $1 AND ${scope}`,
    params,
  );
  return rows[0] ?? null;
}

/** Sets the hand-entered fields of a computer (null clears one). Sync never writes them. */
export async function updateComputerInfo(tx, id, { deviceSerial, ownerEmail }, by) {
  await tx.query(
    `UPDATE computer
        SET device_serial = $2, owner_email = $3, info_updated_at = now(), info_updated_by = $4
      WHERE id = $1`,
    [id, deviceSerial, ownerEmail, by],
  );
}

/** Key metadata for one computer. Never selects recovery_password. */
export async function listKeyMetadata(tx, computerId) {
  const { rows } = await tx.query(
    `SELECT key_id, key_id_prefix, volume_guid, ad_created_at, first_synced_at, status, last_revealed_at
       FROM recovery_key WHERE computer_id = $1
      ORDER BY volume_guid NULLS LAST, ad_created_at DESC`,
    [computerId],
  );
  return rows;
}

/**
 * WHERE conditions on computer `c` for the list filters (shared by the list, its CSV export and
 * the key export). filters: { branchId (id or 'na' = no branch), status: 'all' | 'no_key', includeDeleted,
 * dateField: 'seen' (first recorded here) | 'ad' (created in AD), from, to: 'YYYY-MM-DD' inclusive, in APP_TZ }
 */
export function computerFilters(branches, filters, params) {
  const where = [branchFilter('c.branch_id', branches, params)];
  if (filters.branchId === 'na') {
    where.push('c.branch_id IS NULL');
  } else if (filters.branchId) {
    params.push(filters.branchId);
    where.push(`c.branch_id = $${params.length}`);
  }
  if (!filters.includeDeleted) where.push('c.deleted_in_ad_at IS NULL');
  if (filters.status === 'no_key') {
    where.push('NOT EXISTS (SELECT 1 FROM recovery_key k WHERE k.computer_id = c.id)');
  }
  if (filters.from || filters.to) {
    const column = filters.dateField === 'ad' ? 'c.ad_created_at' : 'c.first_seen_at';
    params.push(process.env.APP_TZ ?? 'Asia/Ho_Chi_Minh');
    const tz = `$${params.length}`;
    if (filters.from) {
      params.push(filters.from);
      where.push(`(${column} AT TIME ZONE ${tz})::date >= $${params.length}::date`);
    }
    if (filters.to) {
      params.push(filters.to);
      where.push(`(${column} AT TIME ZONE ${tz})::date <= $${params.length}::date`);
    }
  }
  return where.join(' AND ');
}

/** All computers in scope, for browsing without a search term (filters: see computerFilters). */
export async function listComputers(tx, branches, filters, { limit, offset }) {
  const params = [];
  const where = [computerFilters(branches, filters, params)];
  params.push(limit, offset);
  const { rows } = await tx.query(
    `SELECT ${COMPUTER_COLUMNS},
            (SELECT count(*)::int FROM recovery_key k WHERE k.computer_id = c.id) AS key_count,
            (SELECT max(k.ad_created_at) FROM recovery_key k WHERE k.computer_id = c.id) AS latest_key_at,
            count(*) OVER () AS total
       FROM computer c LEFT JOIN branch b ON b.id = c.branch_id
      WHERE ${where.join(' AND ')}
      ORDER BY c.deleted_in_ad_at NULLS FIRST, lower(c.name)
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { rows, total: Number(rows[0]?.total ?? 0) };
}

/** Branches the caller can browse (for the filter list). */
export async function branchOptions(tx, branches) {
  const params = [];
  const scope = branchFilter('b.id', branches, params);
  const { rows } = await tx.query(`SELECT b.id, b.code, b.name FROM branch b WHERE ${scope} AND b.is_active ORDER BY b.code`, params);
  return rows;
}
