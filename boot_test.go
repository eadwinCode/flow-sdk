package flow

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

// The sync at boot: see boot.go.

type bootCall struct {
	method, path, query, auth string
	body                      map[string]any
}

// bootEngine is a fake engine: check answers the GET, put the PUT.
type bootEngine struct {
	*httptest.Server
	mu    sync.Mutex
	calls []bootCall
	got   chan struct{} // one value per call
}

func newBootEngine(t *testing.T, check, put func(w http.ResponseWriter)) *bootEngine {
	t.Helper()
	e := &bootEngine{got: make(chan struct{}, 10)}
	e.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		call := bootCall{method: r.Method, path: r.URL.Path, query: r.URL.RawQuery, auth: r.Header.Get("Authorization")}
		if len(b) > 0 {
			_ = json.Unmarshal(b, &call.body)
		}
		e.mu.Lock()
		e.calls = append(e.calls, call)
		e.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && check != nil:
			check(w)
		case r.Method == http.MethodGet:
			_, _ = w.Write([]byte(`{"appId":"billing","manifestHash":null,"syncedAt":null}`))
		case put != nil:
			put(w)
		default:
			_, _ = w.Write([]byte(`{"ok":true}`))
		}
		e.got <- struct{}{}
	}))
	t.Cleanup(e.Close)
	return e
}

func (e *bootEngine) methods() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	var m []string
	for _, c := range e.calls {
		m = append(m, c.method)
	}
	return m
}

func (e *bootEngine) wait(t *testing.T, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		select {
		case <-e.got:
		case <-time.After(5 * time.Second):
			t.Fatalf("got %d calls, want %d", i, n)
		}
	}
}

// bootClient is a client with the sync at boot on, and one function.
func bootClient(t *testing.T, baseURL string) *Client {
	t.Helper()
	c, err := NewClient(ClientOpts{
		AppID: "billing", SigningKey: StrPtr(testKey), SigningKeyFallback: StrPtr(""),
		EventKey: StrPtr(""), BaseURL: StrPtr(baseURL), Dev: BoolPtr(false),
	})
	if err != nil {
		t.Fatal(err)
	}
	ok := func(ctx context.Context, in Input[any]) (any, error) { return nil, nil }
	if _, err := CreateFunction(c, FunctionOpts{ID: "charge"}, EventTrigger("billing/charge", nil), ok); err != nil {
		t.Fatal(err)
	}
	return c
}

// captureLog sends the standard logger to a buffer for the test.
func captureLog(t *testing.T) *syncBuffer {
	t.Helper()
	var b syncBuffer
	flags, out := log.Flags(), log.Writer()
	log.SetFlags(0)
	log.SetOutput(&b)
	t.Cleanup(func() { log.SetFlags(flags); log.SetOutput(out) })
	return &b
}

type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func TestManifestHash(t *testing.T) {
	c := bootClient(t, "")
	h := c.ManifestHash()
	if !regexp.MustCompile(`^v1:[0-9a-f]{64}$`).MatchString(h) {
		t.Fatalf("hash = %q", h)
	}
	// The URL is not part of it: every copy of the app has the same hash.
	if c.Manifest("https://a.example.com/api/flow").ManifestHash != h || c.Manifest("").ManifestHash != h {
		t.Fatal("the hash depends on the URL")
	}
	if bootClient(t, "").ManifestHash() != h {
		t.Fatal("the hash is not the same for the same functions")
	}
	ok := func(ctx context.Context, in Input[any]) (any, error) { return nil, nil }
	if _, err := CreateFunction(c, FunctionOpts{ID: "refund"}, EventTrigger("billing/refund", nil), ok); err != nil {
		t.Fatal(err)
	}
	if c.ManifestHash() == h {
		t.Fatal("a new function did not change the hash")
	}
}

func TestServeSyncsAtBoot(t *testing.T) {
	logs := captureLog(t)
	e := newBootEngine(t, nil, nil)
	c := bootClient(t, e.URL)
	c.Serve()
	c.Serve() // once: the second call does not check again
	e.wait(t, 2)

	if got := e.methods(); len(got) != 2 || got[0] != "GET" || got[1] != "PUT" {
		t.Fatalf("calls = %v", got)
	}
	for _, call := range e.calls {
		if call.path != "/apps/billing/sync" || call.auth != "Bearer "+testBearer {
			t.Fatalf("call = %+v", call)
		}
	}
	// The check sends this copy's hash.
	if q := e.calls[0].query; q != "hash="+url.QueryEscape(c.ManifestHash()) {
		t.Fatalf("check query = %q", q)
	}
	put := e.calls[1].body
	if _, has := put["url"]; has {
		t.Fatalf("the PUT at boot has a URL: %v", put)
	}
	if put["appId"] != "billing" || put["manifestHash"] != c.ManifestHash() {
		t.Fatalf("PUT body = %v", put)
	}
	if fns, _ := put["functions"].([]any); len(fns) != 1 {
		t.Fatalf("PUT functions = %v", put["functions"])
	}
	select {
	case <-e.got:
		t.Fatal("the sync at boot ran twice")
	case <-time.After(50 * time.Millisecond):
	}
	if !strings.Contains(logs.String(), "synced") {
		t.Fatalf("log = %q", logs.String())
	}
}

func TestSyncAtBootInSync(t *testing.T) {
	var hash string
	e := newBootEngine(t, func(w http.ResponseWriter) {
		_, _ = w.Write([]byte(`{"appId":"billing","manifestHash":"` + hash + `","syncedAt":1}`))
	}, nil)
	c := bootClient(t, e.URL)
	hash = c.ManifestHash()
	if got, _ := c.checkSync(context.Background()); got != bootInSync {
		t.Fatalf("got %s", got)
	}
	if got := e.methods(); len(got) != 1 {
		t.Fatalf("calls = %v", got)
	}
}

func TestSyncAtBootReplaced(t *testing.T) {
	logs := captureLog(t)
	e := newBootEngine(t, func(w http.ResponseWriter) {
		_, _ = w.Write([]byte(`{"appId":"billing","manifestHash":"v1:new","syncedAt":1}`))
	}, func(w http.ResponseWriter) {
		w.WriteHeader(409)
		_, _ = w.Write([]byte(`{"error":"this manifest was replaced","status":409,"code":"ManifestReplaced"}`))
	})
	if got, _ := bootClient(t, e.URL).checkSync(context.Background()); got != bootReplaced {
		t.Fatalf("got %s", got)
	}
	if !strings.Contains(logs.String(), "this manifest was replaced") {
		t.Fatalf("log = %q", logs.String())
	}
}

func TestSyncAtBootFailures(t *testing.T) {
	t.Run("new app with no URL: says how to sync it", func(t *testing.T) {
		logs := captureLog(t)
		e := newBootEngine(t, nil, func(w http.ResponseWriter) {
			w.WriteHeader(400)
			_, _ = w.Write([]byte(`{"error":"url must be http(s)","status":400}`))
		})
		if got, _ := bootClient(t, e.URL).checkSync(context.Background()); got != bootFailed {
			t.Fatalf("got %s", got)
		}
		if !strings.Contains(logs.String(), "curl -X PUT <app-url>") {
			t.Fatalf("log = %q", logs.String())
		}
	})
	t.Run("a failed check does not PUT", func(t *testing.T) {
		logs := captureLog(t)
		e := newBootEngine(t, func(w http.ResponseWriter) {
			w.WriteHeader(401)
			_, _ = w.Write([]byte(`{"error":"invalid signing key","status":401}`))
		}, nil)
		if got, _ := bootClient(t, e.URL).checkSync(context.Background()); got != bootFailed {
			t.Fatalf("got %s", got)
		}
		if got := e.methods(); len(got) != 1 || !strings.Contains(logs.String(), "invalid signing key") {
			t.Fatalf("calls = %v, log = %q", got, logs.String())
		}
	})
	t.Run("an engine that is down", func(t *testing.T) {
		captureLog(t)
		if got, _ := bootClient(t, "http://127.0.0.1:1").checkSync(context.Background()); got != bootFailed {
			t.Fatalf("got %s", got)
		}
	})
}

func TestSyncAtBootOff(t *testing.T) {
	e := newBootEngine(t, nil, nil)
	c, err := NewClient(ClientOpts{AppID: "billing", SigningKey: StrPtr(testKey), BaseURL: StrPtr(e.URL), NoSyncOnBoot: true})
	if err != nil {
		t.Fatal(err)
	}
	c.Serve()
	// Without a signing key (dev mode) it does nothing either.
	dev, err := NewClient(ClientOpts{AppID: "billing", SigningKey: StrPtr(""), BaseURL: StrPtr(e.URL), Dev: BoolPtr(true)})
	if err != nil {
		t.Fatal(err)
	}
	dev.Serve()
	if got, _ := dev.checkSync(context.Background()); got != bootNoKey {
		t.Fatalf("got %s", got)
	}
	time.Sleep(50 * time.Millisecond)
	if got := e.methods(); len(got) != 0 {
		t.Fatalf("calls = %v", got)
	}
}

func TestRetryDelay(t *testing.T) {
	now := time.UnixMilli(1_760_000_000_000)
	at := func(ms float64) *float64 { return &ms }
	in := float64(now.UnixMilli() + 60_000)
	// The app's clock is 10 minutes ahead: the engine's Date header wins.
	if d := retryDelay(at(in), now.UTC().Format(http.TimeFormat), now.Add(10*time.Minute)); d != 61*time.Second {
		t.Fatalf("with Date: %s", d)
	}
	if d := retryDelay(at(in), "", now); d != 61*time.Second {
		t.Fatalf("without Date: %s", d)
	}
	if d := retryDelay(at(float64(now.UnixMilli()-60_000)), "", now); d != 5*time.Second {
		t.Fatalf("in the past: %s", d)
	}
	if d := retryDelay(nil, "", now); d != 0 {
		t.Fatalf("no retryAt: %s", d)
	}
}

func TestSyncAtBootChecksAgainAfterReplaced(t *testing.T) {
	floor, slack := retryFloor, retrySlack
	retryFloor, retrySlack = 10*time.Millisecond, 0
	t.Cleanup(func() { retryFloor, retrySlack = floor, slack })
	logs := captureLog(t)

	var puts int
	var mu sync.Mutex
	e := newBootEngine(t, func(w http.ResponseWriter) {
		_, _ = w.Write([]byte(`{"appId":"billing","manifestHash":"v1:new","syncedAt":1}`))
	}, func(w http.ResponseWriter) {
		mu.Lock()
		puts++
		n := puts
		mu.Unlock()
		if n <= 2 {
			// retryAt is now: the floor (10 ms) is the wait.
			w.WriteHeader(409)
			_, _ = fmt.Fprintf(w, `{"error":"replaced","status":409,"code":"ManifestReplaced","retryAt":%d}`, time.Now().UnixMilli())
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	c := bootClient(t, e.URL)
	c.Serve()
	// A second 409 gives a new retryAt, so three checks in all.
	e.wait(t, 6)
	got := e.methods()
	if strings.Join(got, ",") != "GET,PUT,GET,PUT,GET,PUT" {
		t.Fatalf("calls = %v", got)
	}
	select {
	case <-e.got:
		t.Fatal("checked again after the sync worked")
	case <-time.After(50 * time.Millisecond):
	}
	if !strings.Contains(logs.String(), "checking again in") || !strings.Contains(logs.String(), "synced") {
		t.Fatalf("log = %q", logs.String())
	}
}

func TestSyncAtBootReplacedWithoutRetryAt(t *testing.T) {
	captureLog(t)
	e := newBootEngine(t, nil, func(w http.ResponseWriter) {
		w.WriteHeader(409)
		_, _ = w.Write([]byte(`{"error":"replaced","status":409,"code":"ManifestReplaced"}`))
	})
	if got, retry := bootClient(t, e.URL).checkSync(context.Background()); got != bootReplaced || retry != 0 {
		t.Fatalf("got %s, retry %s", got, retry)
	}
}

func TestManifestHashCoversWhatSyncSaves(t *testing.T) {
	c := bootClient(t, "")
	base := c.Manifest("")
	h := manifestHash(base)
	change := map[string]func(m *AppManifest){
		"retries":     func(m *AppManifest) { m.Functions[0].Retries = IntPtr(9) },
		"concurrency": func(m *AppManifest) { m.Functions[0].Concurrency = []Concurrency{{Limit: 3}} },
		"name":        func(m *AppManifest) { m.Functions[0].Name = "Charge it" },
		"sdk version": func(m *AppManifest) { m.SDK = &SDKInfo{Language: "go", Version: "9.9.9"} },
		"sdk language": func(m *AppManifest) {
			m.SDK = &SDKInfo{Language: "typescript", Version: Version}
		},
	}
	for name, f := range change {
		m := c.Manifest("")
		f(&m)
		if manifestHash(m) == h {
			t.Errorf("changing %s did not change the hash", name)
		}
	}
	if manifestHash(c.Manifest("https://other.example.com/api/flow")) != h {
		t.Error("the URL changed the hash")
	}
}

// shortWaits makes the waits short for a test.
func shortWaits(t *testing.T) {
	floor, slack, every := retryFloor, retrySlack, defaultCheckEvery
	retryFloor, retrySlack, defaultCheckEvery = time.Millisecond, 0, time.Hour
	t.Cleanup(func() { retryFloor, retrySlack, defaultCheckEvery = floor, slack, every })
}

func TestCheckSyncHeartbeatUntilClose(t *testing.T) {
	shortWaits(t)
	var hash string
	var mu sync.Mutex
	e := newBootEngine(t, func(w http.ResponseWriter) {
		mu.Lock()
		defer mu.Unlock()
		_, _ = w.Write([]byte(`{"appId":"billing","manifestHash":"` + hash + `","syncedAt":1,"retryAt":null,"checkEveryMs":20}`))
	}, nil)
	c := bootClient(t, e.URL)
	mu.Lock()
	hash = c.ManifestHash()
	mu.Unlock()
	c.Serve()
	e.wait(t, 3)
	c.Close()
	c.Close() // twice is fine
	select {
	case <-c.bootDone:
	case <-time.After(5 * time.Second):
		t.Fatal("the checks did not end on Close")
	}
	for len(e.got) > 0 {
		<-e.got
	}
	select {
	case <-e.got:
		t.Fatal("checked after Close")
	case <-time.After(100 * time.Millisecond):
	}
	for _, m := range e.methods() {
		if m != "GET" {
			t.Fatalf("in sync, but calls = %v", e.methods())
		}
	}
}

func TestCheckSyncWaitsWhileGuardIsOn(t *testing.T) {
	shortWaits(t)
	captureLog(t)
	var checks int
	var mu sync.Mutex
	e := newBootEngine(t, func(w http.ResponseWriter) {
		mu.Lock()
		checks++
		n := checks
		mu.Unlock()
		retryAt := "null"
		if n == 1 {
			retryAt = fmt.Sprint(time.Now().Add(30 * time.Millisecond).UnixMilli())
		}
		_, _ = fmt.Fprintf(w, `{"appId":"billing","manifestHash":"v1:old","syncedAt":1,"retryAt":%s,"checkEveryMs":3600000}`, retryAt)
	}, nil)
	c := bootClient(t, e.URL)
	if got, next := c.checkSync(context.Background()); got != bootWaiting || next <= 0 || next > time.Second {
		t.Fatalf("got %s, next %s", got, next)
	}
	if got := e.methods(); len(got) != 1 {
		t.Fatalf("PUT while the guard is on: %v", got)
	}
	// Once the guard is off: the PUT, then the heartbeat.
	if got, next := c.checkSync(context.Background()); got != bootSynced || next != time.Hour {
		t.Fatalf("got %s, next %s", got, next)
	}
	if got := strings.Join(e.methods(), ","); got != "GET,GET,PUT" {
		t.Fatalf("calls = %s", got)
	}
}

func TestCheckSyncNextTimes(t *testing.T) {
	captureLog(t)
	t.Run("an engine without the route (404) stops", func(t *testing.T) {
		e := newBootEngine(t, func(w http.ResponseWriter) { w.WriteHeader(404) }, nil)
		if got, next := bootClient(t, e.URL).checkSync(context.Background()); got != bootFailed || next != 0 {
			t.Fatalf("got %s, next %s", got, next)
		}
	})
	t.Run("a failed check tries again in 5 minutes", func(t *testing.T) {
		e := newBootEngine(t, func(w http.ResponseWriter) { w.WriteHeader(503) }, nil)
		if got, next := bootClient(t, e.URL).checkSync(context.Background()); got != bootFailed || next != 5*time.Minute {
			t.Fatalf("got %s, next %s", got, next)
		}
	})
	t.Run("in sync: checkEveryMs, even while the guard is on", func(t *testing.T) {
		var hash string
		e := newBootEngine(t, func(w http.ResponseWriter) {
			_, _ = fmt.Fprintf(w, `{"appId":"billing","manifestHash":%q,"syncedAt":1,"retryAt":1,"checkEveryMs":300000}`, hash)
		}, nil)
		c := bootClient(t, e.URL)
		hash = c.ManifestHash()
		if got, next := c.checkSync(context.Background()); got != bootInSync || next != 5*time.Minute {
			t.Fatalf("got %s, next %s", got, next)
		}
	})
}
