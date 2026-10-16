package directory

import (
	"encoding/hex"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestParsesADGeneralizedTimeAsUTC(t *testing.T) {
	want := time.Date(2026, 10, 12, 8, 13, 55, 0, time.UTC)
	for _, v := range []string{"20261012081355.0Z", "20261012081355Z"} {
		got := ParseGeneralizedTime(v)
		if got == nil || !got.Equal(want) {
			t.Errorf("%s: got %v", v, got)
		}
	}
	if ParseGeneralizedTime("yesterday") != nil {
		t.Error("unparsable time must be nil")
	}
}

// The same bytes and expectation as the .NET test: AD stores the first three groups little-endian.
func TestConvertsADBinaryGUIDsLikeTheRestOfWindows(t *testing.T) {
	b, _ := hex.DecodeString("67452301AB89EFCD0123456789ABCDEF")
	g, err := GUIDFromAD(b)
	if err != nil || g.String() != "01234567-89ab-cdef-0123-456789abcdef" {
		t.Fatalf("got %s %v", g, err)
	}
	if _, err := GUIDFromAD(b[:15]); err == nil {
		t.Error("15 bytes must be refused")
	}
	p, _ := ParseGUID("{01234567-89AB-CDEF-0123-456789ABCDEF}")
	if p != g {
		t.Error("ParseGUID must read the text form")
	}
}

func TestFindsTheParentDN(t *testing.T) {
	cases := map[string]string{
		"CN={GUID},CN=HN-LT-0231,OU=Laptops,DC=corp,DC=local": "CN=HN-LT-0231,OU=Laptops,DC=corp,DC=local",
		`CN=Nguyen\, Van A,OU=Users,DC=corp`:                  "OU=Users,DC=corp",
		"DC=local":                                            "",
	}
	for dn, want := range cases {
		if got := ParentDN(dn); got != want {
			t.Errorf("ParentDN(%q) = %q, want %q", dn, got, want)
		}
	}
}

func TestEscapesLDAPFilterValues(t *testing.T) {
	if got := EscapeFilterValue(`a*(b)\`); got != `a\2a\28b\29\5c` {
		t.Error(got)
	}
}

func TestDirectoryKeyNeverPrintsItsPassword(t *testing.T) {
	k := RecoveryKey{KeyID: GUID{1}, DN: "CN=x", RecoveryPassword: "123456-234567", WhenCreated: time.Now()}
	for _, s := range []string{fmt.Sprint(k), fmt.Sprintf("%v", k), fmt.Sprintf("%#v", k), fmt.Sprintf("%+v", k)} {
		if strings.Contains(s, "123456") || !strings.Contains(s, "[REDACTED]") {
			t.Errorf("printed: %s", s)
		}
	}
}

func TestEmptySearchBasesMeanTheWholeDomain(t *testing.T) {
	if got := EffectiveSearchBases(nil, "DC=corp,DC=local"); !slices.Equal(got, []string{"DC=corp,DC=local"}) {
		t.Error(got)
	}
}

func TestKeepsTheConfiguredOrderAndDropsDuplicatesAndNestedOUs(t *testing.T) {
	got := EffectiveSearchBases([]string{
		"OU=HCM,DC=corp,DC=local",
		"OU=Laptops, OU=HN,DC=corp,DC=local", // nested in OU=HN below
		"OU=HN,DC=corp,DC=local",
		"ou=hcm,dc=corp,dc=local", // duplicate (case)
		" ",
	}, "DC=corp,DC=local")
	want := []string{"OU=HCM,DC=corp,DC=local", "OU=HN,DC=corp,DC=local"}
	if !slices.Equal(got, want) {
		t.Errorf("got %v", got)
	}
}

func TestIsWithin(t *testing.T) {
	if !IsWithin("OU=HN, DC=corp,DC=local", "dc=corp,dc=local") || IsWithin("OU=HN,DC=other,DC=local", "DC=corp,DC=local") {
		t.Error("IsWithin")
	}
}

func TestAnUnreadableOUHasItsOwnErrorCode(t *testing.T) {
	if NewError(SearchBaseFailed, "x", nil).APIErrorCode() != "ldap_search_base_failed" ||
		NewError(BindFailed, "x", nil).APIErrorCode() != "ldap_bind_failed" ||
		NewError(TLSFailed, "x", nil).APIErrorCode() != "ldap_tls_failed" {
		t.Error("error codes")
	}
}
