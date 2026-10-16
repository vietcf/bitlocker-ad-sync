import { describe, expect, it } from 'vitest';
import { branchesFor, can, inBranchSet } from '../../src/domain/scope.js';

const g = (role, branchId) => ({ role, branchId });

describe('branchesFor', () => {
  it('gives IT only their branches for keys and nothing for logs', () => {
    const s = { grants: [g('it', 3)] };
    expect(branchesFor(s, 'keys')).toEqual([3]);
    expect(branchesFor(s, 'logs')).toEqual([]);
    expect(can(s, 'logs')).toBe(false);
  });

  it('unions branches across groups (regional IT)', () => {
    expect(branchesFor({ grants: [g('it', 7), g('it', 3), g('lead', 3)] }, 'keys')).toEqual([3, 7]);
  });

  it('gives a lead logs for their own branch only', () => {
    expect(branchesFor({ grants: [g('it', 7), g('lead', 3)] }, 'logs')).toEqual([3]);
  });

  it('treats admin as all branches even if a branch was set on the mapping', () => {
    expect(branchesFor({ grants: [g('admin', 5)] }, 'keys')).toBe('all');
    expect(can({ grants: [g('admin', 5)] }, 'admin')).toBe(true);
  });

  it('never gives an auditor keys', () => {
    const s = { grants: [g('auditor', 2)] };
    expect(can(s, 'keys')).toBe(false);
    expect(branchesFor(s, 'logs')).toEqual([2]);
  });

  it('gives all branches to Admin HQ only: a non-admin grant without a branch gives nothing', () => {
    for (const role of ['it', 'lead', 'auditor']) {
      expect(branchesFor({ grants: [g(role, null)] }, role === 'it' ? 'keys' : 'logs')).toEqual([]);
    }
    expect(branchesFor({ grants: [g('auditor', null), g('auditor', 3)] }, 'reports')).toEqual([3]);
  });

  it('gives nothing to a user with no grants', () => {
    expect(branchesFor({ grants: [] }, 'keys')).toEqual([]);
  });

  it('rejects an unknown capability instead of granting nothing silently', () => {
    expect(() => branchesFor({ grants: [] }, 'kyes')).toThrow(/Unknown capability/);
  });
});

describe('inBranchSet', () => {
  it('hides unmapped computers from branch-scoped users', () => {
    expect(inBranchSet([1, 2], null)).toBe(false);
    expect(inBranchSet('all', null)).toBe(true);
  });
});
