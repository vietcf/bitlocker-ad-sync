import { describe, expect, it } from 'vitest';
import { checkPasswordPolicy, generatePassword, hashPassword, verifyPassword } from '../../src/modules/auth/password.js';

describe('password hashing', () => {
  it('verifies the right password and rejects others', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('correct horse batterY', h)).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('rejects a malformed stored hash instead of throwing', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
  });
});

describe('password policy', () => {
  it('requires 12+ characters, no username, and a change', () => {
    expect(checkPasswordPolicy('short')).toBe('too_short');
    expect(checkPasswordPolicy('admin-is-my-password', { username: 'admin' })).toBe('contains_username');
    expect(checkPasswordPolicy('same-password-123', { current: 'same-password-123' })).toBe('same_as_current');
    expect(checkPasswordPolicy('a-good-long-passphrase', { username: 'it.hn' })).toBeNull();
  });

  it('applies the configured length and character classes', () => {
    const policy = { minLength: 16, upper: true, lower: true, digit: true, special: true };
    expect(checkPasswordPolicy('only-lower-case-x', { policy })).toBe('missing_upper');
    expect(checkPasswordPolicy('No-Digits-In-Here', { policy })).toBe('missing_digit');
    expect(checkPasswordPolicy('NoSpecial123456789', { policy })).toBe('missing_special');
    expect(checkPasswordPolicy('ALL-UPPER-123456', { policy })).toBe('missing_lower');
    expect(checkPasswordPolicy('Short-1a', { policy })).toBe('too_short');
    expect(checkPasswordPolicy('Đây là Mật khẩu 2026', { policy })).toBeNull(); // Vietnamese letters count
    expect(checkPasswordPolicy('abcdefgh', { policy: { minLength: 8 } })).toBeNull();
  });

  it('generates one-time passwords that meet a strict, long policy', () => {
    const policy = { minLength: 40, upper: true, lower: true, digit: true, special: true };
    for (let i = 0; i < 20; i += 1) expect(checkPasswordPolicy(generatePassword(policy), { policy })).toBeNull();
  });

  it('generates passwords that pass the policy', () => {
    const p = generatePassword();
    expect(p).toMatch(/^[A-Za-z2-9]{5}(-[A-Za-z2-9]{5}){3}$/);
    expect(checkPasswordPolicy(p)).toBeNull();
  });
});
