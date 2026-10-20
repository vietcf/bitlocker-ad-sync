import { branchFilter } from '../../db/scoped.js';

// Period bounds: from / to are 'YYYY-MM-DD' (inclusive) in time zone tz; each query turns them into
// [start of from, start of the day after to) as timestamptz.
const periodParams = (params, { from, to, tz }) => {
  params.push(from, to, tz);
  const n = params.length;
  return {
    start: `(($${n - 2}::date)::timestamp AT TIME ZONE $${n})`,
    end: `((($${n - 1}::date) + 1)::timestamp AT TIME ZONE $${n})`,
  };
};

/**
 * First day with data in scope (computer or key first recorded here), 'YYYY-MM-DD' in time zone tz;
 * null when there is none. Start of the "all time" report.
 */
export async function earliestDay(tx, branches, tz) {
  const params = [];
  const scope = branchFilter('c.branch_id', branches, params);
  params.push(tz);
  const { rows } = await tx.query(
    `SELECT to_char(least(min(c.first_seen_at), min(k.first_synced_at)) AT TIME ZONE $${params.length},'YYYY-MM-DD') AS day
       FROM computer c LEFT JOIN recovery_key k ON k.computer_id = c.id
      WHERE ${scope}`,
    params,
  );
  return rows[0]?.day ?? null;
}

/**
 * Computers being monitored that have at least one recovery key, with how many keys each has and when
 * the newest key was created in AD. Never a key value. For the Excel export of one branch.
 */
export async function computersWithKey(tx, branches) {
  const params = [];
  const scope = branchFilter('c.branch_id', branches, params);
  const { rows } = await tx.query(
    `SELECT c.id, c.name, c.os, c.distinguished_name, c.device_serial, c.owner_email, c.ad_created_at, c.first_seen_at, c.last_logon_at,
            c.branch_id, b.code AS branch_code, b.name AS branch_name,
            k.keys, k.latest_key_at
       FROM computer c
       LEFT JOIN branch b ON b.id = c.branch_id
       JOIN LATERAL (SELECT count(*)::int AS keys, max(rk.ad_created_at) AS latest_key_at
                       FROM recovery_key rk WHERE rk.computer_id = c.id) k ON k.keys > 0
      WHERE ${scope} AND c.deleted_in_ad_at IS NULL
      ORDER BY b.code NULLS FIRST, lower(c.name)`,
    params,
  );
  return rows;
}

/**
 * Computers that left the monitored scope (flagged "not in AD") within the period, with how many keys they hold
 * (kept) and when a sync last saw them. Newest first. Never a key value. For the Excel export.
 */
export async function computersLeftInPeriod(tx, branches, period) {
  const params = [];
  const scope = branchFilter('c.branch_id', branches, params);
  const { start, end } = periodParams(params, period);
  const { rows } = await tx.query(
    `SELECT c.id, c.name, c.os, c.distinguished_name, c.device_serial, c.owner_email, c.branch_id, b.code AS branch_code,
            c.deleted_in_ad_at,
            (SELECT r.started_at FROM sync_run r WHERE r.id = c.last_seen_run) AS last_seen_at,
            (SELECT count(*)::int FROM recovery_key k WHERE k.computer_id = c.id) AS keys
       FROM computer c LEFT JOIN branch b ON b.id = c.branch_id
      WHERE ${scope} AND c.deleted_in_ad_at >= ${start} AND c.deleted_in_ad_at < ${end}
      ORDER BY c.deleted_in_ad_at DESC, b.code NULLS FIRST, lower(c.name)`,
    params,
  );
  return rows;
}

/** Computers present in AD with no recovery key at all (BitLocker key not escrowed). */
export async function computersWithoutKey(tx, branches) {
  const params = [];
  const scope = branchFilter('c.branch_id', branches, params);
  const { rows } = await tx.query(
    `SELECT c.id, c.name, c.os, c.distinguished_name, c.device_serial, c.owner_email, c.ad_created_at, c.first_seen_at, c.last_logon_at,
            c.branch_id, b.code AS branch_code, b.name AS branch_name
       FROM computer c
       LEFT JOIN branch b ON b.id = c.branch_id
      WHERE ${scope} AND c.deleted_in_ad_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM recovery_key k WHERE k.computer_id = c.id)
      ORDER BY b.code NULLS FIRST, c.first_seen_at, lower(c.name)`,
    params,
  );
  return rows;
}

/** Active branches in scope (so a branch with no computer still shows in the report). */
export async function branchList(tx, branches) {
  const params = [];
  const scope = branchFilter('b.id', branches, params);
  const { rows } = await tx.query(`SELECT b.id, b.code, b.name FROM branch b WHERE ${scope} AND b.is_active ORDER BY b.code`, params);
  return rows;
}

/** Every branch still in the table (active or not) in scope: to tell a deleted branch from a live one. */
export async function existingBranches(tx, branches) {
  const params = [];
  const scope = branchFilter('b.id', branches, params);
  const { rows } = await tx.query(`SELECT b.id, b.code, b.name FROM branch b WHERE ${scope}`, params);
  return rows;
}

/**
 * Per branch: computers in AD now, with / without a key, keys, and what changed in the period
 * (computers and keys first recorded, computers marked as no longer in AD).
 */
export async function inventoryByBranch(tx, branches, period, months = 3) {
  const params = [];
  const scope = branchFilter('c.branch_id', branches, params);
  const { start, end } = periodParams(params, period);
  params.push(months);
  const recent = `now() - make_interval(months => $${params.length})`;
  const { rows } = await tx.query(
    `SELECT c.branch_id,
            count(*) FILTER (WHERE c.deleted_in_ad_at IS NULL)::int AS computers,
            count(*) FILTER (WHERE c.deleted_in_ad_at IS NULL AND kc.n > 0)::int AS with_key,
            count(*) FILTER (WHERE c.deleted_in_ad_at IS NULL AND kc.n = 0)::int AS no_key,
            count(*) FILTER (WHERE c.deleted_in_ad_at IS NULL AND c.last_logon_at >= ${recent})::int AS active,
            count(*) FILTER (WHERE c.deleted_in_ad_at IS NULL AND c.last_logon_at < ${recent})::int AS inactive,
            count(*) FILTER (WHERE c.deleted_in_ad_at IS NULL AND c.last_logon_at IS NULL)::int AS no_logon,
            coalesce(sum(kc.n) FILTER (WHERE c.deleted_in_ad_at IS NULL), 0)::int AS keys,
            count(*) FILTER (WHERE c.first_seen_at >= ${start} AND c.first_seen_at < ${end})::int AS new_computers,
            coalesce(sum(kc.new_n), 0)::int AS new_keys,
            count(*) FILTER (WHERE c.deleted_in_ad_at >= ${start} AND c.deleted_in_ad_at < ${end})::int AS left_ad
       FROM computer c
       CROSS JOIN LATERAL (
         SELECT count(*)::int AS n,
                count(*) FILTER (WHERE k.first_synced_at >= ${start} AND k.first_synced_at < ${end})::int AS new_n
           FROM recovery_key k WHERE k.computer_id = c.id) kc
      WHERE ${scope}
      GROUP BY c.branch_id`,
    params,
  );
  return rows;
}

/** Every key reveal in the period (branch, user, computer, reason, time, export or not), oldest first. */
export async function revealsInPeriod(tx, branches, period) {
  const params = [];
  const scope = branchFilter('l.branch_id', branches, params);
  const { start, end } = periodParams(params, period);
  const { rows } = await tx.query(
    `SELECT l.branch_id, l.user_upn, l.computer_id, l.reason, l.at, coalesce((l.detail->>'export')::boolean, false) AS exported
       FROM access_log l
      WHERE ${scope} AND l.action = 'reveal' AND l.at >= ${start} AND l.at < ${end}
      ORDER BY l.at`,
    params,
  );
  return rows;
}

/** Reveals per branch and per user over the last `days` days (from the audit log). */
export async function revealStats(tx, branches, days) {
  const params = [days];
  const scope = branchFilter('l.branch_id', branches, params);
  const byBranch = await tx.query(
    `SELECT coalesce(b.code, '—') AS branch_code, count(*)::int AS reveals
       FROM access_log l LEFT JOIN branch b ON b.id = l.branch_id
      WHERE ${scope} AND l.action = 'reveal' AND l.at > now() - make_interval(days => $1)
      GROUP BY 1 ORDER BY 2 DESC`,
    params,
  );
  const byUser = await tx.query(
    `SELECT l.user_upn, count(*)::int AS reveals, max(l.at) AS last_at
       FROM access_log l
      WHERE ${scope} AND l.action = 'reveal' AND l.at > now() - make_interval(days => $1)
      GROUP BY 1 ORDER BY 2 DESC LIMIT 50`,
    params,
  );
  return { byBranch: byBranch.rows, byUser: byUser.rows };
}
