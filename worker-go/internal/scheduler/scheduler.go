// Package scheduler is the service loop. One loop, so two runs never overlap:
//   - heartbeat every HeartbeatEvery; a manual request from Admin HQ starts that run now;
//   - a full run once a day at FullAt (and at first start, when none was ever done);
//   - otherwise a delta every DeltaEvery.
//
// Any failure is logged and the loop goes on.
package scheduler

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/bitlocker-management/worker-go/internal/ingest"
	"github.com/bitlocker-management/worker-go/internal/syncrun"
)

// Tick is how often the loop wakes up.
const Tick = 30 * time.Second

// Options of the loop (from config.Schedule).
type Options struct {
	DeltaEvery     time.Duration
	HeartbeatEvery time.Duration
	FullAtMinutes  int // minutes after local midnight
	WorkerID       string
	Version        string
}

// Scheduler runs the loop.
type Scheduler struct {
	Runner *syncrun.Runner
	API    ingest.API
	State  syncrun.StateStore
	Opts   Options
	Now    func() time.Time // local time
	Log    *slog.Logger

	last          *syncrun.Outcome
	nextHeartbeat time.Time
	nextDelta     time.Time
}

// Run loops until ctx is cancelled.
func (s *Scheduler) Run(ctx context.Context) {
	s.Log.Info(fmt.Sprintf("BitlockerSync worker (Go) %s started as %s", s.Opts.Version, s.Opts.WorkerID))
	for {
		if err := s.Step(ctx); err != nil {
			if ctx.Err() != nil {
				return
			}
			s.Log.Error("Scheduler step failed: " + err.Error())
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(Tick):
		}
	}
}

// Step is one pass of the loop (exported for tests).
func (s *Scheduler) Step(ctx context.Context) error {
	now := s.Now()
	var requested syncrun.Mode
	if !now.Before(s.nextHeartbeat) {
		s.nextHeartbeat = now.Add(s.Opts.HeartbeatEvery)
		requested = s.heartbeat(ctx)
	}

	mode := requested
	if mode == "" {
		switch {
		case s.isFullDue(now):
			mode = syncrun.Full
		case !now.Before(s.nextDelta):
			mode = syncrun.Delta
		default:
			return nil
		}
	} else {
		s.Log.Info(fmt.Sprintf("Admin HQ requested a %s sync", requested))
	}

	out, err := s.Runner.Run(ctx, mode)
	if err != nil {
		return err // tried again at the next tick, like the .NET worker
	}
	s.last = &out
	s.nextDelta = s.Now().Add(s.Opts.DeltaEvery)
	return nil
}

func (s *Scheduler) isFullDue(now time.Time) bool {
	last := s.State.Load().LastFullDate
	if last == nil {
		return true // first start: load everything
	}
	today := now.Format("2006-01-02")
	minutes := now.Hour()*60 + now.Minute()
	return *last < today && minutes >= s.Opts.FullAtMinutes
}

func (s *Scheduler) heartbeat(ctx context.Context) syncrun.Mode {
	q := s.API.PendingRetries()
	req := ingest.HeartbeatRequest{WorkerID: s.Opts.WorkerID, Version: &s.Opts.Version, QueueLen: &q}
	if s.last != nil {
		ok := s.last.LdapOK()
		req.LdapOK = &ok
		if s.last.ErrorCode != "" {
			code := s.last.ErrorCode
			req.LastErrorCode = &code
		}
		if s.last.Dc != nil {
			name := s.last.Dc.DNSHostName
			req.DcName = &name
			req.DcCertExpiresAt = s.last.Dc.CertificateExpiresAt
		}
	}
	res, err := s.API.Heartbeat(ctx, req)
	if err != nil {
		var ie *ingest.Error
		if errors.As(err, &ie) || ctx.Err() == nil {
			s.Log.Warn("Heartbeat failed: " + err.Error())
		}
		return ""
	}
	if res.SyncRequested != nil {
		switch *res.SyncRequested {
		case "full":
			return syncrun.Full
		case "delta":
			return syncrun.Delta
		}
	}
	return ""
}
