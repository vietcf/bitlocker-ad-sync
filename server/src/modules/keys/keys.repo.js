import { branchFilter } from '../../db/scoped.js';
import { computerFilters } from '../computers/computers.repo.js';

/** Key + its computer, locked for the reveal transaction. Never selects the password. */
export async function getKeyForUpdate(tx, branches, keyId) {
  const params = [keyId];
  const scope = branchFilter('c.branch_id', branches, params);
  const { rows } = await tx.query(
    `SELECT k.id, k.key_id, k.status, k.computer_id, c.name AS computer_name, c.branch_id,
            c.distinguished_name, b.code AS branch_code
       FROM recovery_key k
       JOIN computer c ON c.id = k.computer_id
       LEFT JOIN branch b ON b.id = c.branch_id
      WHERE k.key_id = $1::uuid AND ${scope}
        FOR UPDATE OF k`,
    params,
  );
  return rows[0] ?? null;
}

// recovery_password is selected in exactly two places, both here: readRecoveryPassword (one
// reveal) and keysForExport (Admin HQ key export). Both run inside a transaction that logs them.

/** One key's password, for a reveal. */
export async function readRecoveryPassword(tx, keyRowId) {
  const { rows } = await tx.query('SELECT recovery_password FROM recovery_key WHERE id = $1', [keyRowId]);
  return rows[0]?.recovery_password ?? null;
}

/** Number of keys of the computers matching the list filters (for the export form). */
export async function countKeysForExport(tx, branches, filters) {
  const params = [];
  const where = computerFilters(branches, filters, params);
  const { rows } = await tx.query(
    `SELECT count(*)::int AS keys, count(DISTINCT c.id)::int AS computers
       FROM recovery_key k JOIN computer c ON c.id = k.computer_id WHERE ${where}`,
    params,
  );
  return rows[0];
}

/** Keys (with their password) of the computers matching the list filters, for the key export. */
export async function keysForExport(tx, branches, filters, limit) {
  const params = [];
  const where = computerFilters(branches, filters, params);
  params.push(limit);
  const { rows } = await tx.query(
    `SELECT k.id, k.key_id, k.volume_guid, k.status, k.ad_created_at, k.first_synced_at, k.recovery_password,
            c.device_serial, c.owner_email,
            c.id AS computer_id, c.object_guid AS computer_object_guid, c.name AS computer_name, c.distinguished_name, c.branch_id, b.code AS branch_code,
            c.deleted_in_ad_at
       FROM recovery_key k
       JOIN computer c ON c.id = k.computer_id
       LEFT JOIN branch b ON b.id = c.branch_id
      WHERE ${where}
      ORDER BY lower(c.name), k.volume_guid NULLS LAST, k.ad_created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}

/** Marks many keys as revealed now (the key export). */
export async function markManyRevealed(tx, keyRowIds) {
  await tx.query('UPDATE recovery_key SET last_revealed_at = now() WHERE id = ANY($1::bigint[])', [keyRowIds]);
}

/** Remembers when the key was last revealed (who and why is in access_log). Status is unchanged. */
export async function markRevealed(tx, keyRowId) {
  await tx.query('UPDATE recovery_key SET last_revealed_at = now() WHERE id = $1', [keyRowId]);
}
