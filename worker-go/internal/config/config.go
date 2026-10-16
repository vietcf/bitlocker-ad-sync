// Package config reads the worker configuration: a JSON file with the same sections and names as
// the .NET worker's appsettings.json (Ldap, Ingest, Schedule), comments allowed, plus environment
// overrides in the .NET style (Ldap__Password=..., Ingest__ApiKey=...).
package config

import (
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"strings"

	"github.com/bitlocker-management/worker-go/internal/directory"
)

type Ldap struct {
	// Ldap (real AD) | JsonFile (development only: reads JsonFilePath).
	Source string
	// DC host names, tried in order: the first is the pinned DC, the rest are fallbacks.
	Servers []string
	// Ldap (389, default: unencrypted, for a trusted network) | Ldaps (636) | StartTls (389 + TLS).
	// Ldaps / StartTls need a TLS certificate on the DC.
	Protocol string
	// Defaults to 636 for Ldaps, 389 otherwise.
	Port *int
	// Basic (simple bind with Username/Password) is the only kind in the Go worker.
	Auth string
	// UPN (svc-blk@corp.local), DOMAIN\user or DN.
	Username string
	// Plain text (development), or "file:/path", "env:NAME", "cred:NAME" (see Reveal).
	Password       string
	BaseDn         string
	SearchBases    []string
	PageSize       int
	TimeoutSeconds int
	// Deprecated, ignored: plain LDAP is allowed (and the default) since 1.0.0. Kept so old files still load.
	AllowInsecure bool
	// Lab only: accept any DC certificate.
	SkipCertificateValidation bool
	// PEM file of the CA that issued the DC certificate (added to the system store).
	CaFile       string
	JsonFilePath string
}

type Ingest struct {
	// e.g. https://blk.corp.local:8443/api/ingest
	BaseUrl string
	// The worker's only credential: sent as Authorization: Bearer over HTTPS. Same forms as Ldap.Password.
	ApiKey string
	// PEM file of the CA that issued the server's HTTPS certificate, if the system store does not trust it.
	CaFile                    string
	TimeoutSeconds            int
	BatchSize                 int
	RetryForMinutes           int
	SkipCertificateValidation bool
}

type Schedule struct {
	DeltaEveryMinutes     int
	FullAt                string // local HH:mm
	HeartbeatEveryMinutes int
	WorkerId              string // defaults to the host name
	StateFile             string // small JSON file (DC, invocationId, last full date). No secrets.
}

type Logging struct {
	Level  string // Debug | Information | Warning | Error
	Format string // text | json
}

// Config is the whole file.
type Config struct {
	Ldap     Ldap
	Ingest   Ingest
	Schedule Schedule
	Logging  Logging

	// Dir is the folder of the config file: relative paths are taken from it.
	Dir string `json:"-"`
}

func defaults() Config {
	return Config{
		Ldap:     Ldap{Source: "Ldap", Protocol: "Ldap", Auth: "Basic", PageSize: 1000, TimeoutSeconds: 60, JsonFilePath: "sample-directory.json"},
		Ingest:   Ingest{TimeoutSeconds: 60, BatchSize: 500, RetryForMinutes: 60},
		Schedule: Schedule{DeltaEveryMinutes: 15, FullAt: "01:00", HeartbeatEveryMinutes: 5, StateFile: "/var/lib/blk-sync/state.json"},
		Logging:  Logging{Level: "Information", Format: "text"},
	}
}

// Load reads the file, applies environment overrides and validates. env is os.Environ()-shaped.
func Load(path string, env []string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	c := defaults()
	if err := json.Unmarshal(StripJSONComments(raw), &c); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	abs, _ := filepath.Abs(path)
	c.Dir = filepath.Dir(abs)
	if err := applyEnv(&c, env); err != nil {
		return nil, err
	}
	if errs := c.Validate(); len(errs) > 0 {
		return nil, fmt.Errorf("invalid configuration:\n  - %s", strings.Join(errs, "\n  - "))
	}
	return &c, nil
}

// Resolve makes a relative path relative to the config file's folder.
func (c *Config) Resolve(p string) string {
	if p == "" || filepath.IsAbs(p) {
		return p
	}
	return filepath.Join(c.Dir, p)
}

// EffectivePort: Port, or 636 for Ldaps, 389 otherwise.
func (l Ldap) EffectivePort() int {
	if l.Port != nil {
		return *l.Port
	}
	if strings.EqualFold(l.Protocol, "Ldaps") {
		return 636
	}
	return 389
}

// ProtocolValue is the protocol as the directory package names it.
func (l Ldap) ProtocolValue() directory.Protocol {
	switch strings.ToLower(l.Protocol) {
	case "ldaps":
		return directory.Ldaps
	case "starttls":
		return directory.StartTLS
	default:
		return directory.Plain
	}
}

// EffectiveSearchBases: SearchBases without duplicates or nested OUs; [BaseDn] when empty.
func (l Ldap) EffectiveSearchBases() []string {
	return directory.EffectiveSearchBases(l.SearchBases, l.BaseDn)
}

var fullAtRe = regexp.MustCompile(`^([01]\d|2[0-3]):[0-5]\d$`)

// FullAtMinutes is FullAt as minutes after midnight.
func (s Schedule) FullAtMinutes() int {
	h, _ := strconv.Atoi(s.FullAt[:2])
	m, _ := strconv.Atoi(s.FullAt[3:])
	return h*60 + m
}

func between(errs *[]string, name string, v, lo, hi int) {
	if v < lo || v > hi {
		*errs = append(*errs, fmt.Sprintf("%s must be between %d and %d.", name, lo, hi))
	}
}

// Validate returns every problem (empty = valid). Same rules as the .NET worker, adapted to
// what the Go worker supports.
func (c *Config) Validate() []string {
	var errs []string
	l := c.Ldap
	switch strings.ToLower(l.Source) {
	case "jsonfile":
		if strings.TrimSpace(l.JsonFilePath) == "" {
			errs = append(errs, "Ldap.JsonFilePath is required when Source is JsonFile.")
		}
	case "ldap":
		if len(l.Servers) == 0 {
			errs = append(errs, "Ldap.Servers needs at least one domain controller.")
		}
		if strings.TrimSpace(l.BaseDn) == "" {
			errs = append(errs, "Ldap.BaseDn is required (e.g. DC=corp,DC=local).")
		} else {
			for _, b := range l.SearchBases {
				if strings.TrimSpace(b) != "" && !directory.IsWithin(b, l.BaseDn) {
					errs = append(errs, fmt.Sprintf("Ldap.SearchBases: %q is not inside Ldap.BaseDn (%s).", b, l.BaseDn))
				}
			}
		}
		// Plain Ldap (the default) sends the bind password and every recovery key in clear text: the
		// worker logs a warning at each connection; use it on a trusted network only.
		switch strings.ToLower(l.Protocol) {
		case "ldap", "ldaps", "starttls":
		default:
			errs = append(errs, "Ldap.Protocol must be Ldap, Ldaps or StartTls.")
		}
		switch strings.ToLower(l.Auth) {
		case "", "basic":
		case "negotiate":
			errs = append(errs, "Ldap.Auth = Negotiate (Kerberos/NTLM, gMSA) is not supported by the Go worker: use Basic with Ldap.Username and Ldap.Password.")
		default:
			errs = append(errs, "Ldap.Auth must be Basic.")
		}
		if strings.TrimSpace(l.Username) == "" || l.Password == "" {
			errs = append(errs, "Ldap.Username and Ldap.Password are required (simple bind).")
		}
		if l.Port != nil {
			between(&errs, "Ldap.Port", *l.Port, 1, 65535)
		}
	default:
		errs = append(errs, "Ldap.Source must be Ldap or JsonFile.")
	}
	between(&errs, "Ldap.PageSize", l.PageSize, 1, 1000)
	between(&errs, "Ldap.TimeoutSeconds", l.TimeoutSeconds, 5, 600)

	in := c.Ingest
	u, err := url.Parse(in.BaseUrl)
	loopback := false
	if err != nil || u.Scheme == "" || u.Host == "" {
		errs = append(errs, "Ingest.BaseUrl must be an absolute URL, e.g. https://blk.corp.local:8443/api/ingest.")
	} else {
		host := u.Hostname()
		ip := net.ParseIP(host)
		loopback = strings.EqualFold(host, "localhost") || (ip != nil && ip.IsLoopback())
		if u.Scheme == "http" && !loopback {
			errs = append(errs, "Ingest.BaseUrl must use https (plain http is accepted for localhost only).")
		}
	}
	if err == nil && !loopback && strings.TrimSpace(in.ApiKey) == "" {
		errs = append(errs, "Ingest.ApiKey is required (INGEST_API_KEY of the server).")
	}
	between(&errs, "Ingest.TimeoutSeconds", in.TimeoutSeconds, 5, 600)
	between(&errs, "Ingest.BatchSize", in.BatchSize, 1, 500)
	between(&errs, "Ingest.RetryForMinutes", in.RetryForMinutes, 1, 1440)

	s := c.Schedule
	between(&errs, "Schedule.DeltaEveryMinutes", s.DeltaEveryMinutes, 1, 1440)
	between(&errs, "Schedule.HeartbeatEveryMinutes", s.HeartbeatEveryMinutes, 1, 60)
	if !fullAtRe.MatchString(s.FullAt) {
		errs = append(errs, "Schedule.FullAt must be HH:mm (e.g. 01:00).")
	}
	if strings.TrimSpace(s.StateFile) == "" {
		errs = append(errs, "Schedule.StateFile is required.")
	}
	return errs
}

// Reveal returns a secret in clear. Forms:
//
//	"file:/etc/blk-sync/ldap-password"  the content of the file (trailing newline dropped)
//	"env:BLK_LDAP_PASSWORD"             an environment variable
//	"cred:ldap-password"                a systemd credential (LoadCredential=/LoadCredentialEncrypted=)
//	anything else                       the value itself (development)
//
// "dpapi:" values belong to the Windows worker and cannot be read here.
func Reveal(value string) (string, error) {
	switch {
	case strings.HasPrefix(value, "file:"):
		b, err := os.ReadFile(strings.TrimPrefix(value, "file:"))
		if err != nil {
			return "", fmt.Errorf("secret file: %w", err)
		}
		return strings.TrimRight(string(b), "\r\n"), nil
	case strings.HasPrefix(value, "env:"):
		name := strings.TrimPrefix(value, "env:")
		v, ok := os.LookupEnv(name)
		if !ok {
			return "", fmt.Errorf("secret: environment variable %s is not set", name)
		}
		return v, nil
	case strings.HasPrefix(value, "cred:"):
		dir := os.Getenv("CREDENTIALS_DIRECTORY")
		if dir == "" {
			return "", errors.New("secret: cred: needs a systemd credential (CREDENTIALS_DIRECTORY is not set)")
		}
		b, err := os.ReadFile(filepath.Join(dir, strings.TrimPrefix(value, "cred:")))
		if err != nil {
			return "", fmt.Errorf("secret credential: %w", err)
		}
		return strings.TrimRight(string(b), "\r\n"), nil
	case strings.HasPrefix(value, "dpapi:"):
		return "", errors.New("secret: dpapi: values only work in the Windows (.NET) worker; use file:, env: or cred:")
	default:
		return value, nil
	}
}

// CertPool is the system store plus the PEM file (empty file = system store only, nil pool).
func CertPool(file string) (*x509.CertPool, error) {
	if file == "" {
		return nil, nil
	}
	pool, err := x509.SystemCertPool()
	if err != nil || pool == nil {
		pool = x509.NewCertPool()
	}
	b, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	if !pool.AppendCertsFromPEM(b) {
		return nil, fmt.Errorf("%s: no PEM certificate found", file)
	}
	return pool, nil
}

// StripJSONComments removes // and /* */ comments and trailing commas outside strings, so the
// file can be written like appsettings.json.
func StripJSONComments(in []byte) []byte {
	out := make([]byte, 0, len(in))
	inString, escaped := false, false
	for i := 0; i < len(in); i++ {
		ch := in[i]
		if inString {
			out = append(out, ch)
			switch {
			case escaped:
				escaped = false
			case ch == '\\':
				escaped = true
			case ch == '"':
				inString = false
			}
			continue
		}
		switch {
		case ch == '"':
			inString = true
			out = append(out, ch)
		case ch == '/' && i+1 < len(in) && in[i+1] == '/':
			for i < len(in) && in[i] != '\n' {
				i++
			}
			if i < len(in) {
				out = append(out, '\n')
			}
		case ch == '/' && i+1 < len(in) && in[i+1] == '*':
			i += 2
			for i+1 < len(in) && !(in[i] == '*' && in[i+1] == '/') {
				i++
			}
			i++
		case ch == ',':
			// Drop a trailing comma before } or ].
			j := i + 1
			for j < len(in) && (in[j] == ' ' || in[j] == '\t' || in[j] == '\r' || in[j] == '\n') {
				j++
			}
			if j < len(in) && (in[j] == '}' || in[j] == ']') {
				continue
			}
			out = append(out, ch)
		default:
			out = append(out, ch)
		}
	}
	return out
}

// applyEnv sets Section__Field values from the environment (names case-insensitive, like .NET).
// A list ([]string) takes a comma-separated value: Ldap__Servers=dc01.corp.local,dc02.corp.local.
func applyEnv(c *Config, env []string) error {
	root := reflect.ValueOf(c).Elem()
	for _, kv := range env {
		name, value, ok := strings.Cut(kv, "=")
		if !ok {
			continue
		}
		section, field, ok := strings.Cut(name, "__")
		if !ok || strings.Contains(field, "__") {
			continue
		}
		sec := fieldByName(root, section)
		if !sec.IsValid() || sec.Kind() != reflect.Struct {
			continue
		}
		f := fieldByName(sec, field)
		if !f.IsValid() || !f.CanSet() {
			continue
		}
		if err := setValue(f, value); err != nil {
			return fmt.Errorf("environment %s: %w", name, err)
		}
	}
	return nil
}

func fieldByName(v reflect.Value, name string) reflect.Value {
	t := v.Type()
	for i := 0; i < t.NumField(); i++ {
		if strings.EqualFold(t.Field(i).Name, name) && t.Field(i).Tag.Get("json") != "-" {
			return v.Field(i)
		}
	}
	return reflect.Value{}
}

func setValue(f reflect.Value, s string) error {
	switch f.Kind() {
	case reflect.String:
		f.SetString(s)
	case reflect.Int:
		n, err := strconv.Atoi(s)
		if err != nil {
			return err
		}
		f.SetInt(int64(n))
	case reflect.Bool:
		b, err := strconv.ParseBool(s)
		if err != nil {
			return err
		}
		f.SetBool(b)
	case reflect.Slice:
		var items []string
		for _, p := range strings.Split(s, ",") {
			if p = strings.TrimSpace(p); p != "" {
				items = append(items, p)
			}
		}
		f.Set(reflect.ValueOf(items))
	case reflect.Pointer:
		n, err := strconv.Atoi(s)
		if err != nil {
			return err
		}
		f.Set(reflect.ValueOf(&n))
	default:
		return fmt.Errorf("unsupported type %s", f.Kind())
	}
	return nil
}
