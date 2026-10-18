import { branchFilter } from '../../db/scoped.js';
import { GENESIS_HASH, chainHash } from './chain.js';

/**
 * Appends one row to access_log inside the caller's transaction.
 * A transaction-scoped advisory lock serialises writers so two requests can never
 * chain onto the same tail. If the caller rolls back, the row (and its link) disappears with it.
 * Returns the id of the new row.
 */
export async function appendLog(tx, hmacKey, input) {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext('access_log_chain'))`);
  const tail = await tx.query('SELECT hash FROM access_log_tail()');
  const prevHash = tail.rows[0]?.hash ?? GENESIS_HASH;

  // Millisecond precision so the value read back from timestamptz hashes identically.
  const entry = { ...input, at: new Date(Math.floor((input.at ?? new Date()).getTime())) };
  const hash = chainHash(hmacKey, prevHash, entry);

  // No RETURNING: it would also apply the SELECT policy, and a writer may not be allowed
  // to read back its own row (e.g. a sign-in event, which belongs to no branch).
  await tx.query(
    `INSERT INTO access_log
       (at, user_sid, user_upn, action, computer_id, key_id, branch_id, reason, reason_note,
        ticket_no, client_ip, user_agent, detail, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      entry.at,
      entry.userSid,
      entry.userUpn,
      entry.action,
      entry.computerId,
      entry.keyId,
      entry.branchId,
      entry.reason,
      entry.reasonNote,
      entry.ticketNo,
      entry.clientIp,
      entry.userAgent,
      entry.detail === undefined || entry.detail === null ? null : JSON.stringify(entry.detail),
      prevHash,
      hash,
    ],
  );
  // The id of the row just written: we still hold the chain lock, so it is the tail (the function runs as the
  // owner, so no SELECT policy and no privilege on the sequence is needed).
  const written = await tx.query('SELECT id FROM access_log_tail()');
  return { id: Number(written.rows[0].id), at: entry.at };
}

/** Maps a DB row to the entry shape used by the hash chain. */
export const rowToEntry = (r) => ({
  id: r.id,
  at: r.at,
  userSid: r.user_sid,
  userUpn: r.user_upn,
  action: r.action,
  computerId: r.computer_id,
  keyId: r.key_id,
  branchId: r.branch_id,
  reason: r.reason,
  reasonNote: r.reason_note,
  ticketNo: r.ticket_no,
  clientIp: r.client_ip,
  userAgent: r.user_agent,
  detail: r.detail,
  prevHash: r.prev_hash,
  hash: r.hash,
});

/**
 * Log search for the audit screen / API / CSV. `branches` = the reader's log scope.
 * filters: { branchId, user, action, computer, from, to }
 */
export async function searchLog(tx, branches, filters, { limit, offset }) {
  const params = [];
  const where = [branchFilter('l.branch_id', branches, params)];
  if (filters.branchId) {
    params.push(filters.branchId);
    where.push(`l.branch_id = $${params.length}`);
  }
  if (filters.user) {
    params.push(`%${filters.user.toLowerCase()}%`);
    where.push(`lower(l.user_upn) LIKE $${params.length}`);
  }
  if (filters.action) {
    params.push(filters.action);
    where.push(`l.action = $${params.length}`);
  }
  if (filters.computer) {
    params.push(`${filters.computer.toLowerCase()}%`);
    where.push(`lower(c.name) LIKE $${params.length}`);
  }
  if (filters.from) {
    params.push(filters.from);
    where.push(`l.at >= $${params.length}`);
  }
  if (filters.to) {
    params.push(filters.to);
    where.push(`l.at < $${params.length}`);
  }
  params.push(limit, offset);
  const { rows } = await tx.query(
    `SELECT l.id, l.at, l.user_upn, l.action, l.reason, l.reason_note, l.ticket_no, l.client_ip,
            l.key_id, l.detail, b.code AS branch_code, c.id AS computer_id, c.name AS computer_name,
            count(*) OVER () AS total
       FROM access_log l
       LEFT JOIN branch b ON b.id = l.branch_id
       LEFT JOIN computer c ON c.id = l.computer_id
      WHERE ${where.join(' AND ')}
      ORDER BY l.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { rows, total: Number(rows[0]?.total ?? 0) };
}

/** Rows for chain verification, in id order, in pages (runs with all branches). */
export async function readChainPage(tx, afterId, limit) {
  const { rows } = await tx.query('SELECT * FROM access_log WHERE id > $1 ORDER BY id LIMIT $2', [afterId, limit]);
  return rows;
}
