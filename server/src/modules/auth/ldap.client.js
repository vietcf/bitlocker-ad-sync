import { readFileSync } from 'node:fs';
import { AndFilter, Client, EqualityFilter, InvalidCredentialsError } from 'ldapts';

/** AD stores objectGUID with the first three groups little-endian. */
export function guidFromBuffer(b) {
  const h = Buffer.from(b).toString('hex');
  return [
    h.slice(6, 8) + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2),
    h.slice(10, 12) + h.slice(8, 10),
    h.slice(14, 16) + h.slice(12, 14),
    h.slice(16, 20),
    h.slice(20, 32),
  ].join('-');
}

export class DirectoryError extends Error {
  /** code: 'invalid_credentials' | 'unavailable' | 'not_found' */
  constructor(code, message) {
    super(message ?? code);
    this.code = code;
  }
}

/**
 * Checks a user's Active Directory password by binding AS THAT USER over LDAPS (no service
 * account needed), then reads the user's own entry with the same connection.
 * AD itself refuses disabled, locked and expired accounts at bind time.
 * Tries each URL in turn (several DCs) when one cannot be reached.
 */
export class LdapAuthenticator {
  /** servers: host or host:port; protocol: ldap (389, clear text) | starttls (389 + TLS) | ldaps (636) */
  constructor({ servers, protocol = 'ldap', domain, baseDn, caFile, timeoutMs = 8000 }) {
    this.protocol = protocol;
    const scheme = protocol === 'ldaps' ? 'ldaps' : 'ldap';
    this.urls = servers.map((s) => (/:[0-9]+$/.test(s) ? `${scheme}://${s}` : `${scheme}://${s}:${protocol === 'ldaps' ? 636 : 389}`));
    this.domain = domain; // e.g. corp.local: binds as sam@corp.local (AD's implicit UPN)
    this.baseDn = baseDn; // e.g. DC=corp,DC=local
    this.tlsOptions = { minVersion: 'TLSv1.2', ...(caFile ? { ca: [readFileSync(caFile)] } : {}) };
    this.timeoutMs = timeoutMs;
  }

  /** Returns { objectGuid, sam, upn, displayName, mail }; throws DirectoryError. */
  async authenticate(sam, password) {
    // An empty password makes an "unauthenticated bind", which AD reports as SUCCESS.
    // Same for an empty user name ("@domain" with no password check). Both are refused before any network call.
    if (typeof sam !== 'string' || sam.trim() === '') throw new DirectoryError('invalid_credentials');
    if (typeof password !== 'string' || password.length === 0) throw new DirectoryError('invalid_credentials');

    let lastError = null;
    for (const url of this.urls) {
      // tlsOptions only for ldaps: ldapts switches to TLS whenever it is set, even on an ldap:// URL.
      const client = new Client({ url, timeout: this.timeoutMs, connectTimeout: this.timeoutMs, ...(this.protocol === 'ldaps' ? { tlsOptions: this.tlsOptions } : {}) });
      try {
        if (this.protocol === 'starttls') await client.startTLS(this.tlsOptions);
        await client.bind(`${sam}@${this.domain}`, password);
        const { searchEntries } = await client.search(this.baseDn, {
          scope: 'sub',
          filter: new AndFilter({
            filters: [new EqualityFilter({ attribute: 'objectCategory', value: 'person' }), new EqualityFilter({ attribute: 'sAMAccountName', value: sam })],
          }),
          attributes: ['objectGUID', 'sAMAccountName', 'userPrincipalName', 'displayName', 'mail'],
          explicitBufferAttributes: ['objectGUID'],
          sizeLimit: 2,
        });
        if (searchEntries.length !== 1) throw new DirectoryError('not_found', 'user entry not found after bind');
        const e = searchEntries[0];
        return {
          objectGuid: guidFromBuffer(e.objectGUID),
          sam: String(e.sAMAccountName),
          upn: e.userPrincipalName ? String(e.userPrincipalName) : null,
          displayName: e.displayName ? String(e.displayName) : null,
          mail: e.mail ? String(e.mail) : null,
        };
      } catch (err) {
        if (err instanceof InvalidCredentialsError) throw new DirectoryError('invalid_credentials');
        if (err instanceof DirectoryError) throw err;
        lastError = err; // unreachable DC, TLS failure, timeout: try the next one
      } finally {
        await client.unbind().catch(() => undefined);
      }
    }
    throw new DirectoryError('unavailable', lastError?.message ?? 'no LDAP server configured');
  }
}
