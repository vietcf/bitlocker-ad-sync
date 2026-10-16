import { branchFilter } from '../../db/scoped.js';

/** Per branch: live computers and computers without any key. */
export async function inventoryByBranch(tx, branches) {
  const params = [];
  const scope = branchFilter('c.branch_id', branches, params);
  const { rows } = await tx.query(
    `SELECT c.branch_id, b.code AS branch_code, b.name AS branch_name,
            count(*)::int AS computers,
            count(*) FILTER (WHERE kc.n > 0)::int AS with_key,
            count(*) FILTER (WHERE kc.n = 0)::int AS no_key,
            coalesce(sum(kc.n), 0)::int AS keys
       FROM computer c
       LEFT JOIN branch b ON b.id = c.branch_id
       CROSS JOIN LATERAL (SELECT count(*)::int AS n FROM recovery_key k WHERE k.computer_id = c.id) kc
      WHERE ${scope} AND c.deleted_in_ad_at IS NULL
      GROUP BY c.branch_id, b.code, b.name
      ORDER BY count(*) DESC, b.code NULLS LAST`,
    params,
  );
  return rows;
}

/**
 * Computers and keys in the system at the end of each local day, for the last `days` days:
 * a computer counts from first_seen_at until it is marked as no longer in AD; a key from
 * first_synced_at (keys are never removed). Uses each computer's current branch.
 */
export async function inventoryPerDay(tx, branches, days, tz) {
  const params = [days, tz];
  const scope = branchFilter('c.branch_id', branches, params);
  const { rows } = await tx.query(
    `WITH d AS (
       SELECT g::date AS day, ((g::date + 1)::timestamp AT TIME ZONE $2) AS day_end
         FROM generate_series((now() AT TIME ZONE $2)::date - ($1 - 1), (now() AT TIME ZONE $2)::date, interval '1 day') AS g
     )
     SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
            (SELECT count(*)::int FROM computer c
              WHERE ${scope} AND c.first_seen_at < d.day_end
                AND (c.deleted_in_ad_at IS NULL OR c.deleted_in_ad_at >= d.day_end)) AS computers,
            (SELECT count(*)::int FROM recovery_key k JOIN computer c ON c.id = k.computer_id
              WHERE ${scope} AND k.first_synced_at < d.day_end) AS keys
       FROM d ORDER BY d.day`,
    params,
  );
  return rows;
}

/** Reveals per local calendar day for the last `days` days, zero-filled. */
export async function revealsPerDay(tx, branches, days, tz) {
  const params = [days, tz];
  const scope = branchFilter('l.branch_id', branches, params);
  const { rows } = await tx.query(
    `WITH d AS (
       SELECT generate_series((now() AT TIME ZONE $2)::date - ($1 - 1), (now() AT TIME ZONE $2)::date, interval '1 day')::date AS day
     )
     SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
            count(l.id)::int AS reveals
       FROM d
       LEFT JOIN access_log l
         ON (l.at AT TIME ZONE $2)::date = d.day AND l.action = 'reveal' AND ${scope}
      GROUP BY d.day ORDER BY d.day`,
    params,
  );
  return rows;
}

/** Reveals per branch over the last `days` days. */
export async function revealsByBranch(tx, branches, days) {
  const params = [days];
  const scope = branchFilter('l.branch_id', branches, params);
  const { rows } = await tx.query(
    `SELECT l.branch_id, count(*)::int AS reveals
       FROM access_log l
      WHERE ${scope} AND l.action = 'reveal' AND l.at > now() - make_interval(days => $1)
      GROUP BY l.branch_id`,
    params,
  );
  return rows;
}

/** The people who revealed the most keys over the last `days` days. */
export async function topRevealers(tx, branches, days, limit) {
  const params = [days, limit];
  const scope = branchFilter('l.branch_id', branches, params);
  const { rows } = await tx.query(
    `SELECT l.user_upn, count(*)::int AS reveals, max(l.at) AS last_at
       FROM access_log l
      WHERE ${scope} AND l.action = 'reveal' AND l.at > now() - make_interval(days => $1)
      GROUP BY l.user_upn
      ORDER BY 2 DESC
      LIMIT $2`,
    params,
  );
  return rows;
}
