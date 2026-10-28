// mail_outbox: every e-mail the app sends, and its delivery state.

/** status 'no_recipient': nobody to send it to; kept (with the reason in last_error) for the mail log. */
export async function insertMail(db, { kind, recipients, subject, body, html = null, status = 'pending', reason = null, missing = [] }) {
  const { rows } = await db.query(
    `INSERT INTO mail_outbox (kind, recipients, subject, body, html, status, last_error, missing_recipients)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [kind, recipients, subject.slice(0, 300), body, html, status, reason ? String(reason).slice(0, 500) : null, missing],
  );
  return Number(rows[0].id);
}

export async function dueMails(db, limit) {
  const { rows } = await db.query(
    `SELECT id, kind, recipients, subject, body, html, attempts, created_at
       FROM mail_outbox WHERE status = 'pending' AND next_attempt_at <= now()
      ORDER BY id LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function markSent(db, id) {
  await db.query(`UPDATE mail_outbox SET status = 'sent', sent_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1`, [id]);
}

/** A failed attempt: retry after `retryMinutes`, or give up (status failed) when it is null. */
export async function markAttemptFailed(db, id, error, retryMinutes) {
  await db.query(
    `UPDATE mail_outbox
        SET attempts = attempts + 1, last_error = $2,
            status = CASE WHEN $3::int IS NULL THEN 'failed' ELSE 'pending' END,
            next_attempt_at = now() + make_interval(mins => coalesce($3::int, 0))
      WHERE id = $1`,
    [id, String(error).slice(0, 500), retryMinutes],
  );
}

/** No SMTP server configured: keep the mail waiting (no attempt counted), or fail it when too old. */
export async function markWaiting(db, id, error, giveUp) {
  await db.query(
    `UPDATE mail_outbox
        SET last_error = $2, status = CASE WHEN $3 THEN 'failed' ELSE 'pending' END,
            next_attempt_at = now() + interval '5 minutes'
      WHERE id = $1`,
    [id, error, giveUp],
  );
}

export async function retryMail(db, id) {
  const { rowCount } = await db.query(
    `UPDATE mail_outbox SET status = 'pending', next_attempt_at = now(), attempts = 0 WHERE id = $1 AND status = 'failed'`,
    [id],
  );
  return rowCount > 0;
}

export async function purgeMails(db, days) {
  const { rowCount } = await db.query(
    `DELETE FROM mail_outbox WHERE status <> 'pending' AND created_at < now() - make_interval(days => $1)`,
    [days],
  );
  return rowCount;
}

/** filters: { status, q (subject or recipient) }. */
export async function listMails(db, filters, { limit, offset }) {
  const params = [];
  const where = ['TRUE'];
  if (filters.status) {
    params.push(filters.status);
    where.push(`status = $${params.length}`);
  }
  if (filters.q) {
    params.push(`%${filters.q.toLowerCase()}%`);
    const p = `$${params.length}`;
    where.push(`(lower(subject) LIKE ${p} OR lower(array_to_string(recipients, ',')) LIKE ${p}
                 OR lower(array_to_string(missing_recipients, ',')) LIKE ${p})`);
  }
  params.push(limit, offset);
  const { rows } = await db.query(
    `SELECT id, kind, recipients, missing_recipients, subject, status, attempts, last_error, created_at, sent_at, next_attempt_at,
            count(*) OVER () AS total
       FROM mail_outbox WHERE ${where.join(' AND ')}
      ORDER BY id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { rows: rows.map(({ total, ...r }) => r), total: rows.length ? Number(rows[0].total) : 0 };
}

export async function getMail(db, id) {
  const { rows } = await db.query('SELECT * FROM mail_outbox WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function mailCounts(db) {
  const { rows } = await db.query(`SELECT status, count(*)::int AS n FROM mail_outbox GROUP BY status`);
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

// ---- recipients ---------------------------------------------------------------------------

/** Active Admin HQ users with an e-mail: [{ email, language }]. */
export async function adminRecipients(db) {
  const { rows } = await db.query(
    `SELECT DISTINCT u.email, u.language FROM app_user u JOIN user_grant g ON g.user_id = u.id
      WHERE u.is_active AND u.email IS NOT NULL AND g.role = 'admin'`,
  );
  return rows;
}

/** E-mails of active Admin HQ users. */
export async function adminEmails(db) {
  const { rows } = await db.query(
    `SELECT DISTINCT u.email FROM app_user u JOIN user_grant g ON g.user_id = u.id
      WHERE u.is_active AND u.email IS NOT NULL AND g.role = 'admin'`,
  );
  return rows.map((r) => r.email);
}

/**
 * Active users with one of `roles` but no e-mail address: [{ username, role, branch_id }]
 * (branch_id null = all branches). They would receive notifications if they had one.
 */
export async function grantsWithoutEmail(db, roles) {
  if (!roles.length) return [];
  const { rows } = await db.query(
    `SELECT u.username, g.role, g.branch_id FROM app_user u JOIN user_grant g ON g.user_id = u.id
      WHERE u.is_active AND (u.email IS NULL OR u.email = '') AND g.role = ANY($1) ORDER BY 1`,
    [roles],
  );
  return rows;
}

/** Usernames of active Admin HQ users without an e-mail address. */
export async function adminsWithoutEmail(db) {
  return [...new Set((await grantsWithoutEmail(db, ['admin'])).map((r) => r.username))];
}

/** Active IT / lead users with an e-mail and the branches they hold (branch_id null = all branches). */
export async function branchStaff(db) {
  const { rows } = await db.query(
    `SELECT DISTINCT u.email, u.language, g.branch_id FROM app_user u JOIN user_grant g ON g.user_id = u.id
      WHERE u.is_active AND u.email IS NOT NULL AND g.role IN ('it', 'lead')`,
  );
  return rows;
}
