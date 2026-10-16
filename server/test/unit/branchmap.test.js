import { describe, expect, it } from 'vitest';
import { branchForDn, normalizeDn, parentDn } from '../../src/modules/branchmap/branchmap.js';

const ous = [
  { branchId: 1, rootDn: 'ou=computers,ou=hn,dc=corp,dc=local' },
  { branchId: 2, rootDn: 'ou=computers,ou=hcm,dc=corp,dc=local' },
  // A nested OU handed to another branch overrides its ancestor.
  { branchId: 3, rootDn: 'ou=haiphong,ou=computers,ou=hn,dc=corp,dc=local' },
];

describe('branchForDn', () => {
  it('maps a computer in a sub-OU to the branch of its root OU', () => {
    expect(branchForDn('CN=HN-LT-0231,OU=Laptops,OU=Computers,OU=HN,DC=corp,DC=local', ous)).toBe(1);
  });

  it('is case-insensitive and tolerates spaces after commas', () => {
    expect(branchForDn('cn=x, ou=Computers, OU=HCM, dc=CORP, dc=local', ous)).toBe(2);
  });

  it('prefers the longest matching root', () => {
    expect(branchForDn('CN=HP-01,OU=HaiPhong,OU=Computers,OU=HN,DC=corp,DC=local', ous)).toBe(3);
  });

  it('returns null when no root matches', () => {
    expect(branchForDn('CN=SRV1,OU=Servers,DC=corp,DC=local', ous)).toBeNull();
  });

  it('does not match a sibling OU that only shares a suffix string', () => {
    expect(branchForDn('CN=x,OU=XComputers,OU=HN,DC=corp,DC=local', ous)).toBeNull();
  });
});

describe('parentDn', () => {
  it('drops the first RDN', () => {
    expect(parentDn('CN={GUID},CN=HN-LT-0231,OU=Laptops,DC=corp,DC=local')).toBe('CN=HN-LT-0231,OU=Laptops,DC=corp,DC=local');
  });

  it('keeps escaped commas inside the first RDN together', () => {
    expect(parentDn('CN=Nguyen\\, Van A,OU=Users,DC=corp')).toBe('OU=Users,DC=corp');
  });
});

describe('normalizeDn', () => {
  it('keeps escaped commas', () => {
    expect(normalizeDn('CN=A\\, B , OU=X')).toBe('cn=a\\, b,ou=x');
  });
});
