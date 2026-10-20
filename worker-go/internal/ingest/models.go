// Package ingest is the client of the server's ingest API (server/openapi/ingest.openapi.yaml).
package ingest

import (
	"context"
	"fmt"
	"time"
)

// Request/response shapes, camelCase on the wire. Optional values are pointers sent as null.

type LastRun struct {
	RunID      int64     `json:"runId"`
	DcName     string    `json:"dcName"`
	HighestUSN int64     `json:"highestUsn"`
	FinishedAt time.Time `json:"finishedAt"`
}

type OpenRunRequest struct {
	Mode   string `json:"mode"`
	DcName string `json:"dcName"`
}

type OpenRunResponse struct {
	RunID    int64  `json:"runId"`
	Mode     string `json:"mode"`
	SinceUSN int64  `json:"sinceUsn"`
}

type ComputerItem struct {
	ObjectGUID  string     `json:"objectGuid"`
	Name        string     `json:"name"`
	DNSName     *string    `json:"dnsName"`
	DN          string     `json:"dn"`
	OS          *string    `json:"os"`
	USNChanged  int64      `json:"usnChanged"`
	WhenChanged *time.Time `json:"whenChanged"`
	WhenCreated *time.Time `json:"whenCreated"`
	LastLogon   *time.Time `json:"lastLogon"`
}

type ComputersBatch struct {
	RunID int64          `json:"runId"`
	Items []ComputerItem `json:"items"`
}

type ComputersResult struct {
	Upserted int `json:"upserted"`
	Moved    int `json:"moved"`
	Unmapped int `json:"unmapped"`
}

// KeyItem is a recovery key on its way to the server. String never prints the password.
type KeyItem struct {
	KeyID            string    `json:"keyId"`
	DN               string    `json:"dn"`
	RecoveryPassword string    `json:"recoveryPassword"`
	WhenCreated      time.Time `json:"whenCreated"`
	VolumeGUID       *string   `json:"volumeGuid"`
	// objectGUID of the computer that owns the key: the server links the key by it (not by name / DN).
	ComputerObjectGUID *string `json:"computerObjectGuid"`
}

func (k KeyItem) String() string {
	vol := ""
	if k.VolumeGUID != nil {
		vol = *k.VolumeGUID
	}
	return fmt.Sprintf("KeyItem{KeyId = %s, Dn = %s, VolumeGuid = %s, RecoveryPassword = [REDACTED], WhenCreated = %s}",
		k.KeyID, k.DN, vol, k.WhenCreated.Format(time.RFC3339))
}

// GoString keeps %#v from printing the password too.
func (k KeyItem) GoString() string { return k.String() }

type KeysBatch struct {
	RunID int64     `json:"runId"`
	Items []KeyItem `json:"items"`
}

type KeysResult struct {
	Inserted      int      `json:"inserted"`
	Skipped       int      `json:"skipped"`
	EmptyPassword int      `json:"emptyPassword"`
	Orphans       []string `json:"orphans"`
}

type CompleteRequest struct {
	Status        string  `json:"status"`
	HighestUSN    *int64  `json:"highestUsn"`
	ComputersSeen *int    `json:"computersSeen"`
	KeysSeen      *int    `json:"keysSeen"`
	Errors        int     `json:"errors"`
	ErrorCode     *string `json:"errorCode"`
	DcHighestUSN  *int64  `json:"dcHighestUsn"`
}

type Anomaly struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type CompleteResult struct {
	Status        string    `json:"status"`
	MarkedDeleted *int      `json:"markedDeleted"`
	Anomalies     []Anomaly `json:"anomalies"`
}

type HeartbeatRequest struct {
	WorkerID        string     `json:"workerId"`
	Version         *string    `json:"version"`
	DcName          *string    `json:"dcName"`
	LdapOK          *bool      `json:"ldapOk"`
	LastErrorCode   *string    `json:"lastErrorCode"`
	QueueLen        *int       `json:"queueLen"`
	DcCertExpiresAt *time.Time `json:"dcCertExpiresAt"`
	CanaryValue     *time.Time `json:"canaryValue"`
}

type HeartbeatResponse struct {
	SyncRequested *string `json:"syncRequested"`
}

// Error is an API call that failed. Transient failures (network, timeout, 5xx) are retried.
type Error struct {
	Message string
	Status  int    // 0 = no HTTP answer (network error)
	Code    string // the "error" field of the JSON body
	Err     error
}

func (e *Error) Error() string { return e.Message }
func (e *Error) Unwrap() error { return e.Err }

// Transient reports whether the call may succeed if tried again.
func (e *Error) Transient() bool {
	return e.Status == 0 || e.Status >= 500 || e.Status == 408 || e.Status == 429
}

// API is the ingest API as the sync logic sees it (an interface so it can be faked in tests).
type API interface {
	// PendingRetries is how many calls are waiting to be retried right now (queueLen in the heartbeat).
	PendingRetries() int
	GetLastRun(ctx context.Context) (*LastRun, error)
	OpenRun(ctx context.Context, r OpenRunRequest) (OpenRunResponse, error)
	SendComputers(ctx context.Context, b ComputersBatch) (ComputersResult, error)
	SendKeys(ctx context.Context, b KeysBatch) (KeysResult, error)
	Complete(ctx context.Context, runID int64, r CompleteRequest) (CompleteResult, error)
	Heartbeat(ctx context.Context, r HeartbeatRequest) (HeartbeatResponse, error)
}
