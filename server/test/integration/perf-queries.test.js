import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appPool, asOwner, resetDatabase, seedTwoBranches } from './db.js';
import { withAllBranches, withScope } from '../../src/db/scoped.js';
import { inventoryPerDay } from '../../src/modules/dashboard/dashboard.repo.js';
import { isWithinWorkingHours } from '../../src/domain/time.js';
import { searchLog } from '../../src/modules/audit/audit.repo.js';
import { listComputers } from '../../src/modules/computers/computers.repo.js';

// Queries rewritten for speed on large data (50k computers): the figures must stay the same as the plain per-day / per-row form.
let pool;
beforeAll(() => {
  pool = appPool();
});
afterAll(() => pool?.end());
beforeEach(async () => {
  await resetDatabase();
  await seedTwoBranches();
});

const TZ = 'Asia/Ho_Chi_Minh';

describe('inventoryPerDay (one pass) equals the day-by-day count', () => {
  it('counts computers (not yet left) and keys per local day, also for a branch scope', async () => {
    await asOwner(`
      INSERT INTO computer (object_guid, name, distinguished_name, branch_id, first_seen_at, deleted_in_ad_at)
      SELECT gen_random_uuid(), 'X-' || i, 'CN=X-' || i || ',OU=Computers,OU=HN,DC=corp,DC=local', 1 + (i % 2),
             now() - ((i % 25) * interval '1 day') - interval '3 hours',
             CASE WHEN i % 7 = 0 THEN now() - ((i % 9) * interval '1 day') ELSE NULL END
        FROM generate_series(1, 120) i;
      UPDATE computer SET first_seen_at = now() - interval '40 days' WHERE id <= 3;
      INSERT INTO recovery_key (computer_id, key_id, recovery_password, ad_created_at, first_synced_at)
      SELECT c.id, gen_random_uuid(), '000000-000000-000000-000000-000000-000000-000000-000000', now(), now() - ((c.id % 30) * interval '1 day')
        FROM computer c WHERE c.id % 3 <> 0 AND c.id > 3;`);
    const naive = async (branchCond) => asOwner(
      `WITH d AS (
         SELECT g::date AS day, ((g::date + 1)::timestamp AT TIME ZONE $1) AS day_end
           FROM generate_series((now() AT TIME ZONE $1)::date - 29, (now() AT TIME ZONE $1)::date, interval '1 day') AS g)
       SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
              (SELECT count(*)::int FROM computer c WHERE ${branchCond} AND c.first_seen_at < d.day_end
                  AND (c.deleted_in_ad_at IS NULL OR c.deleted_in_ad_at >= d.day_end)) AS computers,
              (SELECT count(*)::int FROM recovery_key k JOIN computer c ON c.id = k.computer_id
                WHERE ${branchCond} AND k.first_synced_at < d.day_end) AS keys
         FROM d ORDER BY d.day`,
      [TZ],
    );
    const all = await withAllBranches(pool, (tx) => inventoryPerDay(tx, 'all', 30, TZ));
    expect(all).toEqual(await naive('TRUE'));
    expect(all.some((r) => r.computers > 0 && r.keys > 0)).toBe(true);
    const hn = await withScope(pool, [1], (tx) => inventoryPerDay(tx, [1], 30, TZ));
    expect(hn).toEqual(await naive('c.branch_id = 1'));
  });
});

describe('page counts are counted on their own and stay exact', () => {
  it('audit log: short first page needs no count; later pages report the exact total', async () => {
    await asOwner(`
      INSERT INTO access_log (user_sid, user_upn, action, branch_id, at)
      SELECT 'S-1-' || (i % 3), 'user' || (i % 3) || '@corp.local', 'search', 1, now() - (i * interval '1 minute') FROM generate_series(1, 130) i`);
    const page = (offset, filters = {}) => withAllBranches(pool, (tx) => searchLog(tx, 'all', filters, { limit: 50, offset }));
    expect((await page(0)).total).toBe(130);
    expect((await page(100)).total).toBe(130);
    expect((await page(100)).rows).toHaveLength(30);
    expect((await page(0, { user: 'user1' })).total).toBe(44); // 1, 4, ... 130
    expect((await page(0, { action: 'nothing' }))).toEqual({ rows: [], total: 0 });
  });

  it('computer list: exact total on every page, a short first page counts its rows', async () => {
    const all = (offset, limit = 2, filters = {}) => withAllBranches(pool, (tx) => listComputers(tx, 'all', filters, { limit, offset }));
    expect((await all(0)).total).toBe(3);
    expect((await all(2)).total).toBe(3);
    expect((await all(0, 25)).total).toBe(3);
    expect((await all(0, 25, { status: 'no_key' })).total).toBe(0);
  });
});

describe('isWithinWorkingHours (cached formatter) keeps its answers', () => {
  const hours = { tz: TZ, days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' };
  it('weekday inside / outside, weekend, and the edges', () => {
    expect(isWithinWorkingHours(new Date('2026-10-19T03:00:00Z'), hours)).toBe(true); // Monday 10:00 in Ho Chi Minh
    expect(isWithinWorkingHours(new Date('2026-10-19T11:00:00Z'), hours)).toBe(false); // Monday 18:00 (end is exclusive)
    expect(isWithinWorkingHours(new Date('2026-10-19T00:59:00Z'), hours)).toBe(false); // Monday 07:59
    expect(isWithinWorkingHours(new Date('2026-10-19T01:00:00Z'), hours)).toBe(true); // Monday 08:00
    expect(isWithinWorkingHours(new Date('2026-10-24T03:00:00Z'), hours)).toBe(false); // Saturday
    expect(isWithinWorkingHours(new Date('2026-10-19T03:00:00Z'), { ...hours, tz: 'UTC' })).toBe(false); // 03:00 UTC is before 08:00
  });
});
