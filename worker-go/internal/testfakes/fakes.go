// Package testfakes holds an in-memory AD and a small model of the ingest server for tests
// (the same fakes as the .NET worker's tests).
package testfakes

import (
	"context"
	"crypto/rand"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/bitlocker-management/worker-go/internal/directory"
	"github.com/bitlocker-management/worker-go/internal/ingest"
)

// NewGUID returns a random GUID.
func NewGUID() directory.GUID {
	var g directory.GUID
	_, _ = rand.Read(g[:])
	return g
}

// Directory is an in-memory AD: computers and keys with USNs, a DC identity, optional failure.
type Directory struct {
	Dc              directory.DcInfo
	Computers       []directory.Computer
	Keys            []directory.RecoveryKey
	ConnectError    error
	ComputerQueries []*int64
}

// NewDirectory returns an empty AD on dc01.corp.local at USN 1000.
func NewDirectory() *Directory {
	inv, _ := directory.ParseGUID("11111111-1111-1111-1111-111111111111")
	return &Directory{Dc: directory.DcInfo{DNSHostName: "dc01.corp.local", HighestCommittedUSN: 1000, InvocationID: &inv}}
}

func (d *Directory) PreferredServer() string  { return "dc01.corp.local" }
func (d *Directory) Create() directory.Reader { return &reader{d} }

// AddComputer adds PC-n in the HN OU.
func (d *Directory) AddComputer(n int, usn int64) directory.Computer {
	created := time.Now().UTC().AddDate(0, 0, -100)
	os := "Windows 11"
	c := directory.Computer{ObjectGUID: NewGUID(), Name: fmt.Sprintf("PC-%d", n), DN: fmt.Sprintf("CN=PC-%d,OU=Computers,OU=HN,DC=corp,DC=local", n),
		OperatingSystem: &os, USNChanged: usn, WhenCreated: &created}
	d.Computers = append(d.Computers, c)
	return c
}

// AddKey adds a key under owner.
func (d *Directory) AddKey(owner directory.Computer, usn int64, password string) directory.RecoveryKey {
	id := NewGUID()
	k := directory.RecoveryKey{KeyID: id, DN: fmt.Sprintf("CN=x{%s},%s", id, owner.DN), RecoveryPassword: password,
		WhenCreated: time.Now().UTC().AddDate(0, 0, -1), USNChanged: usn}
	d.Keys = append(d.Keys, k)
	return k
}

// Password is a recovery password in the AD format.
const Password = "111111-222222-333333-444444-555555-666666-777777-888888"

type reader struct{ d *Directory }

func (r *reader) Connect(context.Context) (directory.DcInfo, error) {
	if r.d.ConnectError != nil {
		return directory.DcInfo{}, r.d.ConnectError
	}
	return r.d.Dc, nil
}
func (r *reader) ReadDcInfo() (directory.DcInfo, error) { return r.d.Dc, nil }
func (r *reader) ReadComputers(_ context.Context, since *int64, yield func(directory.Computer) error) error {
	r.d.ComputerQueries = append(r.d.ComputerQueries, since)
	for _, c := range slices.Clone(r.d.Computers) {
		if since == nil || c.USNChanged > *since {
			if err := yield(c); err != nil {
				return err
			}
		}
	}
	return nil
}
func (r *reader) ReadRecoveryKeys(_ context.Context, since *int64, yield func(directory.RecoveryKey) error) error {
	for _, k := range slices.Clone(r.d.Keys) {
		if since == nil || k.USNChanged > *since {
			if err := yield(k); err != nil {
				return err
			}
		}
	}
	return nil
}
func (r *reader) ReadComputer(dn string) (*directory.Computer, error) {
	for _, c := range r.d.Computers {
		if strings.EqualFold(c.DN, dn) {
			c := c
			return &c, nil
		}
	}
	return nil, nil
}
func (r *reader) Close() error { return nil }

// API is a small model of the server: remembers computers by DN, reports keys of unknown
// computers as orphans, records every call.
type API struct {
	mu                 sync.Mutex
	Calls              []string
	Opened             []ingest.OpenRunRequest
	Completed          []ingest.CompleteRequest
	Heartbeats         []ingest.HeartbeatRequest
	ComputerBatchSizes []int
	SentKeys           []ingest.KeyItem
	KnownComputerDNs   map[string]bool
	NeverKnownDNs      map[string]bool
	LastRun            *ingest.LastRun
	ForcedMode         string
	SinceUSN           int64
	SyncRequested      string
	// StopWhileSendingKeys cancels the run's context during the first key batch.
	StopWhileSendingKeys context.CancelFunc
	nextRun              int64
}

// NewAPI returns an empty server model (since USN 100).
func NewAPI() *API {
	return &API{KnownComputerDNs: map[string]bool{}, NeverKnownDNs: map[string]bool{}, SinceUSN: 100, nextRun: 1}
}

func (a *API) PendingRetries() int { return 0 }

func (a *API) GetLastRun(context.Context) (*ingest.LastRun, error) {
	a.Calls = append(a.Calls, "last")
	return a.LastRun, nil
}

func (a *API) OpenRun(_ context.Context, r ingest.OpenRunRequest) (ingest.OpenRunResponse, error) {
	a.Calls = append(a.Calls, "open")
	a.Opened = append(a.Opened, r)
	mode := r.Mode
	if a.ForcedMode != "" {
		mode = a.ForcedMode
	}
	id := a.nextRun
	a.nextRun++
	since := a.SinceUSN
	if mode == "full" {
		since = 0
	}
	return ingest.OpenRunResponse{RunID: id, Mode: mode, SinceUSN: since}, nil
}

func (a *API) SendComputers(_ context.Context, b ingest.ComputersBatch) (ingest.ComputersResult, error) {
	a.Calls = append(a.Calls, "computers")
	a.ComputerBatchSizes = append(a.ComputerBatchSizes, len(b.Items))
	for _, c := range b.Items {
		if !a.NeverKnownDNs[strings.ToLower(c.DN)] {
			a.KnownComputerDNs[strings.ToLower(c.DN)] = true
		}
	}
	return ingest.ComputersResult{Upserted: len(b.Items)}, nil
}

func (a *API) SendKeys(ctx context.Context, b ingest.KeysBatch) (ingest.KeysResult, error) {
	a.Calls = append(a.Calls, "keys")
	a.SentKeys = append(a.SentKeys, b.Items...)
	if a.StopWhileSendingKeys != nil {
		a.StopWhileSendingKeys()
		return ingest.KeysResult{}, ctx.Err()
	}
	res := ingest.KeysResult{Orphans: []string{}}
	for _, k := range b.Items {
		parent := strings.ToLower(directory.ParentDN(k.DN))
		if a.KnownComputerDNs[parent] {
			res.Inserted++
		} else {
			res.Orphans = append(res.Orphans, k.KeyID)
		}
	}
	return res, nil
}

func (a *API) Complete(_ context.Context, _ int64, r ingest.CompleteRequest) (ingest.CompleteResult, error) {
	a.Calls = append(a.Calls, "complete")
	a.Completed = append(a.Completed, r)
	return ingest.CompleteResult{Status: r.Status}, nil
}

func (a *API) Heartbeat(_ context.Context, r ingest.HeartbeatRequest) (ingest.HeartbeatResponse, error) {
	a.Calls = append(a.Calls, "heartbeat")
	a.Heartbeats = append(a.Heartbeats, r)
	var out ingest.HeartbeatResponse
	if a.SyncRequested != "" {
		s := a.SyncRequested
		out.SyncRequested = &s
	}
	return out, nil
}

// IsKnown reports whether the server stored this computer DN.
func (a *API) IsKnown(dn string) bool { return a.KnownComputerDNs[strings.ToLower(dn)] }

// Know marks a computer DN as already stored on the server.
func (a *API) Know(dn string) { a.KnownComputerDNs[strings.ToLower(dn)] = true }

// NeverKnow makes the server refuse a computer DN (its keys stay orphans).
func (a *API) NeverKnow(dn string) { a.NeverKnownDNs[strings.ToLower(dn)] = true }
