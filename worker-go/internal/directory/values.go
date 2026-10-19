package directory

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// GUID in its usual text form (lower case, 8-4-4-4-12).
type GUID [16]byte

// GUIDFromAD converts an AD binary GUID (objectGUID, msFVE-RecoveryGuid, msFVE-VolumeGuid).
// AD stores the first three groups little-endian, like Windows' GUID struct:
// {01234567-89AB-CDEF-0123-456789ABCDEF} is the bytes 67 45 23 01 AB 89 EF CD 01 23 45 67 89 AB CD EF.
// Getting this wrong would make every computer look new to the server, so it is tested.
func GUIDFromAD(b []byte) (GUID, error) {
	var g GUID
	if len(b) != 16 {
		return g, fmt.Errorf("expected 16 bytes, got %d", len(b))
	}
	g[0], g[1], g[2], g[3] = b[3], b[2], b[1], b[0]
	g[4], g[5] = b[5], b[4]
	g[6], g[7] = b[7], b[6]
	copy(g[8:], b[8:])
	return g, nil
}

// ParseGUID reads "01234567-89ab-cdef-0123-456789abcdef" (braces and case ignored).
func ParseGUID(s string) (GUID, error) {
	var g GUID
	h := strings.ReplaceAll(strings.Trim(strings.TrimSpace(s), "{}"), "-", "")
	if len(h) != 32 {
		return g, fmt.Errorf("invalid GUID %q", s)
	}
	b, err := hex.DecodeString(h)
	if err != nil {
		return g, fmt.Errorf("invalid GUID %q", s)
	}
	copy(g[:], b)
	return g, nil
}

func (g GUID) String() string {
	h := hex.EncodeToString(g[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

func (g GUID) MarshalJSON() ([]byte, error) { return json.Marshal(g.String()) }

func (g *GUID) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return err
	}
	v, err := ParseGUID(s)
	if err != nil {
		return err
	}
	*g = v
	return nil
}

// ParseGeneralizedTime reads "20261012081355.0Z" (AD Generalized Time, UTC); nil if unparsable.
func ParseGeneralizedTime(v string) *time.Time {
	v = strings.TrimSpace(v)
	if v == "" {
		return nil
	}
	for _, layout := range []string{"20060102150405.0Z", "20060102150405Z"} {
		if t, err := time.Parse(layout, v); err == nil {
			t = t.UTC()
			return &t
		}
	}
	return nil
}

// NormalizeDN: "OU=A, OU=B,DC=x" -> "ou=a,ou=b,dc=x": lower case, no spaces around commas or '='.
func NormalizeDN(dn string) string {
	rdns := strings.Split(dn, ",")
	for i, rdn := range rdns {
		parts := strings.Split(rdn, "=")
		for j, p := range parts {
			parts[j] = strings.TrimSpace(p)
		}
		rdns[i] = strings.ToLower(strings.Join(parts, "="))
	}
	return strings.Join(rdns, ",")
}

// EffectiveSearchBases returns the OUs to read, in the configured order: duplicates dropped, and
// an OU that sits inside another listed OU dropped too (the subtree search of the outer one
// already covers it), so no object is read twice. Empty list = the whole domain (baseDN).
func EffectiveSearchBases(searchBases []string, baseDN string) []string {
	var bases []string
	for _, b := range searchBases {
		if strings.TrimSpace(b) != "" {
			bases = append(bases, strings.TrimSpace(b))
		}
	}
	if len(bases) == 0 {
		return []string{baseDN}
	}
	normalized := make([]string, len(bases))
	for i, b := range bases {
		normalized[i] = NormalizeDN(b)
	}
	var result []string
	kept := map[string]bool{}
	for i, n := range normalized {
		if kept[n] {
			continue // duplicate
		}
		kept[n] = true
		nested := false
		for j, other := range normalized {
			if j != i && other != n && strings.HasSuffix(n, ","+other) {
				nested = true
				break
			}
		}
		if !nested {
			result = append(result, bases[i])
		}
	}
	return result
}

// IsWithin reports whether dn is baseDN or inside it.
func IsWithin(dn, baseDN string) bool {
	d, b := NormalizeDN(dn), NormalizeDN(baseDN)
	return d == b || strings.HasSuffix(d, ","+b)
}

// ParentDN drops the first RDN, respecting escaped commas ("\,").
func ParentDN(dn string) string {
	for i := 0; i < len(dn); i++ {
		if dn[i] == '\\' {
			i++
			continue
		}
		if dn[i] == ',' {
			return strings.TrimLeft(dn[i+1:], " ")
		}
	}
	return ""
}

// CleanOSPatterns trims the operating-system patterns, drops empty ones and duplicates (case-insensitive).
func CleanOSPatterns(list []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, p := range list {
		p = strings.TrimSpace(p)
		if p == "" || seen[strings.ToLower(p)] {
			continue
		}
		seen[strings.ToLower(p)] = true
		out = append(out, p)
	}
	return out
}

// EscapeFilterPattern escapes a filter value but keeps "*" as the wildcard ("Windows Server*").
func EscapeFilterPattern(p string) string {
	parts := strings.Split(p, "*")
	for i := range parts {
		parts[i] = EscapeFilterValue(parts[i])
	}
	return strings.Join(parts, "*")
}

// ComputerFilter selects computer objects, leaving out those whose operatingSystem matches a pattern.
// A computer with no operatingSystem attribute is kept. No patterns: every computer.
func ComputerFilter(excludeOS []string) string {
	excludeOS = CleanOSPatterns(excludeOS)
	if len(excludeOS) == 0 {
		return "(objectCategory=computer)"
	}
	var b strings.Builder
	b.WriteString("(&(objectCategory=computer)")
	for _, p := range excludeOS {
		b.WriteString("(!(operatingSystem=" + EscapeFilterPattern(p) + "))")
	}
	b.WriteString(")")
	return b.String()
}

// ExcludedComputerFilter selects the computers ComputerFilter leaves out (used to drop their recovery keys).
func ExcludedComputerFilter(excludeOS []string) string {
	excludeOS = CleanOSPatterns(excludeOS)
	var b strings.Builder
	b.WriteString("(&(objectCategory=computer)(|")
	for _, p := range excludeOS {
		b.WriteString("(operatingSystem=" + EscapeFilterPattern(p) + ")")
	}
	b.WriteString("))")
	return b.String()
}

// IsKeyOfExcluded reports whether a recovery object (a child of its computer) belongs to a computer in the
// excluded set (keys of DNs in lower case).
func IsKeyOfExcluded(excluded map[string]struct{}, keyDN string) bool {
	if len(excluded) == 0 {
		return false
	}
	_, ok := excluded[strings.ToLower(ParentDN(keyDN))]
	return ok
}

// EscapeFilterValue escapes a value for use inside an LDAP filter (RFC 4515).
func EscapeFilterValue(v string) string {
	var b strings.Builder
	for _, c := range v {
		switch c {
		case '\\':
			b.WriteString(`\5c`)
		case '*':
			b.WriteString(`\2a`)
		case '(':
			b.WriteString(`\28`)
		case ')':
			b.WriteString(`\29`)
		case 0:
			b.WriteString(`\00`)
		default:
			b.WriteRune(c)
		}
	}
	return b.String()
}
