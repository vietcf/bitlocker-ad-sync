import { describe, expect, it } from 'vitest';
import { DirectoryError, LdapAuthenticator, guidFromBuffer } from '../../src/modules/auth/ldap.client.js';
import { normalizeUsername } from '../../src/modules/auth/auth.service.js';

describe('guidFromBuffer', () => {
  it('converts AD objectGUID bytes (first three groups little-endian) to the usual text form', () => {
    // {01234567-89AB-CDEF-0123-456789ABCDEF} is stored as 67 45 23 01 AB 89 EF CD 01 23 45 67 89 AB CD EF
    const bytes = Buffer.from('67452301ab89efcd0123456789abcdef', 'hex');
    expect(guidFromBuffer(bytes)).toBe('01234567-89ab-cdef-0123-456789abcdef');
  });
});

describe('normalizeUsername', () => {
  it('strips DOMAIN\\ and @domain (only for the configured domain)', () => {
    expect(normalizeUsername('CORP\\nguyenvana', 'corp.local')).toBe('nguyenvana');
    expect(normalizeUsername('nguyenvana@CORP.LOCAL', 'corp.local')).toBe('nguyenvana');
    expect(normalizeUsername('nguyenvana@other.com', 'corp.local')).toBe('nguyenvana@other.com');
    expect(normalizeUsername('  admin  ', 'corp.local')).toBe('admin');
  });
});

describe('LdapAuthenticator', () => {
  it('refuses an empty password before contacting AD (AD treats it as an anonymous bind)', async () => {
    const ldap = new LdapAuthenticator({ urls: ['ldaps://192.0.2.1:636'], domain: 'corp.local', baseDn: 'DC=corp,DC=local', timeoutMs: 50 });
    await expect(ldap.authenticate('nguyenvana', '')).rejects.toMatchObject({ code: 'invalid_credentials' });
  });

  it('reports "unavailable" when no DC answers', async () => {
    // 192.0.2.0/24 is reserved for documentation: nothing listens there.
    const ldap = new LdapAuthenticator({ urls: ['ldaps://192.0.2.1:636'], domain: 'corp.local', baseDn: 'DC=corp,DC=local', timeoutMs: 300 });
    const err = await ldap.authenticate('nguyenvana', 'x').catch((e) => e);
    expect(err).toBeInstanceOf(DirectoryError);
    expect(err.code).toBe('unavailable');
  });
});
