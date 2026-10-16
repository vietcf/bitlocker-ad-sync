import { describe, expect, it } from 'vitest';
import { GENESIS_HASH, chainHash, verifyChain } from '../../src/modules/audit/chain.js';

const key = Buffer.alloc(32, 7);

function entry(i, over = {}) {
  return {
    at: new Date(Date.UTC(2026, 9, 13, 8, 0, i)),
    userSid: 'S-1-5-21-1-2-3-1001',
    userUpn: 'it.hn@corp.local',
    action: 'reveal',
    computerId: String(100 + i),
    keyId: '1a2b3c4d-0000-0000-0000-00000000000' + i,
    branchId: 1,
    reason: 'user_locked_out',
    reasonNote: null,
    ticketNo: null,
    clientIp: '10.0.0.5',
    userAgent: 'test',
    detail: { b: 2, a: 1 },
    ...over,
  };
}

function build(n) {
  const rows = [];
  let prev = GENESIS_HASH;
  for (let i = 0; i < n; i++) {
    const e = entry(i);
    const hash = chainHash(key, prev, e);
    rows.push({ ...e, id: String(i + 1), prevHash: prev, hash });
    prev = hash;
  }
  return rows;
}

describe('access_log hash chain', () => {
  it('verifies an untouched chain', () => {
    const r = verifyChain(key, build(5));
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(5);
  });

  it('detects an edited row at that row', () => {
    const rows = build(5);
    rows[2] = { ...rows[2], reason: 'other' };
    expect(verifyChain(key, rows)).toMatchObject({ ok: false, brokenAtId: '3', problem: 'hash_mismatch' });
  });

  it('detects a deleted row at the row after it', () => {
    const rows = build(5);
    rows.splice(1, 1);
    expect(verifyChain(key, rows)).toMatchObject({ ok: false, brokenAtId: '3', problem: 'prev_hash_mismatch' });
  });

  it('does not depend on JSON key order in detail', () => {
    const a = chainHash(key, GENESIS_HASH, entry(0, { detail: { a: 1, b: 2 } }));
    const b = chainHash(key, GENESIS_HASH, entry(0, { detail: { b: 2, a: 1 } }));
    expect(a.equals(b)).toBe(true);
  });

  it('cannot be recomputed without the key', () => {
    const other = Buffer.alloc(32, 9);
    expect(verifyChain(other, build(3)).ok).toBe(false);
  });
});
