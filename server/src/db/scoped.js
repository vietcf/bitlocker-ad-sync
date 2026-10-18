/**
 * The only way the app touches scoped tables. Opens a transaction and sets the branch scope
 * for Row-Level Security with set_config(..., is_local = true), so it vanishes at COMMIT/ROLLBACK
 * and can never leak to the next request that reuses the pooled connection.
 *
 * `branches` is 'all' or an array of branch ids ([] = nothing).
 * `fn(tx)` receives the pg client; whatever it returns is returned after COMMIT.
 *
 * Repo functions still filter by branch themselves (first layer); RLS is the second layer.
 */
export async function withScope(pool, branches, fn, { isolation = 'READ COMMITTED' } = {}) {
  const client = await pool.connect();
  const afterCommit = [];
  client.afterCommit = (fn) => afterCommit.push(fn); // runs after COMMIT, never for a rolled back transaction
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    await client.query(
      `SELECT set_config('app.all_branches', $1, true), set_config('app.branch_ids', $2, true)`,
      branches === 'all' ? ['1', ''] : ['0', `{${branches.join(',')}}`],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    for (const run of afterCommit) {
      try {
        run();
      } catch {
        // a follow-up of the commit must never fail the request
      }
    }
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** For system work (ingest, jobs) that legitimately spans every branch. */
export function withAllBranches(pool, fn, opts) {
  return withScope(pool, 'all', fn, opts);
}

/**
 * SQL fragment for the app-level branch filter; pushes its parameter onto `params`.
 * Returns 'TRUE' for 'all', otherwise "<column> = ANY($n)".
 */
export function branchFilter(column, branches, params) {
  if (branches === 'all') return 'TRUE';
  params.push([...branches]);
  return `${column} = ANY($${params.length}::int[])`;
}
