package ingest

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type recorded struct {
	method, path, auth string
	body               string
}

func server(t *testing.T, handler func(w http.ResponseWriter, r *http.Request, n int)) (*Client, *[]recorded, *[]time.Duration) {
	var calls []recorded
	var waits []time.Duration
	n := 0
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		calls = append(calls, recorded{r.Method, r.URL.Path, r.Header.Get("Authorization"), string(b)})
		n++
		handler(w, r, n)
	}))
	t.Cleanup(ts.Close)
	c := NewClientWithHTTP(Options{BaseURL: ts.URL + "/api/ingest", APIKey: "the-key", RetryFor: time.Hour}, ts.Client(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	c.Sleep = func(_ context.Context, d time.Duration) error { waits = append(waits, d); return nil }
	return c, &calls, &waits
}

func reply(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}

func TestSendsCamelCaseJSONWithTheAPIKeyToTheRightPath(t *testing.T) {
	c, calls, _ := server(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
		reply(w, 201, `{"runId":7,"mode":"delta","sinceUsn":100}`)
	})
	out, err := c.OpenRun(context.Background(), OpenRunRequest{Mode: "delta", DcName: "dc01.corp.local"})
	if err != nil || out.RunID != 7 || out.SinceUSN != 100 {
		t.Fatal(out, err)
	}
	got := (*calls)[0]
	if got.method != "POST" || got.path != "/api/ingest/sync-runs" || got.auth != "Bearer the-key" ||
		got.body != `{"mode":"delta","dcName":"dc01.corp.local"}` {
		t.Errorf("%+v", got)
	}
}

func TestSendsNullsLikeTheDotNetWorker(t *testing.T) {
	c, calls, _ := server(t, func(w http.ResponseWriter, _ *http.Request, _ int) { reply(w, 200, `{"status":"failed"}`) })
	code := "ldap_unreachable"
	_, _ = c.Complete(context.Background(), 3, CompleteRequest{Status: "failed", Errors: 1, ErrorCode: &code})
	if (*calls)[0].path != "/api/ingest/sync-runs/3/complete" ||
		(*calls)[0].body != `{"status":"failed","highestUsn":null,"computersSeen":null,"keysSeen":null,"errors":1,"errorCode":"ldap_unreachable","dcHighestUsn":null}` {
		t.Errorf("%+v", (*calls)[0])
	}
}

func TestRetriesServerErrorsWithGrowingWaitsThenSucceeds(t *testing.T) {
	c, calls, waits := server(t, func(w http.ResponseWriter, _ *http.Request, n int) {
		if n < 3 {
			reply(w, 503, `{"error":"unavailable"}`)
			return
		}
		reply(w, 200, `{"upserted":1,"moved":0,"unmapped":0}`)
	})
	if _, err := c.SendComputers(context.Background(), ComputersBatch{RunID: 1}); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 3 || len(*waits) != 2 || (*waits)[0] != time.Second || (*waits)[1] != 2*time.Second {
		t.Errorf("calls %d waits %v", len(*calls), *waits)
	}
	if c.PendingRetries() != 0 {
		t.Error("pending retries must be back to 0")
	}
}

func TestDoesNotRetryClientErrorsAndKeepsTheErrorCode(t *testing.T) {
	c, calls, _ := server(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
		reply(w, 409, `{"error":"run_in_progress","message":"Another run is open."}`)
	})
	_, err := c.OpenRun(context.Background(), OpenRunRequest{Mode: "full", DcName: "dc"})
	ie, ok := err.(*Error)
	if !ok || ie.Status != 409 || ie.Code != "run_in_progress" || ie.Transient() || len(*calls) != 1 {
		t.Fatalf("%v (%d calls)", err, len(*calls))
	}
}

func TestGivesUpAfterRetryFor(t *testing.T) {
	c, calls, _ := server(t, func(w http.ResponseWriter, _ *http.Request, _ int) { reply(w, 500, `{}`) })
	c.opts.RetryFor = 3 * time.Second // waits 1s, 2s, then 4s would pass the deadline
	start := time.Unix(0, 0)
	elapsed := time.Duration(0)
	c.Now = func() time.Time { return start.Add(elapsed) }
	c.Sleep = func(_ context.Context, d time.Duration) error { elapsed += d; return nil }
	if _, err := c.SendKeys(context.Background(), KeysBatch{RunID: 1}); err == nil {
		t.Fatal("must give up")
	}
	if len(*calls) != 3 {
		t.Errorf("calls %d", len(*calls))
	}
}

func TestTriesAHeartbeatOnlyOnce(t *testing.T) {
	c, calls, _ := server(t, func(w http.ResponseWriter, _ *http.Request, _ int) { reply(w, 503, `{}`) })
	if _, err := c.Heartbeat(context.Background(), HeartbeatRequest{WorkerID: "w1"}); err == nil {
		t.Fatal("must fail")
	}
	if len(*calls) != 1 {
		t.Errorf("calls %d", len(*calls))
	}
}

func TestReadsAnEmptyLastRunAsNone(t *testing.T) {
	c, _, _ := server(t, func(w http.ResponseWriter, _ *http.Request, n int) {
		if n == 1 {
			reply(w, 200, `{}`)
			return
		}
		reply(w, 200, `{"runId":4,"dcName":"dc01","highestUsn":900,"finishedAt":"2026-10-14T01:00:00.000Z"}`)
	})
	if last, err := c.GetLastRun(context.Background()); last != nil || err != nil {
		t.Fatal(last, err)
	}
	last, err := c.GetLastRun(context.Background())
	if err != nil || last.RunID != 4 || last.HighestUSN != 900 {
		t.Fatal(last, err)
	}
}

func TestNeverPutsARecoveryPasswordAnywhereButTheKeysBody(t *testing.T) {
	const pw = "123456-234567-345678-456789-567890-678901-789012-890123"
	c, calls, _ := server(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
		reply(w, 200, `{"inserted":1,"skipped":0,"emptyPassword":0,"orphans":[]}`)
	})
	item := KeyItem{KeyID: "1a2b3c4d-0000-0000-0000-000000000000", DN: "CN=x,CN=PC", RecoveryPassword: pw, WhenCreated: time.Now()}
	if _, err := c.SendKeys(context.Background(), KeysBatch{RunID: 1, Items: []KeyItem{item}}); err != nil {
		t.Fatal(err)
	}
	got := (*calls)[0]
	var body KeysBatch
	_ = json.Unmarshal([]byte(got.body), &body)
	if body.Items[0].RecoveryPassword != pw || strings.Contains(got.path, pw) || strings.Contains(got.auth, pw) {
		t.Error("password must travel in the body only")
	}
	for _, s := range []string{item.String(), item.GoString()} {
		if strings.Contains(s, "123456") {
			t.Error("KeyItem must not print the password")
		}
	}
}
