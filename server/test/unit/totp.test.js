import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, codeAt, otpauthUri, verifyCode } from '../../src/modules/auth/totp.js';

// RFC 6238 appendix B (SHA1): secret "12345678901234567890"; the last 6 of the 8-digit values.
const SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('totp', () => {
  it('matches the RFC 6238 test vectors', () => {
    expect(SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(codeAt(SECRET, Math.floor(59 / 30))).toBe('287082');
    expect(codeAt(SECRET, Math.floor(1111111109 / 30))).toBe('081804');
    expect(codeAt(SECRET, Math.floor(1234567890 / 30))).toBe('005924');
    expect(codeAt(SECRET, Math.floor(2000000000 / 30))).toBe('279037');
  });

  it('round-trips base32', () => {
    const buf = Buffer.from([0, 1, 2, 250, 255, 7, 9]);
    expect(base32Decode(base32Encode(buf))).toEqual(buf);
  });

  it('accepts one step of drift, refuses a reused step and anything not 6 digits', () => {
    const now = 1111111109 * 1000;
    const step = Math.floor(1111111109 / 30);
    expect(verifyCode(SECRET, '081804', { now })).toBe(step);
    expect(verifyCode(SECRET, '081 804', { now })).toBe(step);
    expect(verifyCode(SECRET, codeAt(SECRET, step - 1), { now })).toBe(step - 1);
    expect(verifyCode(SECRET, codeAt(SECRET, step - 2), { now })).toBeNull();
    expect(verifyCode(SECRET, '081804', { now, lastStep: step })).toBeNull(); // used once already
    expect(verifyCode(SECRET, '81804', { now })).toBeNull();
  });

  it('builds the otpauth link the apps scan', () => {
    expect(otpauthUri({ issuer: 'BitLocker Keys', account: 'admin', secret: SECRET }))
      .toBe('otpauth://totp/BitLocker%20Keys%3Aadmin?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=BitLocker+Keys&algorithm=SHA1&digits=6&period=30');
  });
});
