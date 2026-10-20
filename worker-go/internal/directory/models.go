// Package directory reads computers and BitLocker recovery keys from Active Directory (or, for
// development, from a JSON file shaped like AD data). Read-only.
package directory

import (
	"context"
	"fmt"
	"time"
)

// DcInfo is what the worker reads from the DC's RootDSE (and the NTDS Settings object).
type DcInfo struct {
	DNSHostName          string     `json:"dnsHostName"`
	HighestCommittedUSN  int64      `json:"highestCommittedUsn"`
	InvocationID         *GUID      `json:"invocationId"`
	CertificateExpiresAt *time.Time `json:"certificateExpiresAt"`
}

// Computer is one computer object.
type Computer struct {
	ObjectGUID      GUID       `json:"objectGuid"`
	Name            string     `json:"name"`
	DNSName         *string    `json:"dnsName"`
	DN              string     `json:"dn"`
	OperatingSystem *string    `json:"operatingSystem"`
	USNChanged      int64      `json:"usnChanged"`
	WhenChanged     *time.Time `json:"whenChanged"`
	WhenCreated     *time.Time `json:"whenCreated"`
	LastLogon       *time.Time `json:"lastLogon"` // lastLogonTimestamp: replicated between DCs, accurate to ~14 days
}

// RecoveryKey is one msFVE-RecoveryInformation object. RecoveryPassword is empty when the object
// was readable but its confidential attribute was not. String never prints the password.
type RecoveryKey struct {
	KeyID            GUID      `json:"keyId"`
	DN               string    `json:"dn"`
	RecoveryPassword string    `json:"recoveryPassword"`
	WhenCreated      time.Time `json:"whenCreated"`
	USNChanged       int64     `json:"usnChanged"`
	// msFVE-VolumeGuid: the encrypted volume (C:, D:...) this key protects; a volume can have several keys.
	VolumeGUID *GUID `json:"volumeGuid"`
}

func (k RecoveryKey) String() string {
	pw := "(empty)"
	if k.RecoveryPassword != "" {
		pw = "[REDACTED]"
	}
	vol := ""
	if k.VolumeGUID != nil {
		vol = k.VolumeGUID.String()
	}
	return fmt.Sprintf("RecoveryKey{KeyId = %s, Dn = %s, RecoveryPassword = %s, VolumeGuid = %s, WhenCreated = %s, UsnChanged = %d}",
		k.KeyID, k.DN, pw, vol, k.WhenCreated.Format(time.RFC3339), k.USNChanged)
}

// GoString keeps %#v from printing the password too.
func (k RecoveryKey) GoString() string { return k.String() }

// SearchBaseProbe is the result of `check` for one OU of Ldap.SearchBases (Error set when it cannot be read).
type SearchBaseProbe struct {
	SearchBase          string
	Computers           int
	Keys                int
	KeysWithoutPassword int
	Error               string
}

// ErrorKind says why reading the directory failed; it maps to the error codes of the ingest API.
type ErrorKind int

const (
	Unreachable ErrorKind = iota
	TLSFailed
	BindFailed
	Timeout
	// SearchBaseFailed: an OU in Ldap.SearchBases does not exist or cannot be read by the account.
	SearchBaseFailed
	Other
)

// Error is a directory failure with its kind.
type Error struct {
	Kind    ErrorKind
	Message string
	Err     error
	// ResultCode is the LDAP result code when the server answered (0 otherwise).
	ResultCode uint16
}

func (e *Error) Error() string { return e.Message }
func (e *Error) Unwrap() error { return e.Err }

// APIErrorCode is the errorCode sent to POST /sync-runs/{id}/complete.
func (e *Error) APIErrorCode() string {
	switch e.Kind {
	case Unreachable:
		return "ldap_unreachable"
	case TLSFailed:
		return "ldap_tls_failed"
	case BindFailed:
		return "ldap_bind_failed"
	case Timeout:
		return "ldap_timeout"
	case SearchBaseFailed:
		return "ldap_search_base_failed"
	default:
		return "unknown"
	}
}

// NewError builds an Error.
func NewError(kind ErrorKind, message string, err error) *Error {
	return &Error{Kind: kind, Message: message, Err: err}
}

// Reader is a connection to one DC for the duration of a sync run.
type Reader interface {
	// Connect connects (first reachable server, in configured order), binds and reads the RootDSE.
	Connect(ctx context.Context) (DcInfo, error)
	// ReadDcInfo reads the RootDSE again (e.g. the USN at the end of a run).
	ReadDcInfo() (DcInfo, error)
	// ReadComputers calls yield for each computer object; with sinceUSN, only those with uSNChanged > it.
	ReadComputers(ctx context.Context, sinceUSN *int64, yield func(Computer) error) error
	// ReadRecoveryKeys calls yield for each recovery key object; with sinceUSN, only those with uSNChanged > it.
	ReadRecoveryKeys(ctx context.Context, sinceUSN *int64, yield func(RecoveryKey) error) error
	// ReadComputer reads one computer object by DN; nil if it does not exist.
	ReadComputer(dn string) (*Computer, error)
	Close() error
}

// Factory creates readers.
type Factory interface {
	// PreferredServer is the configured first (pinned) DC, used to label a run that could not connect at all.
	PreferredServer() string
	Create() Reader
}
