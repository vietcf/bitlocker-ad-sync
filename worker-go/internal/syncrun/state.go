// Package syncrun runs one sync run: AD -> ingest API, as specified in the design doc.
package syncrun

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/bitlocker-management/worker-go/internal/directory"
)

// State is what the worker remembers between runs. No secrets. Same JSON as the .NET worker's
// state.json, so a state file can be moved between the two.
type State struct {
	DcName       *string         `json:"dcName"`
	InvocationID *directory.GUID `json:"invocationId"`
	LastFullDate *string         `json:"lastFullDate"` // YYYY-MM-DD, local time
}

// StateStore reads and writes the state.
type StateStore interface {
	Load() State
	Save(State) error
}

// FileStateStore keeps the state in a small JSON file (atomic replace, so a crash never leaves half a file).
type FileStateStore struct{ Path string }

func (s *FileStateStore) Load() State {
	b, err := os.ReadFile(s.Path)
	if err != nil {
		return State{}
	}
	var st State
	if json.Unmarshal(b, &st) != nil {
		return State{} // a damaged file only costs one extra full run
	}
	return st
}

func (s *FileStateStore) Save(st State) error {
	if err := os.MkdirAll(filepath.Dir(s.Path), 0o750); err != nil {
		return err
	}
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.Path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o640); err != nil {
		return err
	}
	return os.Rename(tmp, s.Path)
}

// MemoryStateStore keeps the state in memory (tests).
type MemoryStateStore struct{ State State }

func (m *MemoryStateStore) Load() State        { return m.State }
func (m *MemoryStateStore) Save(s State) error { m.State = s; return nil }
