import { branchFilter } from '../../db/scoped.js';

/**
 * Per branch: live computers and computers without any key. Every branch of the caller's scope is
 * listed, also one that has no computer yet (all zeros); computers with no branch (N/A) only when
 * there are any (Admin HQ).
 */
export async function inventoryByBranch(tx, branches) {
  const params = [];
  const scope = branchFilter('b.id', branches, params);
  const { rows } = await tx.query(
    `SELECT b.id AS branch_id, b.code AS branch_code, b.name AS branch_name,
            count(c.id)::int AS computers,
            count(c.id) FILTER (WHERE kc.n > 0)::int AS with_key,
            count(c.id) FILTER (WHERE kc.n = 0)::int AS no_key,
            coalesce(sum(kc.n), 0)::int AS keys
       FROM branch b
       LEFT JOIN computer c ON c.branch_id = b.id AND c.deleted_in_ad_at IS NULL
       LEFT JOIN LATERAL (SELECT count(*)::int AS n FROM recovery_key k WHERE k.computer_id = c.id) kc ON true
      WHERE ${scope}
      GROUP BY b.id, b.code, b.name, b.is_active
     HAVING b.is_active OR count(c.id) > 0
      ORDER BY count(c.id) DESC, b.code`,
    params,
  );
  if (branches === 'all') {
    const na = await tx.query(
      `SELECT NULL::int AS branch_id, NULL::text AS branch_code, NULL::text AS branch_name,
              count(*)::int AS computers,
              count(*) FILTER (WHERE kc.n > 0)::int AS with_key,
              count(*) FILTER (WHERE kc.n = 0)::int AS no_key,
              coalesce(sum(kc.n), 0)::int AS keys
         FROM computer c
         CROSS JOIN LATERAL (SELECT count(*)::int AS n FROM recovery_key k WHERE k.computer_id = c.id) kc
        WHERE c.branch_id IS NULL AND c.deleted_in_ad_at IS NULL
       HAVING count(*) > 0`,
    );
    rows.push(...na.rows);
    rows.sort((a, b) => b.computers - a.computers || String(a.branch_code ?? '~').localeCompare(String(b.branch_code ?? '~')));
  }
  return rows;
}

/**
 * Computers and keys in the system at the end of each local day, for the last `days` days:
 * a computer counts from first_seen_at until it is marked as no longer in AD; a key from
 * first_synced_at (keys are never removed). Uses each computer's current branch.
 *
 * One pass: computers and keys are bucketed by local day once, then each day's figure is a running sum over those
 * few hundred buckets (MATERIALIZED: otherwise the planner inlines the buckets and recomputes them per day; the old form scanned both tables once per day: 30 scans, seconds on 50k computers).
 */
export async function inventoryPerDay(tx, branches, days, tz) {
  const params = [days, tz];
  const scope = branchFilter('c.branch_id', branches, params);
  const { rows } = await tx.query(
    `WITH d AS (
       SELECT g::date AS day
         FROM generate_series((now() AT TIME ZONE $2)::date - ($1 - 1), (now() AT TIME ZONE $2)::date, interval '1 day') AS g
     ),
     comp AS MATERIALIZED (
       SELECT day, sum(added)::int AS added, sum(left_n)::int AS left_n FROM (
         SELECT (c.first_seen_at AT TIME ZONE $2)::date AS day, count(*) AS added, 0 AS left_n
           FROM computer c WHERE ${scope} AND c.first_seen_at IS NOT NULL GROUP BY 1
         UNION ALL
         -- a computer marked as left before its first_seen_at (old data) is never counted: take the later of the two days
         SELECT greatest((c.first_seen_at AT TIME ZONE $2)::date, (c.deleted_in_ad_at AT TIME ZONE $2)::date), 0, count(*)
           FROM computer c WHERE ${scope} AND c.first_seen_at IS NOT NULL AND c.deleted_in_ad_at IS NOT NULL GROUP BY 1
       ) u GROUP BY day
     ),
     key_days AS MATERIALIZED (
       SELECT (k.first_synced_at AT TIME ZONE $2)::date AS day, count(*)::int AS added
         FROM recovery_key k JOIN computer c ON c.id = k.computer_id
        WHERE ${scope} AND k.first_synced_at IS NOT NULL GROUP BY 1
     )
     SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
            (SELECT coalesce(sum(added - left_n), 0)::int FROM comp WHERE comp.day <= d.day) AS computers,
            (SELECT coalesce(sum(added), 0)::int FROM key_days WHERE key_days.day <= d.day) AS keys
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
        AND l.at >= (((now() AT TIME ZONE $2)::date - ($1 - 1))::timestamp AT TIME ZONE $2)
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
    // A deleted branch (its id stays in the log) counts as N/A, with the computers it had.
    `SELECT b.id AS branch_id, count(*)::int AS reveals
       FROM access_log l LEFT JOIN branch b ON b.id = l.branch_id
      WHERE ${scope} AND l.action = 'reveal' AND l.at > now() - make_interval(days => $1)
      GROUP BY b.id`,
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
