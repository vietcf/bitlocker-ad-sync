package directory

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/go-ldap/ldap/v3"
)

// Protocol is how the connection to the DC is protected.
type Protocol string

const (
	// Ldaps: TLS from the first byte, port 636 (recommended).
	Ldaps Protocol = "Ldaps"
	// StartTLS: port 389, upgraded to TLS before binding.
	StartTLS Protocol = "StartTls"
	// Plain: port 389 without TLS. The bind password and recovery keys travel unencrypted.
	Plain Protocol = "Ldap"
)

// LdapConfig is what the LDAP reader needs (from config.Ldap).
type LdapConfig struct {
	Servers     []string
	Port        int
	Protocol    Protocol
	Username    string // UPN (svc-blk@corp.local), DOMAIN\user or DN
	Password    string // already revealed
	BaseDN      string
	SearchBases []string // effective (see EffectiveSearchBases)
	// ExcludeOperatingSystems: patterns ("Windows Server*") of operatingSystem to leave out, with their keys.
	// Empty (default) = read every computer.
	ExcludeOperatingSystems []string
	PageSize                int
	Timeout                 time.Duration
	// RootCAs: extra trusted CAs (Ldap.CaFile) on top of the system store; nil = system store only.
	RootCAs *x509.CertPool
	// SkipCertificateValidation: lab only, accept any DC certificate (still encrypted, but no
	// protection against a fake DC).
	SkipCertificateValidation bool
}

var computerAttributes = []string{"objectGUID", "name", "dNSHostName", "distinguishedName", "operatingSystem", "uSNChanged", "whenChanged", "whenCreated", "lastLogonTimestamp"}
var keyAttributes = []string{"msFVE-RecoveryGuid", "msFVE-VolumeGuid", "msFVE-RecoveryPassword", "distinguishedName", "whenCreated", "uSNChanged"}

// LdapFactory creates LdapReaders.
type LdapFactory struct {
	Config LdapConfig
	Log    *slog.Logger
}

func (f *LdapFactory) PreferredServer() string {
	if len(f.Config.Servers) == 0 {
		return "unknown"
	}
	return f.Config.Servers[0]
}

func (f *LdapFactory) Create() Reader { return &LdapReader{cfg: f.Config, log: f.Log} }

// LdapReader reads Active Directory with go-ldap and a simple bind (Username/Password). Read-only.
// Protocol: Ldap (389, unencrypted, the default) | Ldaps (636) | StartTls (389 + TLS).
type LdapReader struct {
	cfg        LdapConfig
	log        *slog.Logger
	conn       *ldap.Conn
	server     string
	certExpiry *time.Time
}

func (r *LdapReader) Connect(ctx context.Context) (DcInfo, error) {
	var last *Error
	for _, server := range r.cfg.Servers {
		if err := ctx.Err(); err != nil {
			return DcInfo{}, err
		}
		info, err := r.connectTo(ctx, server)
		if err == nil {
			r.log.Info(fmt.Sprintf("Connected to %s (%s, simple bind)", server, r.cfg.Protocol), "server", server, "protocol", r.cfg.Protocol)
			switch {
			case r.cfg.Protocol == Plain:
				r.log.Warn("LDAP without TLS: the bind password and recovery keys travel unencrypted. Use only on a trusted network, or set Ldap.Protocol = Ldaps once the DC has a certificate.")
			case r.cfg.SkipCertificateValidation:
				r.log.Warn("The DC certificate is not checked (SkipCertificateValidation): encrypted, but a fake DC would not be noticed. Lab only.")
			}
			return info, nil
		}
		var de *Error
		if !errors.As(err, &de) {
			return DcInfo{}, err
		}
		last = de
		r.Close()
		// A rejected password will be rejected by every DC: do not hammer the others (lockout).
		if de.Kind == BindFailed {
			return DcInfo{}, de
		}
		r.log.Warn(fmt.Sprintf("Cannot use %s: %s Trying the next DC.", server, strings.TrimRight(de.Message, ".")+"."), "server", server)
	}
	if last == nil {
		return DcInfo{}, NewError(Unreachable, "No LDAP server is configured.", nil)
	}
	return DcInfo{}, last
}

func (r *LdapReader) connectTo(ctx context.Context, server string) (DcInfo, error) {
	addr := net.JoinHostPort(server, strconv.Itoa(r.cfg.Port))
	reach := r.cfg.Timeout
	if reach > 10*time.Second {
		reach = 10 * time.Second
	}
	dialer := &net.Dialer{Timeout: reach}
	raw, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		if ctx.Err() != nil {
			return DcInfo{}, ctx.Err()
		}
		return DcInfo{}, NewError(Unreachable, addr+" is not reachable.", err)
	}
	r.server = server
	r.certExpiry = nil
	tlsConfig := r.tlsConfig(server)

	var conn *ldap.Conn
	if r.cfg.Protocol == Ldaps {
		tc := tls.Client(raw, tlsConfig)
		hctx, cancel := context.WithTimeout(ctx, r.cfg.Timeout)
		err := tc.HandshakeContext(hctx)
		cancel()
		if err != nil {
			raw.Close()
			return DcInfo{}, NewError(TLSFailed, clean(fmt.Sprintf("%s: TLS handshake failed: %v", server, err)), err)
		}
		r.noteCertificate(tc.ConnectionState())
		conn = ldap.NewConn(tc, true)
	} else {
		conn = ldap.NewConn(raw, false)
	}
	conn.Start()
	conn.SetTimeout(r.cfg.Timeout)
	r.conn = conn

	if r.cfg.Protocol == StartTLS {
		if err := conn.StartTLS(tlsConfig); err != nil {
			return DcInfo{}, NewError(TLSFailed, clean(fmt.Sprintf("%s: StartTLS failed: %v", server, err))+". The DC has no usable TLS certificate?", err)
		}
		if st, ok := conn.TLSConnectionState(); ok {
			r.noteCertificate(st)
		}
	}

	if err := conn.Bind(r.cfg.Username, r.cfg.Password); err != nil {
		return DcInfo{}, r.mapError(err, "bind")
	}
	return r.ReadDcInfo()
}

func (r *LdapReader) tlsConfig(server string) *tls.Config {
	c := &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: r.cfg.RootCAs, InsecureSkipVerify: r.cfg.SkipCertificateValidation} //nolint:gosec // lab option, warned about
	// The certificate names the DC by host name; an IP address only matches with an IP SAN.
	c.ServerName = server
	return c
}

// noteCertificate keeps the expiry of the DC certificate (reported in the heartbeat and by `check`).
func (r *LdapReader) noteCertificate(st tls.ConnectionState) {
	if len(st.PeerCertificates) > 0 {
		t := st.PeerCertificates[0].NotAfter.UTC()
		r.certExpiry = &t
	}
}

func (r *LdapReader) mapError(err error, what string) *Error {
	var le *ldap.Error
	if errors.As(err, &le) {
		e := &Error{Err: err, ResultCode: le.ResultCode, Message: clean(fmt.Sprintf("%s: %s failed: %s (LDAP %d)", r.server, what, err.Error(), le.ResultCode))}
		switch {
		case le.ResultCode == ldap.LDAPResultInvalidCredentials:
			e.Kind = BindFailed
		case le.ResultCode == ldap.LDAPResultStrongAuthRequired || le.ResultCode == ldap.LDAPResultConfidentialityRequired:
			// The DC refuses simple binds without TLS/signing (LDAP signing policy).
			e.Kind = BindFailed
			e.Message += ". The DC requires signing/TLS for LDAP binds."
		case le.ResultCode == ldap.LDAPResultTimeLimitExceeded || strings.Contains(err.Error(), "timed out"):
			e.Kind = Timeout
		case le.ResultCode == ldap.ErrorNetwork:
			e.Kind = Unreachable
		default:
			e.Kind = Other
		}
		return e
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return &Error{Kind: Timeout, Message: fmt.Sprintf("%s: %s timed out", r.server, what), Err: err}
	}
	return &Error{Kind: Other, Message: fmt.Sprintf("%s: %s failed: %v", r.server, what, err), Err: err}
}

func (r *LdapReader) ReadDcInfo() (DcInfo, error) {
	if r.conn == nil {
		return DcInfo{}, errors.New("call Connect first")
	}
	res, err := r.conn.Search(ldap.NewSearchRequest("", ldap.ScopeBaseObject, ldap.NeverDerefAliases, 0, 0, false,
		"(objectClass=*)", []string{"highestCommittedUSN", "dnsHostName", "dsServiceName"}, nil))
	if err != nil {
		return DcInfo{}, r.mapError(err, "RootDSE read")
	}
	if len(res.Entries) != 1 {
		return DcInfo{}, NewError(Other, r.server+": RootDSE not returned", nil)
	}
	root := res.Entries[0]
	usn, _ := strconv.ParseInt(root.GetAttributeValue("highestCommittedUSN"), 10, 64)
	host := root.GetAttributeValue("dnsHostName")
	if host == "" {
		host = r.server
	}
	info := DcInfo{DNSHostName: host, HighestCommittedUSN: usn, CertificateExpiresAt: r.certExpiry}

	// invocationId lives on the DC's NTDS Settings object; it changes when the DC is restored from backup.
	if ntds := root.GetAttributeValue("dsServiceName"); ntds != "" {
		s, err := r.conn.Search(ldap.NewSearchRequest(ntds, ldap.ScopeBaseObject, ldap.NeverDerefAliases, 0, 0, false,
			"(objectClass=*)", []string{"invocationId"}, nil))
		if err != nil {
			return DcInfo{}, r.mapError(err, "invocationId read")
		}
		if len(s.Entries) == 1 {
			if raw := s.Entries[0].GetRawAttributeValue("invocationId"); len(raw) == 16 {
				g, _ := GUIDFromAD(raw)
				info.InvocationID = &g
			}
		}
	}
	return info, nil
}

func usnFilter(class string, sinceUSN *int64) string {
	if sinceUSN == nil {
		return class
	}
	return fmt.Sprintf("(&%s(uSNChanged>=%d))", class, *sinceUSN+1)
}

func (r *LdapReader) ReadComputers(ctx context.Context, sinceUSN *int64, yield func(Computer) error) error {
	filter := usnFilter(ComputerFilter(r.cfg.ExcludeOperatingSystems), sinceUSN)
	for _, base := range r.cfg.SearchBases {
		count := 0
		err := r.pagedSearch(ctx, base, filter, computerAttributes, func(e *ldap.Entry) error {
			c := toComputer(e)
			if c == nil {
				return nil
			}
			count++
			return yield(*c)
		})
		if err != nil {
			return err
		}
		r.log.Info(fmt.Sprintf("Read %d computers from %s", count, base), "count", count, "searchBase", base)
	}
	return nil
}

// excludedComputerDNs: DNs (lower case) of the computers left out by ExcludeOperatingSystems, in every
// search base. Read in full even in a delta run: a changed key may belong to an unchanged excluded server.
func (r *LdapReader) excludedComputerDNs(ctx context.Context) (map[string]struct{}, error) {
	patterns := CleanOSPatterns(r.cfg.ExcludeOperatingSystems)
	if len(patterns) == 0 {
		return nil, nil
	}
	set := map[string]struct{}{}
	filter := ExcludedComputerFilter(patterns)
	for _, base := range r.cfg.SearchBases {
		err := r.pagedSearch(ctx, base, filter, []string{"distinguishedName"}, func(e *ldap.Entry) error {
			set[strings.ToLower(e.DN)] = struct{}{}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	r.log.Info(fmt.Sprintf("Leaving out %d computers whose operating system matches %v (and their recovery keys)", len(set), patterns))
	return set, nil
}

func (r *LdapReader) ReadRecoveryKeys(ctx context.Context, sinceUSN *int64, yield func(RecoveryKey) error) error {
	filter := usnFilter("(objectClass=msFVE-RecoveryInformation)", sinceUSN)
	excluded, err := r.excludedComputerDNs(ctx)
	if err != nil {
		return err
	}
	for _, base := range r.cfg.SearchBases {
		count, skipped := 0, 0
		err := r.pagedSearch(ctx, base, filter, keyAttributes, func(e *ldap.Entry) error {
			if IsKeyOfExcluded(excluded, e.DN) {
				skipped++
				return nil
			}
			k := r.toKey(e)
			if k == nil {
				return nil
			}
			count++
			return yield(*k)
		})
		if err != nil {
			return err
		}
		r.log.Info(fmt.Sprintf("Read %d recovery keys from %s", count, base), "count", count, "searchBase", base, "skippedExcludedOS", skipped)
	}
	return nil
}

func (r *LdapReader) toKey(e *ldap.Entry) *RecoveryKey {
	raw := e.GetRawAttributeValue("msFVE-RecoveryGuid")
	created := ParseGeneralizedTime(e.GetAttributeValue("whenCreated"))
	id, err := GUIDFromAD(raw)
	if err != nil || created == nil {
		r.log.Warn("Skipping a recovery object without msFVE-RecoveryGuid or whenCreated: "+e.DN, "dn", e.DN)
		return nil
	}
	usn, _ := strconv.ParseInt(e.GetAttributeValue("uSNChanged"), 10, 64)
	k := &RecoveryKey{
		KeyID: id,
		DN:    e.DN,
		// Missing when the confidential attribute cannot be read: sent as "" (the server counts it).
		RecoveryPassword: e.GetAttributeValue("msFVE-RecoveryPassword"),
		WhenCreated:      *created,
		USNChanged:       usn,
	}
	if vol, err := GUIDFromAD(e.GetRawAttributeValue("msFVE-VolumeGuid")); err == nil {
		k.VolumeGUID = &vol
	}
	return k
}

func toComputer(e *ldap.Entry) *Computer {
	id, err := GUIDFromAD(e.GetRawAttributeValue("objectGUID"))
	name := e.GetAttributeValue("name")
	if err != nil || name == "" {
		return nil
	}
	usn, _ := strconv.ParseInt(e.GetAttributeValue("uSNChanged"), 10, 64)
	return &Computer{
		ObjectGUID:      id,
		Name:            name,
		DNSName:         optional(e.GetAttributeValue("dNSHostName")),
		DN:              e.DN,
		OperatingSystem: optional(e.GetAttributeValue("operatingSystem")),
		USNChanged:      usn,
		WhenChanged:     ParseGeneralizedTime(e.GetAttributeValue("whenChanged")),
		WhenCreated:     ParseGeneralizedTime(e.GetAttributeValue("whenCreated")),
		LastLogon:       ParseFileTime(e.GetAttributeValue("lastLogonTimestamp")),
	}
}

func optional(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// ProbeSearchBases is for `check`: can each configured OU be read? Reads up to sample computers
// and keys per OU and counts keys whose password is not readable. Never stops at the first bad OU.
func (r *LdapReader) ProbeSearchBases(ctx context.Context, sample int) []SearchBaseProbe {
	var out []SearchBaseProbe
	errStop := errors.New("enough")
	for _, base := range r.cfg.SearchBases {
		p := SearchBaseProbe{SearchBase: base}
		err := r.pagedSearch(ctx, base, ComputerFilter(r.cfg.ExcludeOperatingSystems), computerAttributes, func(*ldap.Entry) error {
			p.Computers++
			if p.Computers >= sample {
				return errStop
			}
			return nil
		})
		if err == nil || errors.Is(err, errStop) {
			err = r.pagedSearch(ctx, base, "(objectClass=msFVE-RecoveryInformation)", keyAttributes, func(e *ldap.Entry) error {
				p.Keys++
				if len(e.GetAttributeValues("msFVE-RecoveryPassword")) == 0 {
					p.KeysWithoutPassword++
				}
				if p.Keys >= sample {
					return errStop
				}
				return nil
			})
		}
		if err != nil && !errors.Is(err, errStop) {
			p = SearchBaseProbe{SearchBase: base, Error: err.Error()}
		}
		out = append(out, p)
	}
	return out
}

func (r *LdapReader) ReadComputer(dn string) (*Computer, error) {
	res, err := r.conn.Search(ldap.NewSearchRequest(dn, ldap.ScopeBaseObject, ldap.NeverDerefAliases, 0, 0, false,
		"(objectCategory=computer)", computerAttributes, nil))
	if err != nil {
		if ldap.IsErrorWithCode(err, ldap.LDAPResultNoSuchObject) {
			return nil, nil
		}
		return nil, r.mapError(err, "read of "+dn)
	}
	if len(res.Entries) != 1 {
		return nil, nil
	}
	return toComputer(res.Entries[0]), nil
}

// pagedSearch runs a subtree search one page at a time (PageSize), calling each for every entry.
func (r *LdapReader) pagedSearch(ctx context.Context, base, filter string, attrs []string, each func(*ldap.Entry) error) error {
	paging := ldap.NewControlPaging(uint32(r.cfg.PageSize))
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		req := ldap.NewSearchRequest(base, ldap.ScopeWholeSubtree, ldap.NeverDerefAliases, 0, 0, false, filter, attrs, []ldap.Control{paging})
		res, err := r.conn.Search(req)
		if err != nil {
			if ldap.IsErrorAnyOf(err, ldap.LDAPResultNoSuchObject, ldap.LDAPResultInsufficientAccessRights, ldap.LDAPResultReferral) {
				// Skipping the OU would make a full run flag all its computers "not in AD": stop instead.
				var le *ldap.Error
				errors.As(err, &le)
				return &Error{Kind: SearchBaseFailed, Err: err, ResultCode: le.ResultCode, Message: fmt.Sprintf(
					"%s: the OU %s cannot be read (%s). Check Ldap.SearchBases and the account's permissions.",
					r.server, base, ldap.LDAPResultCodeMap[le.ResultCode])}
			}
			return r.mapError(err, "search of "+base)
		}
		for _, e := range res.Entries {
			if err := each(e); err != nil {
				return err
			}
		}
		ctrl, ok := ldap.FindControl(res.Controls, ldap.ControlTypePaging).(*ldap.ControlPaging)
		if !ok || ctrl == nil || len(ctrl.Cookie) == 0 {
			return nil
		}
		paging.SetCookie(ctrl.Cookie)
	}
}

func (r *LdapReader) Close() error {
	if r.conn != nil {
		err := r.conn.Close()
		r.conn = nil
		return err
	}
	return nil
}

// clean drops control characters (AD error texts end with a NUL) and extra spaces.
func clean(s string) string {
	s = strings.Map(func(r rune) rune {
		if r < 0x20 {
			return ' '
		}
		return r
	}, s)
	return strings.Join(strings.Fields(s), " ")
}
