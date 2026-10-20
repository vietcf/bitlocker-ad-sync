import { describe, expect, it } from 'vitest';
import { checkRun, median } from '../../src/modules/sync/anomaly.js';
import { isWithinWorkingHours } from '../../src/domain/time.js';

const t = { minComputerRatio: 0.95, minKeyRatio: 0.95, branchDropRatio: 0.2, branchDropMin: 10, maxDeleteRatio: 0.05 };
const overall = (o = {}) => ({ computers_seen: 1000, computers_in_db: 1000, keys_seen: 1200, keys_expected: 1200, keys_empty_pwd: 0, ...o });
const run = (o = {}) => ({ mode: 'full', overall: overall(o.overall), branches: o.branches ?? [], plannedDeletes: o.plannedDeletes ?? 0, liveComputers: 1000 });
const codes = (found) => found.map((f) => f.code);

describe('checkRun', () => {
  it('passes a normal full run', () => {
    expect(checkRun(run(), { branchSeen: {} }, t)).toEqual([]);
  });

  it('flags a drop in computers and in keys', () => {
    expect(codes(checkRun(run({ overall: { computers_seen: 900 } }), { branchSeen: {} }, t))).toContain('computers_drop');
    expect(codes(checkRun(run({ overall: { keys_seen: 1000 } }), { branchSeen: {} }, t))).toContain('keys_drop');
  });

  it('flags one branch dropping against its own median, but not small branches or small drops', () => {
    const baseline = { branchSeen: { 1: [200, 205, 198], 2: [8, 8, 8] } };
    expect(codes(checkRun(run({ branches: [{ branch_id: 1, branch_code: 'HN', computers_seen: 120 }] }), baseline, t))).toEqual(['branch_drop']);
    expect(checkRun(run({ branches: [{ branch_id: 1, branch_code: 'HN', computers_seen: 190 }] }), baseline, t)).toEqual([]);
    expect(checkRun(run({ branches: [{ branch_id: 2, branch_code: 'DN', computers_seen: 0 }] }), baseline, t)).toEqual([]);
  });

  it('skips a check Admin HQ switched off, and only that one', () => {
    const off = (code) => ({ ...t, enabled: { [code]: false } });
    const bad = run({ overall: { computers_seen: 900, keys_seen: 1000 }, plannedDeletes: 60, branches: [{ branch_id: 1, branch_code: 'HN', computers_seen: 120 }] });
    const baseline = { branchSeen: { 1: [200, 205, 198] } };
    expect(codes(checkRun(bad, baseline, t)).sort()).toEqual(['branch_drop', 'computers_drop', 'keys_drop', 'mass_delete']);
    expect(codes(checkRun(bad, baseline, off('computers_drop')))).not.toContain('computers_drop');
    expect(codes(checkRun(bad, baseline, off('keys_drop')))).not.toContain('keys_drop');
    expect(codes(checkRun(bad, baseline, off('branch_drop')))).not.toContain('branch_drop');
    expect(codes(checkRun(bad, baseline, off('mass_delete')))).not.toContain('mass_delete');
    expect(codes(checkRun(bad, baseline, off('mass_delete')))).toContain('computers_drop');
  });

  it('flags mass deletion over the threshold', () => {
    expect(codes(checkRun(run({ plannedDeletes: 60 }), { branchSeen: {} }, t))).toContain('mass_delete');
    expect(checkRun(run({ plannedDeletes: 40 }), { branchSeen: {} }, t)).toEqual([]);
  });

  it('flags unreadable passwords on any run, and skips full-only checks on delta runs', () => {
    const delta = { ...run({ overall: { computers_seen: 3, keys_empty_pwd: 2 } }), mode: 'delta' };
    expect(codes(checkRun(delta, { branchSeen: {} }, t))).toEqual(['key_attr_unreadable']);
  });
});

describe('median', () => {
  it('handles odd, even and empty lists', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe('isWithinWorkingHours', () => {
  const hours = { tz: 'Asia/Ho_Chi_Minh', days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' };
  it('uses the configured time zone', () => {
    // Tuesday 2026-10-13 02:00 UTC = 09:00 in Vietnam.
    expect(isWithinWorkingHours(new Date('2026-10-13T02:00:00Z'), hours)).toBe(true);
    // 12:00 UTC = 19:00 in Vietnam.
    expect(isWithinWorkingHours(new Date('2026-10-13T12:00:00Z'), hours)).toBe(false);
    // Saturday.
    expect(isWithinWorkingHours(new Date('2026-10-17T03:00:00Z'), hours)).toBe(false);
  });
});
