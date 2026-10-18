// Locking an account after wrong passwords (or wrong two-step codes). Set under Quan tri > Bao mat
// (setting security.lockout), read on every sign-in attempt, so a change applies at once.

export const LOCKOUT_DEFAULTS = {
  enabled: true,
  maxAttempts: 5, // wrong attempts in a row that lock the account
  lockMinutes: 15, // how long; 0 = until Admin HQ unlocks it (screen, or: node src/cli/users.js unlock <username>)
  applyToAdmin: true, // false: Admin HQ accounts are never locked (they may be the only way in)
};
export const LOCKOUT_LIMITS = { maxAttempts: [3, 20], lockMinutes: [0, 10080] };

/** The policy in force (settings may be null: the defaults). A wrong stored value falls back to the default. */
export async function loadLockoutPolicy(settings) {
  const s = { ...LOCKOUT_DEFAULTS, ...((settings ? await settings.get('security.lockout', {}) : {}) ?? {}) };
  const inside = (v, [min, max]) => Number.isInteger(v) && v >= min && v <= max;
  return {
    enabled: s.enabled !== false,
    maxAttempts: inside(s.maxAttempts, LOCKOUT_LIMITS.maxAttempts) ? s.maxAttempts : LOCKOUT_DEFAULTS.maxAttempts,
    lockMinutes: inside(s.lockMinutes, LOCKOUT_LIMITS.lockMinutes) ? s.lockMinutes : LOCKOUT_DEFAULTS.lockMinutes,
    applyToAdmin: s.applyToAdmin !== false,
  };
}
