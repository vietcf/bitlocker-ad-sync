package syncrun

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSaveCreatesTheFolderAndRoundTrips(t *testing.T) {
	path := filepath.Join(t.TempDir(), "var", "lib", "blk-sync", "state.json")
	store := &FileStateStore{Path: path}
	day := "2026-10-19"
	if err := store.Save(State{LastFullDate: &day}); err != nil {
		t.Fatal(err)
	}
	got := store.Load()
	if got.LastFullDate == nil || *got.LastFullDate != day {
		t.Errorf("loaded %+v", got)
	}
}

func TestSaveFailureTellsHowToFixTheFolder(t *testing.T) {
	// A folder cannot be created below a regular file: the same failure as a folder the service user may not create.
	file := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := (&FileStateStore{Path: filepath.Join(file, "sub", "state.json")}).Save(State{})
	if err == nil {
		t.Fatal("expected an error")
	}
	for _, want := range []string{"install -d -m 0750 -o blk-sync -g blk-sync", "full run"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q lacks %q", err.Error(), want)
		}
	}
}
