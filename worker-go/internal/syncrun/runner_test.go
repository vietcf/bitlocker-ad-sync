package syncrun_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"slices"
	"testing"
	"time"

	"github.com/bitlocker-management/worker-go/internal/directory"
	"github.com/bitlocker-management/worker-go/internal/ingest"
	"github.com/bitlocker-management/worker-go/internal/syncrun"
	"github.com/bitlocker-management/worker-go/internal/testfakes"
)

var now = time.Date(2026, 10, 13, 10, 0, 0, 0, time.Local)

type env struct {
	ad    *testfakes.Directory
	api   *testfakes.API
	state *syncrun.MemoryStateStore
}

func setup() env {
	return env{testfakes.NewDirectory(), testfakes.NewAPI(), &syncrun.MemoryStateStore{}}
}

func (e env) runner(batch int) *syncrun.Runner {
	return &syncrun.Runner{Directories: e.ad, API: e.api, State: e.state, BatchSize: batch,
		Now: func() time.Time { return now }, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
}

func TestFullRunSendsAllComputersBeforeKeysInBatchesAndReportsTheSnapshotUSN(t *testing.T) {
	e := setup()
	for i := range 5 {
		e.ad.AddKey(e.ad.AddComputer(i, 500), 600, testfakes.Password)
	}
	e.ad.Dc.HighestCommittedUSN = 4242

	out, err := e.runner(2).Run(context.Background(), syncrun.Full)
	if err != nil || out.Status != "success" {
		t.Fatal(out, err)
	}
	if !slices.Equal(e.api.ComputerBatchSizes, []int{2, 2, 1}) {
		t.Error(e.api.ComputerBatchSizes)
	}
	lastComputers, firstKeys := -1, -1
	for i, c := range e.api.Calls {
		if c == "computers" {
			lastComputers = i
		}
		if c == "keys" && firstKeys < 0 {
			firstKeys = i
		}
	}
	if lastComputers > firstKeys {
		t.Error("computers must be sent before keys")
	}
	done := e.api.Completed[0]
	if len(e.api.Completed) != 1 || *done.HighestUSN != 4242 || *done.ComputersSeen != 5 || *done.KeysSeen != 5 || done.Errors != 0 {
		t.Errorf("%+v", done)
	}
	if e.state.State.LastFullDate == nil || *e.state.State.LastFullDate != "2026-10-13" {
		t.Error("last full date")
	}
}

func TestDeltaReadsOnlyObjectsChangedAfterTheServersSinceUSN(t *testing.T) {
	e := setup()
	old := e.ad.AddComputer(1, 50)
	changed := e.ad.AddComputer(2, 150)
	e.api.LastRun = &ingest.LastRun{RunID: 1, DcName: "dc01.corp.local", HighestUSN: 100}
	e.api.Know(old.DN)

	out, _ := e.runner(500).Run(context.Background(), syncrun.Delta)
	if out.Mode != syncrun.Delta || len(e.ad.ComputerQueries) != 1 || *e.ad.ComputerQueries[0] != 100 || out.ComputersSent != 1 || !e.api.IsKnown(changed.DN) {
		t.Errorf("%+v", out)
	}
}

func TestFollowsTheServerWhenItTurnsADeltaIntoAFullRun(t *testing.T) {
	e := setup()
	e.api.ForcedMode = "full"
	e.ad.AddComputer(1, 500)
	out, _ := e.runner(500).Run(context.Background(), syncrun.Delta)
	if out.Mode != syncrun.Full || e.ad.ComputerQueries[0] != nil {
		t.Errorf("%+v", out)
	}
}

func TestSendsTheParentComputerOfAnOrphanKeyAndTheKeyAgainInTheSameRun(t *testing.T) {
	e := setup()
	known := e.ad.AddComputer(1, 50) // not in this delta
	newPC := e.ad.AddComputer(2, 50) // also not in this delta, unknown to the server
	e.ad.AddKey(known, 150, testfakes.Password)
	e.ad.AddKey(newPC, 150, testfakes.Password) // its computer is unknown -> orphan
	e.api.Know(known.DN)

	out, _ := e.runner(500).Run(context.Background(), syncrun.Delta)
	done := e.api.Completed[0]
	if out.OrphansLeft != 0 || !e.api.IsKnown(newPC.DN) || *done.HighestUSN != e.ad.Dc.HighestCommittedUSN || done.Errors != 0 {
		t.Errorf("%+v %+v", out, done)
	}
}

func TestKeepsTheOldUSNWhenOrphanKeysRemainSoTheNextDeltaReadsThemAgain(t *testing.T) {
	e := setup()
	pc := e.ad.AddComputer(1, 50)
	e.ad.AddKey(pc, 150, testfakes.Password)
	e.api.NeverKnow(pc.DN) // the server never accepts this computer

	out, _ := e.runner(500).Run(context.Background(), syncrun.Delta)
	done := e.api.Completed[0]
	if out.OrphansLeft != 1 || *done.HighestUSN != e.api.SinceUSN || done.Errors != 1 {
		t.Errorf("%+v %+v", out, done)
	}
}

func TestRunsFullWhenTheDCWasRestoredNewInvocationID(t *testing.T) {
	e := setup()
	dc := "dc01.corp.local"
	other := testfakes.NewGUID()
	e.state.State = syncrun.State{DcName: &dc, InvocationID: &other}
	_, _ = e.runner(500).Run(context.Background(), syncrun.Delta)
	if e.api.Opened[0].Mode != "full" {
		t.Error(e.api.Opened)
	}
}

func TestRunsFullWhenTheDCUSNWentBack(t *testing.T) {
	e := setup()
	e.api.LastRun = &ingest.LastRun{RunID: 7, DcName: "dc01.corp.local", HighestUSN: 999_999}
	_, _ = e.runner(500).Run(context.Background(), syncrun.Delta)
	if e.api.Opened[0].Mode != "full" {
		t.Error(e.api.Opened)
	}
}

func TestClosesTheRunAsCancelledWhenTheServiceStopsMidRun(t *testing.T) {
	e := setup()
	e.ad.AddKey(e.ad.AddComputer(1, 500), 600, testfakes.Password)
	ctx, cancel := context.WithCancel(context.Background())
	e.api.StopWhileSendingKeys = cancel

	_, err := e.runner(500).Run(ctx, syncrun.Full)
	if !errors.Is(err, context.Canceled) {
		t.Fatal("expected cancellation, got", err)
	}
	done := e.api.Completed
	if len(done) != 1 || done[0].Status != "failed" || *done[0].ErrorCode != "cancelled" || e.state.State.LastFullDate != nil {
		t.Errorf("%+v", done)
	}
}

func TestReportsAFailedRunWithTheLDAPErrorCodeWhenADCannotBeRead(t *testing.T) {
	e := setup()
	e.ad.ConnectError = directory.NewError(directory.BindFailed, "invalid credentials", nil)

	out, err := e.runner(500).Run(context.Background(), syncrun.Delta)
	if err != nil || out.Status != "failed" || out.LdapOK() {
		t.Fatal(out, err)
	}
	done := e.api.Completed[0]
	if done.Status != "failed" || *done.ErrorCode != "ldap_bind_failed" || slices.Contains(e.api.Calls, "computers") {
		t.Errorf("%+v %v", done, e.api.Calls)
	}
}

func TestSendsKeysWithAnUnreadablePasswordAsEmptyStrings(t *testing.T) {
	e := setup()
	e.ad.AddKey(e.ad.AddComputer(1, 500), 600, "")
	out, _ := e.runner(500).Run(context.Background(), syncrun.Full)
	if out.KeysSent != 1 {
		t.Error(out)
	}
}

func TestReportsAnUnreadableOUAsAFailedRunWithItsOwnCode(t *testing.T) {
	e := setup()
	e.ad.AddComputer(1, 500)
	bad := &failingReader{Factory: e.ad}
	r := e.runner(500)
	r.Directories = bad
	out, err := r.Run(context.Background(), syncrun.Full)
	if err != nil || out.ErrorCode != "ldap_search_base_failed" || *e.api.Completed[0].ErrorCode != "ldap_search_base_failed" {
		t.Fatal(out, err, e.api.Completed)
	}
}

// failingReader fails the computer search like an unreadable OU.
type failingReader struct{ directory.Factory }

func (f *failingReader) Create() directory.Reader { return &failing{f.Factory.Create()} }

type failing struct{ directory.Reader }

func (f *failing) ReadComputers(context.Context, *int64, func(directory.Computer) error) error {
	return directory.NewError(directory.SearchBaseFailed, "the OU OU=X cannot be read", nil)
}

func TestSendsEveryKeyWithTheObjectGUIDOfItsComputer(t *testing.T) {
	e := setup()
	inRun := e.ad.AddComputer(1, 150)   // read in this delta
	notInRun := e.ad.AddComputer(2, 50) // unchanged: not in the delta, read from AD for its key
	e.api.Know(notInRun.DN)
	e.ad.AddKey(inRun, 160, testfakes.Password)
	e.ad.AddKey(notInRun, 160, testfakes.Password)

	if _, err := e.runner(500).Run(context.Background(), syncrun.Delta); err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, k := range e.api.SentKeys {
		if k.ComputerObjectGUID == nil {
			t.Fatalf("key %s sent without its computer objectGUID", k.KeyID)
		}
		got[k.KeyID] = *k.ComputerObjectGUID
	}
	if got[e.ad.Keys[0].KeyID.String()] != inRun.ObjectGUID.String() || got[e.ad.Keys[1].KeyID.String()] != notInRun.ObjectGUID.String() {
		t.Errorf("%v", got)
	}
}
