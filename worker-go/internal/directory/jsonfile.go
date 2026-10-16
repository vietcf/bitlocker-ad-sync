package directory

import (
	"context"
	"encoding/json"
	"os"
	"strings"
)

// JSONFileFactory is a development stand-in for Active Directory: it reads computers and keys
// from a JSON file, so the whole pipeline can run against the API without a domain controller.
// Never use in production. File: { "dc": {...}, "computers": [Computer], "keys": [RecoveryKey] }
// (the same file as the .NET worker's sample-directory.json).
type JSONFileFactory struct{ Path string }

func (f *JSONFileFactory) PreferredServer() string { return "json-file" }
func (f *JSONFileFactory) Create() Reader          { return &JSONFileReader{path: f.Path} }

type jsonData struct {
	Dc        DcInfo        `json:"dc"`
	Computers []Computer    `json:"computers"`
	Keys      []RecoveryKey `json:"keys"`
}

// JSONFileReader reads the sample file.
type JSONFileReader struct {
	path string
	data *jsonData
}

func (r *JSONFileReader) Connect(ctx context.Context) (DcInfo, error) {
	b, err := os.ReadFile(r.path)
	if err != nil {
		return DcInfo{}, NewError(Unreachable, "Sample directory file not found: "+r.path, err)
	}
	var d jsonData
	if err := json.Unmarshal(b, &d); err != nil {
		return DcInfo{}, NewError(Other, "Bad sample directory file: "+r.path+": "+err.Error(), err)
	}
	r.data = &d
	return d.Dc, nil
}

func (r *JSONFileReader) ReadDcInfo() (DcInfo, error) { return r.data.Dc, nil }

func (r *JSONFileReader) ReadComputers(ctx context.Context, sinceUSN *int64, yield func(Computer) error) error {
	for _, c := range r.data.Computers {
		if sinceUSN == nil || c.USNChanged > *sinceUSN {
			if err := yield(c); err != nil {
				return err
			}
		}
	}
	return nil
}

func (r *JSONFileReader) ReadRecoveryKeys(ctx context.Context, sinceUSN *int64, yield func(RecoveryKey) error) error {
	for _, k := range r.data.Keys {
		if sinceUSN == nil || k.USNChanged > *sinceUSN {
			if err := yield(k); err != nil {
				return err
			}
		}
	}
	return nil
}

func (r *JSONFileReader) ReadComputer(dn string) (*Computer, error) {
	for _, c := range r.data.Computers {
		if strings.EqualFold(c.DN, dn) {
			c := c
			return &c, nil
		}
	}
	return nil, nil
}

func (r *JSONFileReader) Close() error { return nil }
