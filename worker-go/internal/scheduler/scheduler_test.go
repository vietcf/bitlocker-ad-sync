package scheduler_test

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/bitlocker-management/worker-go/internal/directory"
	"github.com/bitlocker-management/worker-go/internal/scheduler"
	"github.com/bitlocker-management/worker-go/internal/syncrun"
	"github.com/bitlocker-management/worker-go/internal/testfakes"
)

type env struct {
	ad    *testfakes.Directory
	api   *testfakes.API
	state *syncrun.MemoryStateStore
	now   time.Time
}

// 10:00 local time on 2026-10-13, like the .NET tests.
func setup() *env {
	return &env{testfakes.NewDirectory(), testfakes.NewAPI(), &syncrun.MemoryStateStore{}, time.Date(2026, 10, 13, 10, 0, 0, 0, time.Local)}
}

func (e *env) make() *scheduler.Scheduler {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	clock := func() time.Time { return e.now }
	runner := &syncrun.Runner{Directories: e.ad, API: e.api, State: e.state, BatchSize: 500, Now: clock, Log: log}
	return &scheduler.Scheduler{Runner: runner, API: e.api, State: e.state, Now: clock, Log: log,
		Opts: scheduler.Options{DeltaEvery: 15 * time.Minute, HeartbeatEvery: 5 * time.Minute, FullAtMinutes: 60, WorkerID: "w1", Version: "test"}}
}

func (e *env) lastMode() string { return e.api.Opened[len(e.api.Opened)-1].Mode }

func ptr(s string) *string { return &s }

func TestRunsAFullSyncAtFirstStartThenDeltas(t *testing.T) {
	e := setup()
	s := e.make()
	_ = s.Step(context.Background())
	if e.lastMode() != "full" || e.api.Calls[0] != "heartbeat" {
		t.Fatal(e.api.Calls)
	}
	e.now = e.now.Add(16 * time.Minute)
	_ = s.Step(context.Background())
	if e.lastMode() != "delta" {
		t.Error(e.lastMode())
	}
}

func TestWaitsForTheDeltaIntervalBetweenRuns(t *testing.T) {
	e := setup()
	s := e.make()
	_ = s.Step(context.Background())
	e.now = e.now.Add(5 * time.Minute)
	_ = s.Step(context.Background())
	if len(e.api.Opened) != 1 {
		t.Error(len(e.api.Opened))
	}
}

func TestRunsTheNightlyFullSyncOncePerDay(t *testing.T) {
	e := setup()
	e.state.State = syncrun.State{DcName: ptr("dc01.corp.local"), InvocationID: e.ad.Dc.InvocationID, LastFullDate: ptr("2026-10-12")}
	s := e.make()
	_ = s.Step(context.Background()) // 10:00, full for today not done yet
	if e.lastMode() != "full" {
		t.Fatal(e.lastMode())
	}
	e.now = e.now.Add(16 * time.Minute)
	_ = s.Step(context.Background())
	if e.lastMode() != "delta" {
		t.Error(e.lastMode())
	}
}

func TestStartsARunRequestedFromTheHeartbeatRightAway(t *testing.T) {
	e := setup()
	e.state.State = syncrun.State{DcName: ptr("dc01.corp.local"), InvocationID: e.ad.Dc.InvocationID, LastFullDate: ptr("2026-10-13")}
	s := e.make()
	_ = s.Step(context.Background()) // delta (first pass)
	e.api.SyncRequested = "full"
	e.now = e.now.Add(6 * time.Minute) // heartbeat due, delta not yet due
	_ = s.Step(context.Background())
	if e.lastMode() != "full" {
		t.Error(e.lastMode())
	}
}

func TestReportsTheLastLDAPProblemInTheNextHeartbeat(t *testing.T) {
	e := setup()
	e.ad.ConnectError = directory.NewError(directory.Unreachable, "down", nil)
	s := e.make()
	_ = s.Step(context.Background())
	e.now = e.now.Add(6 * time.Minute)
	_ = s.Step(context.Background())
	hb := e.api.Heartbeats[len(e.api.Heartbeats)-1]
	if hb.LdapOK == nil || *hb.LdapOK || hb.LastErrorCode == nil || *hb.LastErrorCode != "ldap_unreachable" || hb.WorkerID != "w1" {
		t.Errorf("%+v", hb)
	}
}
