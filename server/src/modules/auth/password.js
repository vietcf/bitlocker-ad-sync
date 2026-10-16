import { randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

// scrypt cost: N=2^15, r=8, p=1 (~32 MB, ~50-100 ms per hash).
const N = 32768;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 64 * 1024 * 1024;

export const MIN_PASSWORD_LENGTH = 12;

/**
 * Password rules for local accounts (Quan tri > Bao mat, setting password.policy). minLength between
 * PASSWORD_LENGTH_LIMITS; each class flag requires at least one character of that class.
 */
export const PASSWORD_LENGTH_LIMITS = [8, 64];
export const PASSWORD_POLICY_DEFAULTS = { minLength: MIN_PASSWORD_LENGTH, upper: false, lower: false, digit: false, special: false };
const CLASSES = {
  upper: /\p{Lu}/u,
  lower: /\p{Ll}/u,
  digit: /\p{Nd}/u,
  special: /[^\p{L}\p{N}]/u, // anything that is not a letter or a digit (space, - _ ! @ ...)
};

/** The policy in force (settings may be null: the defaults). */
export async function loadPasswordPolicy(settings) {
  return { ...PASSWORD_POLICY_DEFAULTS, ...((settings ? await settings.get('password.policy', {}) : {}) ?? {}) };
}

/** Returns "scrypt$N$r$p$<salt b64>$<hash b64>". */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password.normalize('NFC'), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptAsync(password.normalize('NFC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: MAXMEM,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Compared against when the username does not exist, so a miss costs the same time as a hit.
let dummyHash;
export async function burnPasswordCheck(password) {
  dummyHash ??= await hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(password, dummyHash);
}

/**
 * Returns null if acceptable, otherwise a short reason code: too_short, too_long, missing_upper,
 * missing_lower, missing_digit, missing_special, contains_username, same_as_current.
 */
export function checkPasswordPolicy(password, { username, current, policy = PASSWORD_POLICY_DEFAULTS } = {}) {
  const p = { ...PASSWORD_POLICY_DEFAULTS, ...policy };
  if (typeof password !== 'string' || [...password].length < p.minLength) return 'too_short';
  if (password.length > 256) return 'too_long';
  for (const [name, re] of Object.entries(CLASSES)) {
    if (p[name] && !re.test(password)) return `missing_${name}`;
  }
  if (username && password.toLowerCase().includes(username.toLowerCase())) return 'contains_username';
  if (current && password === current) return 'same_as_current';
  return null;
}

/**
 * A random password for new users / resets: groups of 5 from an unambiguous alphabet, joined by "-"
 * (at least 4 groups, more when the policy asks for a longer password). Drawn again until it meets
 * the policy (upper, lower, digit; the "-" is the special character).
 */
export function generatePassword(policy = PASSWORD_POLICY_DEFAULTS) {
  const p = { ...PASSWORD_POLICY_DEFAULTS, ...policy };
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const groupCount = Math.max(4, Math.ceil((p.minLength + 1) / 6));
  for (;;) {
    const groups = [];
    for (let g = 0; g < groupCount; g++) {
      let s = '';
      for (let i = 0; i < 5; i++) s += alphabet[randomInt(alphabet.length)];
      groups.push(s);
    }
    const pw = groups.join('-');
    if (!checkPasswordPolicy(pw, { policy: { ...p, upper: true, lower: true, digit: true } })) return pw;
  }
}

/** The rules in words (Vietnamese), for the change-password page and the settings. */
export function describePasswordPolicy(policy) {
  const p = { ...PASSWORD_POLICY_DEFAULTS, ...policy };
  const need = [['upper', 'chữ hoa'], ['lower', 'chữ thường'], ['digit', 'chữ số'], ['special', 'ký tự đặc biệt (ví dụ - _ ! @ # hoặc dấu cách)']]
    .filter(([k]) => p[k]).map(([, v]) => v);
  return `Tối thiểu ${p.minLength} ký tự${need.length ? `, có ít nhất một ${need.join(', một ')}` : ''}; không chứa tên đăng nhập và khác mật khẩu hiện tại.`;
}
