// Branches and their root OUs. Runs with all-branch scope (Admin HQ only).

export async function listBranches(tx) {
  const { rows } = await tx.query(
    `SELECT b.id, b.code, b.name, b.is_active,
            coalesce((SELECT array_agg(o.root_dn ORDER BY o.root_dn) FROM branch_ou o WHERE o.branch_id = b.id), '{}') AS ous,
            (SELECT count(*)::int FROM computer c WHERE c.branch_id = b.id AND c.deleted_in_ad_at IS NULL) AS computers
       FROM branch b
      ORDER BY b.code`,
  );
  return rows;
}

export async function getBranch(tx, id) {
  const { rows } = await tx.query(
    `SELECT b.id, b.code, b.name, b.is_active,
            coalesce((SELECT array_agg(o.root_dn ORDER BY o.root_dn) FROM branch_ou o WHERE o.branch_id = b.id), '{}') AS ous
       FROM branch b WHERE b.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function countUnmapped(tx) {
  const { rows } = await tx.query(
    `SELECT count(*)::int AS n FROM computer WHERE branch_id IS NULL AND deleted_in_ad_at IS NULL`,
  );
  return rows[0].n;
}

export async function insertBranch(tx, { code, name, isActive }) {
  const { rows } = await tx.query(
    `INSERT INTO branch (code, name, is_active) VALUES ($1, $2, $3) RETURNING id`,
    [code, name, isActive],
  );
  return rows[0].id;
}

export async function updateBranch(tx, id, { code, name, isActive }) {
  await tx.query('UPDATE branch SET code = $2, name = $3, is_active = $4 WHERE id = $1', [id, code, name, isActive]);
}

export async function replaceOus(tx, branchId, ous) {
  await tx.query('DELETE FROM branch_ou WHERE branch_id = $1', [branchId]);
  for (const ou of ous) await tx.query('INSERT INTO branch_ou (branch_id, root_dn) VALUES ($1, $2)', [branchId, ou]);
}

/** Root OUs already owned by another branch (a root may belong to one branch only). */
export async function ousOwnedElsewhere(tx, branchId, ous) {
  const { rows } = await tx.query(
    `SELECT o.root_dn, b.code FROM branch_ou o JOIN branch b ON b.id = o.branch_id
      WHERE o.root_dn = ANY($1::text[]) AND ($2::int IS NULL OR o.branch_id <> $2)`,
    [ous, branchId],
  );
  return rows;
}

// SQL twin of branchmap.branchForDn: longest root OU that the DN equals or ends with.
// right(...) instead of LIKE, because OU names may contain the LIKE wildcards % and _.
const BEST_BRANCH = `
  (SELECT o.branch_id FROM branch_ou o
    WHERE lower(c.distinguished_name) = o.root_dn
       OR right(lower(c.distinguished_name), length(o.root_dn) + 1) = ',' || o.root_dn
    ORDER BY length(o.root_dn) DESC LIMIT 1)`;

/** How many live computers a set of root OUs would cover, grouped by their current branch. */
export async function previewOus(tx, ous) {
  const { rows } = await tx.query(
    `SELECT coalesce(b.code, 'N/A') AS current_branch, count(*)::int AS computers
       FROM computer c LEFT JOIN branch b ON b.id = c.branch_id
      WHERE c.deleted_in_ad_at IS NULL
        AND EXISTS (SELECT 1 FROM unnest($1::text[]) AS r(root)
                     WHERE lower(c.distinguished_name) = r.root
                        OR right(lower(c.distinguished_name), length(r.root) + 1) = ',' || r.root)
      GROUP BY 1 ORDER BY 2 DESC`,
    [ous],
  );
  return rows;
}

/** Live computers now in a branch (after a save, to say how many it covers). */
export async function countBranchComputers(tx, branchId) {
  const { rows } = await tx.query('SELECT count(*)::int AS n FROM computer WHERE branch_id = $1 AND deleted_in_ad_at IS NULL', [branchId]);
  return rows[0].n;
}

/**
 * What deleting a branch would touch: its computers (live / no longer in AD), the role grants on it,
 * and the users left with no role at all afterwards.
 */
export async function branchDeleteImpact(tx, branchId) {
  const { rows } = await tx.query(
    `SELECT (SELECT count(*)::int FROM computer WHERE branch_id = $1 AND deleted_in_ad_at IS NULL) AS computers,
            (SELECT count(*)::int FROM computer WHERE branch_id = $1 AND deleted_in_ad_at IS NOT NULL) AS computers_gone,
            (SELECT count(*)::int FROM user_grant WHERE branch_id = $1) AS grants,
            coalesce((SELECT array_agg(u.username ORDER BY u.username) FROM app_user u
               WHERE EXISTS (SELECT 1 FROM user_grant g WHERE g.user_id = u.id AND g.branch_id = $1)
                 AND NOT EXISTS (SELECT 1 FROM user_grant g WHERE g.user_id = u.id AND g.branch_id IS DISTINCT FROM $1)), '{}') AS users_left_without_role`,
    [branchId],
  );
  return rows[0];
}

/** Deletes a branch: its computers go to no branch first; its OUs and role grants go with it (ON DELETE CASCADE). */
export async function deleteBranch(tx, branchId) {
  await tx.query('UPDATE computer SET branch_id = NULL WHERE branch_id = $1', [branchId]);
  await tx.query('DELETE FROM branch WHERE id = $1', [branchId]);
}

/** Recomputes branch_id of every computer from the current OU table. Returns the moves. */
export async function remapComputers(tx) {
  const { rows } = await tx.query(
    `WITH target AS (
       SELECT c.id, c.branch_id AS old_branch, ${BEST_BRANCH} AS new_branch FROM computer c
     ), changed AS (
       SELECT * FROM target WHERE old_branch IS DISTINCT FROM new_branch
     ), upd AS (
       UPDATE computer c SET branch_id = changed.new_branch FROM changed WHERE c.id = changed.id RETURNING c.id
     )
     SELECT id, old_branch, new_branch FROM changed`,
  );
  return rows;
}
