package ingest

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"strings"
	"sync/atomic"
	"time"
)

// Options configure the client (from config.Ingest).
type Options struct {
	BaseURL        string
	APIKey         string // already revealed; sent as Authorization: Bearer
	Timeout        time.Duration
	RetryFor       time.Duration
	RootCAs        *x509.CertPool // extra trusted CAs, optional
	SkipCertVerify bool           // lab only
}

// Client calls the ingest API. Every call is retried on network errors, timeouts and 5xx with
// exponential backoff (1s, 2s, 4s ... capped at 5 minutes) until RetryFor; 4xx answers are not
// retried. Request and response bodies are never logged.
type Client struct {
	opts    Options
	http    *http.Client
	log     *slog.Logger
	pending atomic.Int32
	// Sleep waits between retries (replaced in tests).
	Sleep func(ctx context.Context, d time.Duration) error
	// Now is the clock for the retry deadline (replaced in tests).
	Now func() time.Time
}

// NewClient builds a client with its HTTPS transport (trusted CAs; the API key goes in every request).
func NewClient(opts Options, log *slog.Logger) *Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: opts.RootCAs, InsecureSkipVerify: opts.SkipCertVerify} //nolint:gosec // lab option
	return NewClientWithHTTP(opts, &http.Client{Transport: transport, Timeout: opts.Timeout}, log)
}

// NewClientWithHTTP uses the given HTTP client (tests).
func NewClientWithHTTP(opts Options, h *http.Client, log *slog.Logger) *Client {
	opts.BaseURL = strings.TrimRight(opts.BaseURL, "/") + "/"
	return &Client{opts: opts, http: h, log: log, Sleep: sleep, Now: time.Now}
}

func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

func (c *Client) PendingRetries() int { return int(c.pending.Load()) }

func (c *Client) GetLastRun(ctx context.Context) (*LastRun, error) {
	// The server answers {} when there has never been a successful run.
	var raw map[string]json.RawMessage
	if err := c.send(ctx, http.MethodGet, "sync-runs/last", nil, &raw, true); err != nil {
		return nil, err
	}
	if _, ok := raw["runId"]; !ok {
		return nil, nil
	}
	b, _ := json.Marshal(raw)
	var last LastRun
	if err := json.Unmarshal(b, &last); err != nil {
		return nil, &Error{Message: "GET sync-runs/last: bad response: " + err.Error(), Status: 200, Err: err}
	}
	return &last, nil
}

func (c *Client) OpenRun(ctx context.Context, r OpenRunRequest) (out OpenRunResponse, err error) {
	return out, c.send(ctx, http.MethodPost, "sync-runs", r, &out, true)
}

func (c *Client) SendComputers(ctx context.Context, b ComputersBatch) (out ComputersResult, err error) {
	return out, c.send(ctx, http.MethodPost, "computers", b, &out, true)
}

func (c *Client) SendKeys(ctx context.Context, b KeysBatch) (out KeysResult, err error) {
	return out, c.send(ctx, http.MethodPost, "keys", b, &out, true)
}

func (c *Client) Complete(ctx context.Context, runID int64, r CompleteRequest) (out CompleteResult, err error) {
	return out, c.send(ctx, http.MethodPost, fmt.Sprintf("sync-runs/%d/complete", runID), r, &out, true)
}

// Heartbeat is tried once: the next one comes in a few minutes anyway, and a long retry would
// hold up the service loop.
func (c *Client) Heartbeat(ctx context.Context, r HeartbeatRequest) (out HeartbeatResponse, err error) {
	return out, c.send(ctx, http.MethodPost, "heartbeat", r, &out, false)
}

func (c *Client) send(ctx context.Context, method, path string, body, out any, retry bool) error {
	what := method + " " + path
	var payload []byte
	if body != nil {
		var err error
		if payload, err = json.Marshal(body); err != nil {
			return err
		}
	}
	deadline := c.Now()
	if retry {
		deadline = deadline.Add(c.opts.RetryFor)
	}
	for attempt := 1; ; attempt++ {
		err := c.once(ctx, method, path, what, payload, out)
		if err == nil {
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		var ie *Error
		if !errors.As(err, &ie) || !ie.Transient() {
			return err
		}
		wait := time.Duration(math.Min(300, math.Pow(2, float64(attempt-1)))) * time.Second
		if c.Now().Add(wait).After(deadline) {
			return err
		}
		c.log.Warn(fmt.Sprintf("Ingest API call failed (%s); retry %d in %ds", ie.Message, attempt, int(wait.Seconds())))
		c.pending.Add(1)
		serr := c.Sleep(ctx, wait)
		c.pending.Add(-1)
		if serr != nil {
			return serr
		}
	}
}

func (c *Client) once(ctx context.Context, method, path, what string, payload []byte, out any) error {
	var body io.Reader
	if payload != nil {
		body = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.opts.BaseURL+path, body)
	if err != nil {
		return err
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	if c.opts.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.opts.APIKey)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return &Error{Message: fmt.Sprintf("%s: %v", what, err), Err: err}
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return &Error{Message: fmt.Sprintf("%s: %v", what, err), Err: err}
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		var e struct {
			Error   string `json:"error"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(data, &e) // not JSON, e.g. a proxy error page
		return &Error{
			Message: strings.TrimSpace(fmt.Sprintf("%s: HTTP %d %s %s", what, resp.StatusCode, e.Error, e.Message)),
			Status:  resp.StatusCode,
			Code:    e.Error,
		}
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return &Error{Message: what + ": empty response", Status: resp.StatusCode}
	}
	if err := json.Unmarshal(data, out); err != nil {
		return &Error{Message: fmt.Sprintf("%s: bad response: %v", what, err), Status: resp.StatusCode, Err: err}
	}
	return nil
}
