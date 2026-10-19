import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withScope } from '../../src/db/scoped.js';
import { appendLog } from '../../src/modules/audit/audit.repo.js';
import { appPool, asOwner, resetDatabase, seedTwoBranches } from './db.js';

let pool;

beforeAll(async () => {
  await resetDatabase();
  await seedTwoBranches();
  pool = appPool();
});
afterAll(async () => {
  await pool?.end();
});

const entry = (branchId, i) => ({
  userSid: `S-1-5-21-1-2-3-${1000 + branchId}`,
  userUpn: `it${branchId}@corp.local`,
  action: 'reveal',
  computerId: String(branchId),
  keyId: null,
  branchId,
  reason: 'user_locked_out',
  reasonNote: `n${i}`,
  ticketNo: null,
  clientIp: '10.0.0.1',
  userAgent: 'vitest',
  detail: { i },
});

const count = async () => (await asOwner('SELECT count(*)::int AS n FROM access_log'))[0].n;

describe('access_log in the database', () => {
  it('writes rows of users of different branches and returns the id of each', async () => {
    const a = await withScope(pool, [2], (tx) => appendLog(tx, entry(2, 0)));
    const b = await withScope(pool, [1], (tx) => appendLog(tx, entry(1, 1)));
    expect(b.id).toBeGreaterThan(a.id);
    expect(await count()).toBe(2);
  });

  it('gives every concurrent writer its own row and its own id', async () => {
    const written = await Promise.all(
      Array.from({ length: 20 }, (_, i) => withScope(pool, [1 + (i % 2)], (tx) => appendLog(tx, entry(1 + (i % 2), i)))),
    );
    expect(new Set(written.map((w) => w.id)).size).toBe(20);
    const rows = await asOwner('SELECT id, detail FROM access_log WHERE id = ANY($1::bigint[])', [written.map((w) => w.id)]);
    expect(rows).toHaveLength(20);
  });

  it('leaves no row when the transaction rolls back', async () => {
    const before = await count();
    await expect(
      withScope(pool, [1], async (tx) => {
        await appendLog(tx, entry(1, 99));
        throw new Error('reveal failed after logging');
      }),
    ).rejects.toThrow('reveal failed');
    expect(await count()).toBe(before);
    await withScope(pool, [1], (tx) => appendLog(tx, entry(1, 100)));
    expect(await count()).toBe(before + 1);
  });

  it('is append-only: nobody changes or deletes a row', async () => {
    await expect(asOwner('UPDATE access_log SET reason = $1', ['x'])).rejects.toThrow(/append-only/);
    await expect(asOwner('DELETE FROM access_log')).rejects.toThrow(/append-only/);
  });

  it('lets a lead read only their branch log', async () => {
    const branches = await withScope(pool, [1], async (tx) =>
      (await tx.query('SELECT DISTINCT branch_id FROM access_log')).rows.map((r) => r.branch_id),
    );
    expect(branches).toEqual([1]);
  });
});
