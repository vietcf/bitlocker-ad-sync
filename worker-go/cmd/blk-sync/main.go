// blk-sync: the BitLocker sync worker for Linux (Go). Same job and ingest protocol as the .NET
// worker in ../worker: reads computers and recovery keys from AD over LDAP and pushes them to the
// server's ingest API.
//
// Usage:
//
//	blk-sync [--config FILE]                       run as a service (systemd), until SIGTERM
//	blk-sync [--config FILE] run-once [full|delta] one sync run now, then exit (0 = success)
//	blk-sync [--config FILE] check                 validate the configuration and test LDAP
//	blk-sync version
//
// FILE defaults to $BLKSYNC_CONFIG, then config.json in the current folder, then config.json next
// to the program. config.example.json is the commented template of every setting.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/bitlocker-management/worker-go/internal/config"
	"github.com/bitlocker-management/worker-go/internal/directory"
	"github.com/bitlocker-management/worker-go/internal/ingest"
	"github.com/bitlocker-management/worker-go/internal/scheduler"
	"github.com/bitlocker-management/worker-go/internal/syncrun"
)

// version is set at build time: go build -ldflags "-X main.version=1.0.0".
var version = "1.0.0"

func main() { os.Exit(run(os.Args[1:])) }

func run(args []string) int {
	configPath := os.Getenv("BLKSYNC_CONFIG")
	var rest []string
	for i := 0; i < len(args); i++ {
		switch a := args[i]; {
		case a == "--config" && i+1 < len(args):
			configPath = args[i+1]
			i++
		case strings.HasPrefix(a, "--config="):
			configPath = strings.TrimPrefix(a, "--config=")
		default:
			rest = append(rest, a)
		}
	}
	command := ""
	if len(rest) > 0 {
		command = rest[0]
	}
	if command == "version" {
		fmt.Println(version)
		return 0
	}
	if configPath == "" {
		configPath = defaultConfigPath()
	}

	cfg, err := config.Load(configPath, os.Environ())
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	log := newLogger(cfg.Logging)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	app, err := build(cfg, log)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}

	switch command {
	case "":
		app.scheduler.Run(ctx)
		return 0
	case "run-once":
		mode := syncrun.Delta
		for _, a := range rest[1:] {
			if strings.EqualFold(a, "full") {
				mode = syncrun.Full
			}
		}
		out, err := app.runner.Run(ctx, mode)
		if err != nil {
			fmt.Fprintln(os.Stderr, "Run failed:", err)
			return 2
		}
		errText := ""
		if out.ErrorCode != "" {
			errText = ", error " + out.ErrorCode
		}
		fmt.Printf("Run %d: %s -> %s; computers %d, keys %d, orphans left %d%s\n",
			out.RunID, out.Mode, out.Status, out.ComputersSent, out.KeysSent, out.OrphansLeft, errText)
		if out.Status == "success" {
			return 0
		}
		return 2
	case "check":
		return check(ctx, app)
	default:
		fmt.Fprintf(os.Stderr, "Unknown command '%s'. Use: run-once [full|delta] | check | version\n", command)
		return 1
	}
}

// defaultConfigPath: config.json in the current folder (worker-go/ when developing), else next
// to the program (/opt/blk-sync/config.json style installs).
func defaultConfigPath() string {
	if _, err := os.Stat("config.json"); err == nil {
		return "config.json"
	}
	exe, _ := os.Executable()
	return filepath.Join(filepath.Dir(exe), "config.json")
}

type app struct {
	directories directory.Factory
	runner      *syncrun.Runner
	scheduler   *scheduler.Scheduler
}

func build(cfg *config.Config, log *slog.Logger) (*app, error) {
	var dirs directory.Factory
	if strings.EqualFold(cfg.Ldap.Source, "JsonFile") {
		dirs = &directory.JSONFileFactory{Path: cfg.Resolve(cfg.Ldap.JsonFilePath)}
	} else {
		password, err := config.Reveal(cfg.Ldap.Password)
		if err != nil {
			return nil, fmt.Errorf("Ldap.Password: %w", err)
		}
		pool, err := config.CertPool(cfg.Resolve(cfg.Ldap.CaFile))
		if err != nil {
			return nil, fmt.Errorf("Ldap.CaFile: %w", err)
		}
		dirs = &directory.LdapFactory{Log: log, Config: directory.LdapConfig{
			Servers:                   cfg.Ldap.Servers,
			Port:                      cfg.Ldap.EffectivePort(),
			Protocol:                  cfg.Ldap.ProtocolValue(),
			Username:                  cfg.Ldap.Username,
			Password:                  password,
			BaseDN:                    cfg.Ldap.BaseDn,
			SearchBases:               cfg.Ldap.EffectiveSearchBases(),
			PageSize:                  cfg.Ldap.PageSize,
			Timeout:                   time.Duration(cfg.Ldap.TimeoutSeconds) * time.Second,
			RootCAs:                   pool,
			SkipCertificateValidation: cfg.Ldap.SkipCertificateValidation,
		}}
	}

	apiKey, err := config.Reveal(cfg.Ingest.ApiKey)
	if err != nil {
		return nil, fmt.Errorf("Ingest.ApiKey: %w", err)
	}
	ingestCAs, err := config.CertPool(cfg.Resolve(cfg.Ingest.CaFile))
	if err != nil {
		return nil, fmt.Errorf("Ingest.CaFile: %w", err)
	}
	api := ingest.NewClient(ingest.Options{
		BaseURL:        cfg.Ingest.BaseUrl,
		APIKey:         apiKey,
		Timeout:        time.Duration(cfg.Ingest.TimeoutSeconds) * time.Second,
		RetryFor:       time.Duration(cfg.Ingest.RetryForMinutes) * time.Minute,
		RootCAs:        ingestCAs,
		SkipCertVerify: cfg.Ingest.SkipCertificateValidation,
	}, log)

	if cfg.Ingest.SkipCertificateValidation {
		log.Warn("Ingest.SkipCertificateValidation is on: the server's HTTPS certificate is not checked (encrypted, but a fake server would not be noticed). Lab / self-signed only; prefer Ingest.CaFile.")
	}

	state := &syncrun.FileStateStore{Path: cfg.Resolve(cfg.Schedule.StateFile)}
	runner := &syncrun.Runner{Directories: dirs, API: api, State: state, BatchSize: cfg.Ingest.BatchSize, Now: time.Now, Log: log}
	workerID := cfg.Schedule.WorkerId
	if strings.TrimSpace(workerID) == "" {
		workerID, _ = os.Hostname()
	}
	sched := &scheduler.Scheduler{
		Runner: runner, API: api, State: state, Now: time.Now, Log: log,
		Opts: scheduler.Options{
			DeltaEvery:     time.Duration(cfg.Schedule.DeltaEveryMinutes) * time.Minute,
			HeartbeatEvery: time.Duration(cfg.Schedule.HeartbeatEveryMinutes) * time.Minute,
			FullAtMinutes:  cfg.Schedule.FullAtMinutes(),
			WorkerID:       workerID,
			Version:        version + "-go",
		},
	}
	return &app{directories: dirs, runner: runner, scheduler: sched}, nil
}

// check validates the configuration (already done by Load) and tests the LDAP connection, one
// line per OU of Ldap.SearchBases. Exit codes: 0 ok, 3 cannot connect, 4 an OU cannot be read.
func check(ctx context.Context, a *app) int {
	dir := a.directories.Create()
	defer dir.Close()
	dc, err := dir.Connect(ctx)
	if err != nil {
		var de *directory.Error
		if errors.As(err, &de) {
			fmt.Fprintf(os.Stderr, "LDAP FAILED (%s): %s\n", de.APIErrorCode(), de.Message)
		} else {
			fmt.Fprintln(os.Stderr, "LDAP FAILED:", err)
		}
		return 3
	}
	inv, cert := "n/a", "n/a"
	if dc.InvocationID != nil {
		inv = dc.InvocationID.String()
	}
	if dc.CertificateExpiresAt != nil {
		cert = dc.CertificateExpiresAt.Format("2006-01-02")
	}
	fmt.Printf("LDAP OK: %s, highestCommittedUSN %d, invocationId %s, LDAPS certificate expires %s\n", dc.DNSHostName, dc.HighestCommittedUSN, inv, cert)

	ldapReader, ok := dir.(*directory.LdapReader)
	if !ok {
		n := 0
		stop := errors.New("enough")
		_ = dir.ReadComputers(ctx, nil, func(directory.Computer) error {
			n++
			if n >= 5 {
				return stop
			}
			return nil
		})
		fmt.Printf("Read access: first %d computers\n", n)
		return 0
	}
	probes := ldapReader.ProbeSearchBases(ctx, 5)
	code, warn := 0, false
	for _, p := range probes {
		if p.Error != "" {
			fmt.Printf("  FAIL  %s: %s\n", p.SearchBase, p.Error)
			code = 4
			continue
		}
		fmt.Printf("  OK    %s: first %d computers, first %d keys (%d without a readable password)\n", p.SearchBase, p.Computers, p.Keys, p.KeysWithoutPassword)
		if p.KeysWithoutPassword > 0 {
			warn = true
		}
	}
	if warn {
		fmt.Println("  WARNING: some keys have no readable password: grant read on msFVE-RecoveryPassword (worker-go/README.md 6.1).")
	}
	return code
}

func newLogger(c config.Logging) *slog.Logger {
	level := slog.LevelInfo
	switch strings.ToLower(c.Level) {
	case "debug", "trace":
		level = slog.LevelDebug
	case "warning", "warn":
		level = slog.LevelWarn
	case "error", "critical":
		level = slog.LevelError
	}
	opts := &slog.HandlerOptions{Level: level}
	if strings.EqualFold(c.Format, "json") {
		return slog.New(slog.NewJSONHandler(os.Stdout, opts))
	}
	return slog.New(slog.NewTextHandler(os.Stdout, opts))
}
