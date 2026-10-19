package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func valid() Config {
	c := defaults()
	c.Ldap.Servers = []string{"dc01.corp.local"}
	c.Ldap.BaseDn = "DC=corp,DC=local"
	c.Ldap.Username = "svc-blk@corp.local"
	c.Ldap.Password = "x"
	c.Ingest.BaseUrl = "https://blk.corp.local:8443/api/ingest"
	c.Ingest.ApiKey = "a-key"
	return c
}

func has(errs []string, part string) bool {
	for _, e := range errs {
		if strings.Contains(e, part) {
			return true
		}
	}
	return false
}

func TestAcceptsLdapsAndStartTLSWithUsernameAndPassword(t *testing.T) {
	for _, p := range []string{"Ldaps", "StartTls", "ldaps"} {
		c := valid()
		c.Ldap.Protocol = p
		if errs := c.Validate(); len(errs) > 0 {
			t.Errorf("%s: %v", p, errs)
		}
	}
}

func TestDefaultsToPlainLDAPOn389WithoutAnyExtraSwitch(t *testing.T) {
	c := valid()
	if c.Ldap.ProtocolValue() != "Ldap" || c.Ldap.EffectivePort() != 389 {
		t.Error("defaults")
	}
	if errs := c.Validate(); len(errs) > 0 {
		t.Error(errs)
	}
	c.Ldap.Protocol = "Ldaps"
	if c.Ldap.EffectivePort() != 636 {
		t.Error("Ldaps port")
	}
	c.Ldap.Protocol = "Tls"
	if !has(c.Validate(), "Ldap.Protocol must be") {
		t.Error("unknown protocol must be refused")
	}
}

func TestRequiresUsernamePasswordServersAndBaseDN(t *testing.T) {
	c := valid()
	c.Ldap.Password = ""
	c.Ldap.Servers = nil
	c.Ldap.BaseDn = ""
	errs := c.Validate()
	if !has(errs, "Username and Ldap.Password") || !has(errs, "Servers") || !has(errs, "BaseDn") {
		t.Error(errs)
	}
}

func TestRefusesNegotiate(t *testing.T) {
	c := valid()
	c.Ldap.Auth = "Negotiate"
	if !has(c.Validate(), "Negotiate") {
		t.Error("Negotiate must be refused")
	}
}

func TestRefusesAnOUOutsideTheBaseDN(t *testing.T) {
	c := valid()
	c.Ldap.SearchBases = []string{"OU=HN,DC=other,DC=local"}
	if !has(c.Validate(), "not inside Ldap.BaseDn") {
		t.Error("OU outside BaseDn")
	}
}

func TestIngestNeedsHTTPSAndCredentialsOutsideLocalhost(t *testing.T) {
	cases := []struct {
		url, key string
		ok       bool
	}{
		{"http://localhost:8443/api/ingest", "", true},
		{"http://127.0.0.1:8443/api/ingest", "", true},
		{"http://blk.corp.local:8443/api/ingest", "key", false},
		{"https://blk.corp.local:8443/api/ingest", "", false},
		{"https://blk.corp.local:8443/api/ingest", "a-key", true},
	}
	for _, tc := range cases {
		c := valid()
		c.Ingest.BaseUrl, c.Ingest.ApiKey = tc.url, tc.key
		if ok := len(c.Validate()) == 0; ok != tc.ok {
			t.Errorf("%s key=%q: ok=%v, errors %v", tc.url, tc.key, ok, c.Validate())
		}
	}
}

func TestReadsAppsettingsStyleJSONWithCommentsAndEnvironmentOverrides(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	os.WriteFile(path, []byte(`{
  // comment
  "Ldap": { "Servers": [ "dc01.corp.local", ], "BaseDn": "DC=corp,DC=local", /* block */ "Username": "u@corp.local", "Password": "http://not-a-comment" },
  "Ingest": { "BaseUrl": "https://blk.corp.local:8443/api/ingest", "ApiKey": "k" },
  "Schedule": { "StateFile": "state.json" },
}`), 0o600)
	c, err := Load(path, []string{"Ldap__Password=from-env", "LDAP__SERVERS=dc02.corp.local, dc03.corp.local", "Schedule__DeltaEveryMinutes=7", "PATH=/bin"})
	if err != nil {
		t.Fatal(err)
	}
	if c.Ldap.Password != "from-env" || len(c.Ldap.Servers) != 2 || c.Ldap.Servers[1] != "dc03.corp.local" || c.Schedule.DeltaEveryMinutes != 7 {
		t.Errorf("%+v", c.Ldap)
	}
	if c.Resolve(c.Schedule.StateFile) != filepath.Join(dir, "state.json") {
		t.Error("relative paths are taken from the config folder")
	}
	if c.Schedule.FullAtMinutes() != 60 {
		t.Error("FullAt 01:00")
	}
}

func TestKeepsSlashesInsideStrings(t *testing.T) {
	got := string(StripJSONComments([]byte(`{"a":"x//y","b":"/*z*/"} // c`)))
	if got != `{"a":"x//y","b":"/*z*/"} ` {
		t.Errorf("%q", got)
	}
}

func TestRevealsSecretsFromFilesEnvironmentAndSystemdCredentials(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "pw"), []byte("s3cret\n"), 0o600)
	if v, _ := Reveal("file:" + filepath.Join(dir, "pw")); v != "s3cret" {
		t.Error("file:", v)
	}
	t.Setenv("BLK_TEST_SECRET", "from-env")
	if v, _ := Reveal("env:BLK_TEST_SECRET"); v != "from-env" {
		t.Error("env:", v)
	}
	t.Setenv("CREDENTIALS_DIRECTORY", dir)
	if v, _ := Reveal("cred:pw"); v != "s3cret" {
		t.Error("cred:", v)
	}
	if v, _ := Reveal("plain"); v != "plain" {
		t.Error("plain")
	}
	if _, err := Reveal("dpapi:AAAA"); err == nil {
		t.Error("dpapi: must be refused")
	}
	if _, err := Reveal("env:BLK_TEST_NOT_SET_" + t.Name()); err == nil {
		t.Error("missing env must fail")
	}
}

func TestExcludeOperatingSystemsIsOptionalAndValidated(t *testing.T) {
	c := valid()
	if errs := c.Validate(); len(errs) > 0 || len(c.Ldap.EffectiveExcludeOS()) != 0 {
		t.Errorf("default must be empty and valid: %v", errs)
	}
	c.Ldap.ExcludeOperatingSystems = []string{" Windows Server* ", "windows server*", ""}
	if errs := c.Validate(); len(errs) > 0 {
		t.Errorf("valid patterns refused: %v", errs)
	}
	if got := c.Ldap.EffectiveExcludeOS(); len(got) != 1 || got[0] != "Windows Server*" {
		t.Errorf("EffectiveExcludeOS = %v", got)
	}
	c.Ldap.ExcludeOperatingSystems = []string{"*"}
	if errs := c.Validate(); !has(errs, "ExcludeOperatingSystems") {
		t.Errorf("a lone * would exclude every computer: %v", errs)
	}
	c.Ldap.ExcludeOperatingSystems = []string{strings.Repeat("a", 129)}
	if errs := c.Validate(); !has(errs, "ExcludeOperatingSystems") {
		t.Errorf("a too long pattern must be refused: %v", errs)
	}
}

func TestReadsExcludeOperatingSystemsFromJSONAndEnvironment(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	json := `{ "Ldap": { "Source": "Ldap", "Servers": ["dc01"], "BaseDn": "DC=corp,DC=local", "Username": "u", "Password": "p",
	  "ExcludeOperatingSystems": ["Windows Server*"] }, "Ingest": { "BaseUrl": "https://blk.corp.local:8443/api/ingest", "ApiKey": "k" } }`
	if err := os.WriteFile(path, []byte(json), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := Load(path, []string{"PATH=/bin"})
	if err != nil {
		t.Fatal(err)
	}
	if got := c.Ldap.EffectiveExcludeOS(); len(got) != 1 || got[0] != "Windows Server*" {
		t.Errorf("from JSON: %v", got)
	}
	c, err = Load(path, []string{"Ldap__ExcludeOperatingSystems=Ubuntu*, Windows Server*", "PATH=/bin"})
	if err != nil {
		t.Fatal(err)
	}
	if got := c.Ldap.EffectiveExcludeOS(); len(got) != 2 || got[0] != "Ubuntu*" {
		t.Errorf("from environment: %v", got)
	}
}
