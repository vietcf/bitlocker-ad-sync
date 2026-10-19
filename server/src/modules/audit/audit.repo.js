import { branchFilter } from '../../db/scoped.js';
/**
 * Appends one row to access_log inside the caller's transaction: if the caller rolls back, the row disappears with it.
 * Returns { id, at } of the new row.
 */
export async function appendLog(tx, input) {
  const at = new Date(Math.floor((input.at ?? new Date()).getTime()));
  // No RETURNING: it would also apply the SELECT policy, and a writer may not be allowed to read back its own row
  // (e.g. a sign-in event, which belongs to no branch). access_log_last_id() gives the id of this session's insert.
  await tx.query(
    `INSERT INTO access_log
       (at, user_sid, user_upn, action, computer_id, key_id, branch_id, reason, reason_note,
        ticket_no, client_ip, user_agent, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      at,
      input.userSid,
      input.userUpn,
      input.action,
      input.computerId,
      input.keyId,
      input.branchId,
      input.reason,
      input.reasonNote,
      input.ticketNo,
      input.clientIp,
      input.userAgent,
      input.detail === undefined || input.detail === null ? null : JSON.stringify(input.detail),
    ],
  );
  const written = await tx.query('SELECT access_log_last_id() AS id');
  return { id: Number(written.rows[0].id), at };
}

/**
 * Log search for the audit screen / API / CSV. `branches` = the reader's log scope.
 * filters: { branchId, user, action, computer, from, to }
 */
export async function searchLog(tx, branches, filters, { limit, offset, tz = process.env.APP_TZ ?? 'Asia/Ho_Chi_Minh' }) {
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
  // from / to: whole days in the app's time zone, both included.
  if (filters.from) {
    params.push(filters.from.toISOString().slice(0, 10), tz);
    where.push(`l.at >= (($${params.length - 1}::date)::timestamp AT TIME ZONE $${params.length})`);
  }
  if (filters.to) {
    params.push(filters.to.toISOString().slice(0, 10), tz);
    where.push(`l.at < ((($${params.length - 1}::date) + 1)::timestamp AT TIME ZONE $${params.length})`);
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

