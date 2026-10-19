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
    const ldap = new LdapAuthenticator({ servers: ['192.0.2.1'], protocol: 'ldaps', domain: 'corp.local', baseDn: 'DC=corp,DC=local', timeoutMs: 50 });
    await expect(ldap.authenticate('nguyenvana', '')).rejects.toMatchObject({ code: 'invalid_credentials' });
  });

  it('reports "unavailable" when no DC answers', async () => {
    // 192.0.2.0/24 is reserved for documentation: nothing listens there.
    const ldap = new LdapAuthenticator({ servers: ['192.0.2.1'], protocol: 'ldaps', domain: 'corp.local', baseDn: 'DC=corp,DC=local', timeoutMs: 300 });
    const err = await ldap.authenticate('nguyenvana', 'x').catch((e) => e);
    expect(err).toBeInstanceOf(DirectoryError);
    expect(err.code).toBe('unavailable');
  });
});

describe('LdapAuthenticator empty credentials', () => {
  it('refuses empty or non-string passwords and empty user names without any network call', async () => {
    // Servers are unreachable on purpose: reaching them would give "unavailable", not "invalid_credentials".
    const ldap = new LdapAuthenticator({ servers: ['192.0.2.1'], domain: 'corp.local', baseDn: 'DC=corp,DC=local', timeoutMs: 50 });
    for (const [sam, pw] of [['user1', ''], ['user1', undefined], ['user1', null], ['', 'x'], ['  ', 'x'], [undefined, 'x']]) {
      await expect(ldap.authenticate(sam, pw)).rejects.toMatchObject({ code: 'invalid_credentials' });
    }
  });
});

describe('LDAP_SERVERS config', () => {
  const base = {
    NODE_ENV: 'development', DATABASE_URL: 'postgres://x', SESSION_SECRET: 'x'.repeat(32), LOG_HMAC_KEY: 'a'.repeat(64),
    LDAP_DOMAIN: 'corp.local', LDAP_BASE_DN: 'DC=corp,DC=local',
  };
  it('defaults to plain ldap and flags it; ldaps and starttls are encrypted', async () => {
    const { loadConfig, ldapIsPlain } = await import('../../src/config.js');
    expect(loadConfig({ ...base, LDAP_SERVERS: 'dc1,dc2:3268' }).LDAP_SERVERS).toEqual(['dc1', 'dc2:3268']);
    expect(ldapIsPlain(loadConfig({ ...base, LDAP_SERVERS: 'dc1' }))).toBe(true);
    expect(ldapIsPlain(loadConfig({ ...base, LDAP_SERVERS: 'dc1', LDAP_PROTOCOL: 'ldaps' }))).toBe(false);
    expect(ldapIsPlain(loadConfig({ ...base, LDAP_SERVERS: 'dc1', LDAP_PROTOCOL: 'starttls' }))).toBe(false);
    expect(ldapIsPlain(loadConfig(base))).toBe(false);
  });
  it('rejects URLs and unknown protocols', async () => {
    const { loadConfig } = await import('../../src/config.js');
    expect(() => loadConfig({ ...base, LDAP_SERVERS: 'ldaps://dc1' })).toThrow();
    expect(() => loadConfig({ ...base, LDAP_SERVERS: 'dc1', LDAP_PROTOCOL: 'http' })).toThrow();
  });
  it('builds URLs with the default port of each protocol', () => {
    const mk = (protocol) => new LdapAuthenticator({ servers: ['dc1', 'dc2:3268'], protocol, domain: 'corp.local', baseDn: 'DC=corp' }).urls;
    expect(mk('ldap')).toEqual(['ldap://dc1:389', 'ldap://dc2:3268']);
    expect(mk('starttls')).toEqual(['ldap://dc1:389', 'ldap://dc2:3268']);
    expect(mk('ldaps')).toEqual(['ldaps://dc1:636', 'ldaps://dc2:3268']);
  });
});

describe('LdapAuthenticator on a plain port', () => {
  it('speaks plain LDAP (not TLS) for protocol "ldap"', async () => {
    const net = await import('node:net');
    let first = null;
    const srv = net.createServer((sock) => {
      sock.once('data', (d) => { first = d[0]; sock.destroy(); });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const ldap = new LdapAuthenticator({ servers: [`127.0.0.1:${srv.address().port}`], protocol: 'ldap', domain: 'corp.local', baseDn: 'DC=corp', timeoutMs: 1500 });
    await ldap.authenticate('user1', 'pw').catch(() => undefined);
    srv.close();
    expect(first).toBe(0x30); // an LDAP message (SEQUENCE); a TLS ClientHello would start with 0x16
  });
});

describe('SECRET_KEY config', () => {
  const base = { NODE_ENV: 'development', DATABASE_URL: 'postgres://x', SESSION_SECRET: 'x'.repeat(32) };
  it('takes SECRET_KEY, still accepts the old name LOG_HMAC_KEY, and needs one of them', async () => {
    const { loadConfig } = await import('../../src/config.js');
    expect(loadConfig({ ...base, SECRET_KEY: 'b'.repeat(64) }).SECRET_KEY).toBe('b'.repeat(64));
    expect(loadConfig({ ...base, LOG_HMAC_KEY: 'c'.repeat(64) }).SECRET_KEY).toBe('c'.repeat(64));
    expect(() => loadConfig(base)).toThrow(/SECRET_KEY/);
    expect(() => loadConfig({ ...base, SECRET_KEY: 'short' })).toThrow();
  });
});
