import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withScope } from '../../src/db/scoped.js';
import { appendLog } from '../../src/modules/audit/audit.repo.js';
import { verifyChain } from '../../src/modules/audit/chain.js';
import { HMAC_KEY, appPool, resetDatabase, seedTwoBranches } from './db.js';

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

async function readChain() {
  return withScope(pool, 'all', async (tx) => {
    const { rows } = await tx.query('SELECT * FROM access_log ORDER BY id');
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      userSid: r.user_sid,
      userUpn: r.user_upn,
      action: r.action,
      computerId: r.computer_id,
      keyId: r.key_id,
      branchId: r.branch_id,
      reason: r.reason,
      reasonNote: r.reason_note,
      ticketNo: r.ticket_no,
      clientIp: r.client_ip,
      userAgent: r.user_agent,
      detail: r.detail,
      prevHash: r.prev_hash,
      hash: r.hash,
    }));
  });
}

describe('access_log chain in the database', () => {
  it('links rows written by users of different branches', async () => {
    await withScope(pool, [2], (tx) => appendLog(tx, HMAC_KEY, entry(2, 0)));
    await withScope(pool, [1], (tx) => appendLog(tx, HMAC_KEY, entry(1, 1)));
    expect(verifyChain(HMAC_KEY, await readChain())).toMatchObject({ ok: true, checked: 2 });
  });

  it('stays a single valid chain under concurrent writers', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        withScope(pool, [1 + (i % 2)], (tx) => appendLog(tx, HMAC_KEY, entry(1 + (i % 2), i))),
      ),
    );
    expect(verifyChain(HMAC_KEY, await readChain())).toMatchObject({ ok: true, checked: 22 });
  });

  it('leaves no row and no gap in the chain when the transaction rolls back', async () => {
    await expect(
      withScope(pool, [1], async (tx) => {
        await appendLog(tx, HMAC_KEY, entry(1, 99));
        throw new Error('reveal failed after logging');
      }),
    ).rejects.toThrow('reveal failed');
    await withScope(pool, [1], (tx) => appendLog(tx, HMAC_KEY, entry(1, 100)));
    expect(verifyChain(HMAC_KEY, await readChain())).toMatchObject({ ok: true, checked: 23 });
  });

  it('lets a lead read only their branch log', async () => {
    const branches = await withScope(pool, [1], async (tx) =>
      (await tx.query('SELECT DISTINCT branch_id FROM access_log')).rows.map((r) => r.branch_id),
    );
    expect(branches).toEqual([1]);
  });
});
