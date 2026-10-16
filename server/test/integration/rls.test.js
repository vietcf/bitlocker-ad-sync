import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withScope } from '../../src/db/scoped.js';
import { appPool, resetDatabase, seedTwoBranches } from './db.js';

let pool;

beforeAll(async () => {
  await resetDatabase();
  await seedTwoBranches();
  pool = appPool();
});
afterAll(async () => {
  await pool?.end();
});

// These queries deliberately skip the app-level branch filter: they prove RLS alone holds the line.
describe('row-level security (second layer)', () => {
  it('shows a branch-scoped user only their computers and keys', async () => {
    const r = await withScope(pool, [1], async (tx) => ({
      computers: (await tx.query('SELECT name FROM computer ORDER BY id')).rows.map((x) => x.name),
      keys: (await tx.query('SELECT key_id_prefix FROM recovery_key ORDER BY id')).rows.map((x) => x.key_id_prefix),
    }));
    expect(r.computers).toEqual(['HN-LT-0001']);
    expect(r.keys).toEqual(['AAAAAAAA']);
  });

  it('shows everything, including unmapped computers, with all branches', async () => {
    const n = await withScope(pool, 'all', async (tx) => (await tx.query('SELECT count(*)::int AS n FROM computer')).rows[0].n);
    expect(n).toBe(3);
  });

  it('shows nothing for an empty scope', async () => {
    const n = await withScope(pool, [], async (tx) => (await tx.query('SELECT count(*)::int AS n FROM recovery_key')).rows[0].n);
    expect(n).toBe(0);
  });

  it('fails closed when no scope was set at all', async () => {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM computer');
    expect(rows[0].n).toBe(0);
  });

  it('does not leak scope to the next transaction on the same pooled connection', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.all_branches', '1', true)`);
      await client.query('COMMIT');
      const { rows } = await client.query('SELECT count(*)::int AS n FROM computer');
      expect(rows[0].n).toBe(0);
    } finally {
      client.release();
    }
  });

  it('refuses to move a computer into a branch outside the scope', async () => {
    await expect(
      withScope(pool, [1], (tx) => tx.query('UPDATE computer SET branch_id = 2 WHERE id = 1')),
    ).rejects.toThrow(/row-level security/);
  });
});

describe('app_node privileges', () => {
  it('cannot delete keys', async () => {
    await expect(withScope(pool, 'all', (tx) => tx.query('DELETE FROM recovery_key'))).rejects.toThrow(/permission denied/);
  });

  it('cannot change or delete the access log', async () => {
    await expect(withScope(pool, 'all', (tx) => tx.query(`UPDATE access_log SET reason = 'x'`))).rejects.toThrow(/permission denied/);
    await expect(withScope(pool, 'all', (tx) => tx.query('DELETE FROM access_log'))).rejects.toThrow(/permission denied/);
  });

  it('cannot read the migrations table', async () => {
    await expect(pool.query('SELECT * FROM schema_migrations')).rejects.toThrow(/permission denied/);
  });
});
