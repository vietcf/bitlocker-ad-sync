package syncrun

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/bitlocker-management/worker-go/internal/directory"
	"github.com/bitlocker-management/worker-go/internal/ingest"
)

// Mode of a run.
type Mode string

const (
	Delta Mode = "delta"
	Full  Mode = "full"
)

// Outcome of one run, for logs and the next heartbeat.
type Outcome struct {
	Mode          Mode
	RunID         int64
	Status        string
	ComputersSent int
	KeysSent      int
	OrphansLeft   int
	ErrorCode     string
	Dc            *directory.DcInfo
}

// LdapOK reports whether the last run had no LDAP problem.
func (o Outcome) LdapOK() bool { return !strings.HasPrefix(o.ErrorCode, "ldap_") }

// Runner runs one sync run: open the run -> snapshot the DC's highestCommittedUSN BEFORE
// reading -> send computers -> send keys -> fix orphan keys -> complete. The server decides
// what is stored.
type Runner struct {
	Directories directory.Factory
	API         ingest.API
	State       StateStore
	BatchSize   int
	Now         func() time.Time
	Log         *slog.Logger
}

// Run runs one sync. A non-nil error means the run could not be reported to the server (or the
// context was cancelled); failures that were reported come back as an Outcome with Status "failed".
func (r *Runner) Run(ctx context.Context, requested Mode) (Outcome, error) {
	dir := r.Directories.Create()
	defer dir.Close()

	dc, err := dir.Connect(ctx)
	if err != nil {
		var de *directory.Error
		if !errors.As(err, &de) {
			return Outcome{}, err
		}
		// Still open and fail a run, so the server records the error and raises an alert.
		r.Log.Error("Cannot read AD: " + de.Message)
		open, err := r.API.OpenRun(ctx, ingest.OpenRunRequest{Mode: string(requested), DcName: r.Directories.PreferredServer()})
		if err != nil {
			return Outcome{}, err
		}
		if _, err := r.API.Complete(ctx, open.RunID, failed(de.APIErrorCode())); err != nil {
			return Outcome{}, err
		}
		return Outcome{Mode: requested, RunID: open.RunID, Status: "failed", ErrorCode: de.APIErrorCode()}, nil
	}

	mode, err := r.decideMode(ctx, requested, dc)
	if err != nil {
		return Outcome{}, err
	}
	open, err := r.API.OpenRun(ctx, ingest.OpenRunRequest{Mode: string(mode), DcName: dc.DNSHostName})
	if err != nil {
		return Outcome{}, err
	}
	mode = Delta
	if open.Mode == "full" { // the server may turn a delta into a full run
		mode = Full
	}
	var sinceUSN *int64
	if mode == Delta {
		s := open.SinceUSN
		sinceUSN = &s
	}
	highestUSN := dc.HighestCommittedUSN // snapshot before reading: changes made meanwhile are read next time
	since := "-"
	if sinceUSN != nil {
		since = fmt.Sprint(*sinceUSN)
	}
	r.Log.Info(fmt.Sprintf("Run %d: %s from %s, since USN %s, up to %d", open.RunID, mode, dc.DNSHostName, since, highestUSN))

	out, err := r.read(ctx, dir, open, mode, sinceUSN, highestUSN, dc)
	if err == nil {
		return out, nil
	}

	var de *directory.Error
	var ie *ingest.Error
	switch {
	case ctx.Err() != nil:
		// Service stopping (e.g. for an update): close the run so the next start is not refused
		// with run_in_progress for two hours. Nothing was committed past the last USN.
		r.Log.Warn(fmt.Sprintf("Run %d cancelled: the service is stopping", open.RunID))
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		r.tryCompleteFailed(shutdown, open.RunID, "cancelled")
		return Outcome{}, ctx.Err()
	case errors.As(err, &de):
		r.Log.Error(fmt.Sprintf("Run %d failed reading AD: %s", open.RunID, de.Message))
		r.tryCompleteFailed(ctx, open.RunID, de.APIErrorCode())
		return Outcome{Mode: mode, RunID: open.RunID, Status: "failed", ErrorCode: de.APIErrorCode(), Dc: &dc}, nil
	case errors.As(err, &ie):
		r.Log.Error(fmt.Sprintf("Run %d failed talking to the API: %s", open.RunID, ie.Message))
		r.tryCompleteFailed(ctx, open.RunID, "api_unreachable")
		return Outcome{Mode: mode, RunID: open.RunID, Status: "failed", ErrorCode: "api_unreachable", Dc: &dc}, nil
	default:
		return Outcome{}, err
	}
}

func (r *Runner) read(ctx context.Context, dir directory.Reader, open ingest.OpenRunResponse, mode Mode, sinceUSN *int64, highestUSN int64, dc directory.DcInfo) (Outcome, error) {
	// objectGUID of each computer by DN (lower case), so every key is sent with its computer's
	// objectGUID: the server links keys by AD's own id, not by name or DN.
	owners := map[string]*string{}
	computersSent := 0
	var batch []ingest.ComputerItem
	flushComputers := func() error {
		if len(batch) == 0 {
			return nil
		}
		if _, err := r.API.SendComputers(ctx, ingest.ComputersBatch{RunID: open.RunID, Items: batch}); err != nil {
			return err
		}
		computersSent += len(batch)
		batch = nil
		return nil
	}
	err := dir.ReadComputers(ctx, sinceUSN, func(c directory.Computer) error {
		g := c.ObjectGUID.String()
		owners[strings.ToLower(c.DN)] = &g
		batch = append(batch, ComputerItem(c))
		if len(batch) >= r.BatchSize {
			return flushComputers()
		}
		return nil
	})
	if err == nil {
		err = flushComputers()
	}
	if err != nil {
		return Outcome{}, err
	}

	keysSent := 0
	var orphans []ingest.KeyItem
	var keys []ingest.KeyItem
	flushKeys := func() error {
		if len(keys) == 0 {
			return nil
		}
		res, err := r.API.SendKeys(ctx, ingest.KeysBatch{RunID: open.RunID, Items: keys})
		if err != nil {
			return err
		}
		keysSent += len(keys)
		orphans = append(orphans, pick(keys, res.Orphans)...)
		keys = nil
		return nil
	}
	err = dir.ReadRecoveryKeys(ctx, sinceUSN, func(k directory.RecoveryKey) error {
		item := KeyItem(k)
		owner, err := r.ownerOf(dir, owners, item.DN)
		if err != nil {
			return err
		}
		item.ComputerObjectGUID = owner
		keys = append(keys, item)
		if len(keys) >= r.BatchSize {
			return flushKeys()
		}
		return nil
	})
	if err == nil {
		err = flushKeys()
	}
	if err != nil {
		return Outcome{}, err
	}

	orphansLeft := 0
	if len(orphans) > 0 {
		if orphansLeft, err = r.fixOrphans(ctx, dir, open.RunID, orphans); err != nil {
			return Outcome{}, err
		}
	}
	end, err := dir.ReadDcInfo()
	if err != nil {
		return Outcome{}, err
	}

	// With orphans left, keep the old USN so the next delta reads those keys again.
	reported := highestUSN
	if orphansLeft > 0 {
		reported = open.SinceUSN
	}
	completed, err := r.API.Complete(ctx, open.RunID, ingest.CompleteRequest{
		Status: "success", HighestUSN: &reported, ComputersSeen: &computersSent, KeysSeen: &keysSent,
		Errors: orphansLeft, DcHighestUSN: &end.HighestCommittedUSN,
	})
	if err != nil {
		return Outcome{}, err
	}

	previous := r.State.Load()
	next := State{DcName: &dc.DNSHostName, InvocationID: dc.InvocationID, LastFullDate: previous.LastFullDate}
	if mode == Full && completed.Status == "success" {
		today := r.Now().Format("2006-01-02")
		next.LastFullDate = &today
	}
	if err := r.State.Save(next); err != nil {
		r.Log.Warn("Could not save the state file: " + err.Error())
	}

	if completed.Status == "quarantined" {
		var msgs []string
		for _, a := range completed.Anomalies {
			msgs = append(msgs, a.Message)
		}
		r.Log.Warn(fmt.Sprintf("Run %d was quarantined by the server: %s", open.RunID, strings.Join(msgs, "; ")))
	} else {
		deleted := 0
		if completed.MarkedDeleted != nil {
			deleted = *completed.MarkedDeleted
		}
		r.Log.Info(fmt.Sprintf("Run %d %s: %d computers, %d keys, %d orphan keys left, %d marked deleted",
			open.RunID, completed.Status, computersSent, keysSent, orphansLeft, deleted))
	}
	return Outcome{Mode: mode, RunID: open.RunID, Status: completed.Status, ComputersSent: computersSent,
		KeysSent: keysSent, OrphansLeft: orphansLeft, Dc: &dc}, nil
}

// ownerOf returns the objectGUID of the computer that owns a key (the parent of the key object):
// from the computers read in this run, else read once from AD and remembered. nil when the
// parent is not a computer the reader can see (the server then falls back to the DN).
func (r *Runner) ownerOf(dir directory.Reader, owners map[string]*string, keyDN string) (*string, error) {
	parent := strings.ToLower(directory.ParentDN(keyDN))
	if g, ok := owners[parent]; ok {
		return g, nil
	}
	c, err := dir.ReadComputer(directory.ParentDN(keyDN))
	if err != nil {
		return nil, err
	}
	var g *string
	if c != nil {
		s := c.ObjectGUID.String()
		g = &s
	}
	owners[parent] = g
	return g, nil
}

// decideMode: a delta is only valid against the same, un-restored DC. A restored DC has a new
// invocationId and may have a lower USN than we last stored: then read everything again.
func (r *Runner) decideMode(ctx context.Context, requested Mode, dc directory.DcInfo) (Mode, error) {
	if requested == Full {
		return Full, nil
	}
	saved := r.State.Load()
	if saved.DcName != nil && strings.EqualFold(*saved.DcName, dc.DNSHostName) &&
		saved.InvocationID != nil && dc.InvocationID != nil && *saved.InvocationID != *dc.InvocationID {
		r.Log.Warn(fmt.Sprintf("DC %s has a new invocationId (restored from backup?): running a full sync", dc.DNSHostName))
		return Full, nil
	}
	last, err := r.API.GetLastRun(ctx)
	if err != nil {
		return "", err
	}
	if last != nil && strings.EqualFold(last.DcName, dc.DNSHostName) && dc.HighestCommittedUSN < last.HighestUSN {
		r.Log.Warn(fmt.Sprintf("USN of %s went back (%d < %d): running a full sync", dc.DNSHostName, dc.HighestCommittedUSN, last.HighestUSN))
		return Full, nil
	}
	return Delta, nil
}

// fixOrphans: keys whose computer the server did not know. Send each key's parent computer, then
// the keys again. Returns how many are still orphans.
func (r *Runner) fixOrphans(ctx context.Context, dir directory.Reader, runID int64, orphans []ingest.KeyItem) (int, error) {
	r.Log.Info(fmt.Sprintf("%d orphan keys: sending their computers again", len(orphans)))
	seen := map[string]bool{}
	var parents []ingest.ComputerItem
	for _, k := range orphans {
		dn := directory.ParentDN(k.DN)
		if seen[strings.ToLower(dn)] {
			continue
		}
		seen[strings.ToLower(dn)] = true
		c, err := dir.ReadComputer(dn)
		if err != nil {
			return 0, err
		}
		if c != nil {
			parents = append(parents, ComputerItem(*c))
		}
	}
	for _, b := range chunk(parents, r.BatchSize) {
		if _, err := r.API.SendComputers(ctx, ingest.ComputersBatch{RunID: runID, Items: b}); err != nil {
			return 0, err
		}
	}
	left := 0
	for _, b := range chunk(orphans, r.BatchSize) {
		res, err := r.API.SendKeys(ctx, ingest.KeysBatch{RunID: runID, Items: b})
		if err != nil {
			return 0, err
		}
		left += len(res.Orphans)
	}
	if left > 0 {
		r.Log.Warn(fmt.Sprintf("%d keys still have no known computer; they will be read again next run", left))
	}
	return left, nil
}

func (r *Runner) tryCompleteFailed(ctx context.Context, runID int64, code string) {
	if _, err := r.API.Complete(ctx, runID, failed(code)); err != nil {
		// The server aborts runs left open for 2 hours, so this is not fatal.
		r.Log.Warn(fmt.Sprintf("Could not mark run %d as failed: %v", runID, err))
	}
}

func failed(code string) ingest.CompleteRequest {
	return ingest.CompleteRequest{Status: "failed", Errors: 1, ErrorCode: &code}
}

func pick(items []ingest.KeyItem, ids []string) []ingest.KeyItem {
	if len(ids) == 0 {
		return nil
	}
	want := map[string]bool{}
	for _, id := range ids {
		want[strings.ToLower(id)] = true
	}
	var out []ingest.KeyItem
	for _, k := range items {
		if want[strings.ToLower(k.KeyID)] {
			out = append(out, k)
		}
	}
	return out
}

func chunk[T any](items []T, size int) [][]T {
	var out [][]T
	for size > 0 && len(items) > 0 {
		n := min(size, len(items))
		out = append(out, items[:n])
		items = items[n:]
	}
	return out
}

// ComputerItem converts a directory computer to its wire shape.
func ComputerItem(c directory.Computer) ingest.ComputerItem {
	return ingest.ComputerItem{ObjectGUID: c.ObjectGUID.String(), Name: c.Name, DNSName: c.DNSName, DN: c.DN,
		OS: c.OperatingSystem, USNChanged: c.USNChanged, WhenChanged: c.WhenChanged, WhenCreated: c.WhenCreated}
}

// KeyItem converts a directory key to its wire shape.
func KeyItem(k directory.RecoveryKey) ingest.KeyItem {
	item := ingest.KeyItem{KeyID: k.KeyID.String(), DN: k.DN, RecoveryPassword: k.RecoveryPassword, WhenCreated: k.WhenCreated}
	if k.VolumeGUID != nil {
		v := k.VolumeGUID.String()
		item.VolumeGUID = &v
	}
	return item
}
