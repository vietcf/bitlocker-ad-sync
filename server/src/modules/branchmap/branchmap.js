/**
 * Normalises a DN for comparison: lower-case, no spaces around RDN separators.
 * Escaped commas ("\,") inside a CN are left intact.
 */
export function normalizeDn(dn) {
  return dn
    .trim()
    .toLowerCase()
    .replace(/(?<!\\)\s*,\s*/g, ',')
    .replace(/\s*=\s*/g, '=');
}

/**
 * Maps a computer DN to a branch id. `ous` is a list of { branchId, rootDn }.
 * The longest root OU that is the DN's parent chain wins, so a nested OU owned by
 * another branch overrides its ancestor. No match => null (unmapped).
 */
export function branchForDn(dn, ous) {
  const d = normalizeDn(dn);
  let best = null;
  let bestLen = -1;
  for (const ou of ous) {
    const root = normalizeDn(ou.rootDn);
    if ((d === root || d.endsWith(`,${root}`)) && root.length > bestLen) {
      best = ou;
      bestLen = root.length;
    }
  }
  return best ? best.branchId : null;
}

/** DN of the object's parent: drops the first RDN (handles escaped commas). */
export function parentDn(dn) {
  const m = /^(?:\\.|[^,\\])*,(.*)$/s.exec(dn.trim());
  return m?.[1]?.trim() ?? '';
}
