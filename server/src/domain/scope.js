// Roles: 'it' | 'lead' | 'admin' | 'auditor'
// A grant is one row of user_grant: { branchId: number | null, role }. branchId null = all branches.
// A scope is { userSid, upn, displayName, grants: [...] }.
// A branch set is 'all' or an array of branch ids (empty array = nothing).

// Capabilities:
//   keys    - search computers, view key metadata, reveal
//   logs    - read access_log
//   reports - no-key / reveal statistics reports
//   admin   - branches, users, sync control
const ROLES_FOR = {
  keys: ['it', 'lead', 'admin'],
  logs: ['lead', 'admin', 'auditor'],
  reports: ['lead', 'admin', 'auditor'],
  admin: ['admin'],
};

/**
 * Only Admin HQ sees every branch: an admin grant covers all branches whatever branch_id says.
 * Any other role sees only the branches it is granted; a non-admin grant without a branch
 * (branch_id NULL, not allowed since migration 026) gives nothing.
 */
const ALWAYS_ALL = ['admin'];

/** Which branches the user may act on for a capability: 'all' or a sorted array of ids. */
export function branchesFor(scope, capability) {
  const roles = ROLES_FOR[capability];
  if (!roles) throw new Error(`Unknown capability: ${capability}`);
  const ids = new Set();
  for (const g of scope.grants) {
    if (!roles.includes(g.role)) continue;
    if (ALWAYS_ALL.includes(g.role)) return 'all';
    if (g.branchId !== null) ids.add(g.branchId);
  }
  return [...ids].sort((a, b) => a - b);
}

export function can(scope, capability) {
  const set = branchesFor(scope, capability);
  return set === 'all' || set.length > 0;
}

export function rolesOf(scope) {
  return [...new Set(scope.grants.map((g) => g.role))];
}

/** Unmapped computers (branchId null) are visible only with 'all'. */
export function inBranchSet(set, branchId) {
  if (set === 'all') return true;
  return branchId !== null && set.includes(branchId);
}
