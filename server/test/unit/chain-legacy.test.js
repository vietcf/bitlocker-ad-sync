import { describe, expect, it } from 'vitest';
import { GENESIS_HASH, chainHash, verifyChain } from '../../src/modules/audit/chain.js';

const key = Buffer.alloc(32, 1);
const base = { at: new Date('2026-10-18T10:00:00Z'), userSid: 'u', userUpn: 'u', action: 'export_log', computerId: null, keyId: null, branchId: null,
  reason: null, reasonNote: null, ticketNo: null, clientIp: null, userAgent: null };

describe('hash chain and old export_log rows', () => {
  it('a Date inside detail hashes like its ISO text', () => {
    const a = chainHash(key, GENESIS_HASH, { ...base, detail: { filters: { from: new Date('2026-10-01') } } });
    const b = chainHash(key, GENESIS_HASH, { ...base, detail: { filters: { from: '2026-10-01T00:00:00.000Z' } } });
    expect(a.equals(b)).toBe(true);
  });

  it('a row written before the fix (Date hashed as {}) still verifies, other rows do not get this leniency', () => {
    const stored = { ...base, detail: { filters: { from: '2026-10-01T00:00:00.000Z', user: 'x' }, rows: 3 } };
    const oldHash = chainHash(key, GENESIS_HASH, { ...base, detail: { filters: { from: {}, user: 'x' }, rows: 3 } });
    const row = { ...stored, id: 1, prevHash: GENESIS_HASH, hash: oldHash };
    expect(verifyChain(key, [row])).toMatchObject({ ok: true });
    expect(verifyChain(key, [{ ...row, action: 'reveal' }])).toMatchObject({ ok: false });
    expect(verifyChain(key, [{ ...row, detail: { ...stored.detail, rows: 4 } }])).toMatchObject({ ok: false });
  });
});
