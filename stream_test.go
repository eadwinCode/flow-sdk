package flow

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/eadwinCode/flow-sdk/internal/core"
)

// streamed is a streamed answer, read back (see stream.go).
type streamed struct {
	heartbeats int
	meta       streamMeta
	body       []byte
}

func readStreamed(t *testing.T, text []byte) streamed {
	t.Helper()
	s := string(text)
	n := len(s) - len(strings.TrimLeft(s, "\n"))
	rest := s[n:]
	i := strings.IndexByte(rest, '\n')
	if i < 0 {
		t.Fatalf("no meta line in %q", s)
	}
	var m streamMeta
	if err := json.Unmarshal([]byte(rest[:i]), &m); err != nil {
		t.Fatalf("meta line %q: %v", rest[:i], err)
	}
	return streamed{heartbeats: n, meta: m, body: []byte(rest[i+1:])}
}

func str(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// sendStreamed is send with X-Flow-Stream: 1.
func sendStreamed(t *testing.T, c *Client, body []byte) (answer, string) {
	t.Helper()
	sig, err := signRequest(testKey, body, testNow)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "https://billing.example.com/api/flow", strings.NewReader(string(body)))
	r.Header.Set(core.HeaderSignature, sig)
	r.Header.Set(core.HeaderStream, "1")
	w := httptest.NewRecorder()
	c.Serve().ServeHTTP(w, r)
	res := w.Result()
	b, _ := io.ReadAll(res.Body)
	return answer{status: res.StatusCode, header: res.Header, body: b}, sig
}

func TestStreamedAnswers(t *testing.T) {
	c := newClient(t, ClientOpts{})
	define(t, c, "ok", func(ctx context.Context, in Input[charge]) (any, error) { return "done", nil })
	define(t, c, "bad", func(ctx context.Context, in Input[charge]) (any, error) {
		return nil, NoRetryError(errors.New("no"))
	})
	define(t, c, "later", func(ctx context.Context, in Input[charge]) (any, error) {
		return nil, RetryAtError(errors.New("later"), testNow.Add(time.Minute))
	})
	for _, id := range []string{"ok", "bad", "later", "missing"} {
		body := invokeBody(t, id, reqOpts{})
		normal := signedPost(t, c, body)
		a, sig := sendStreamed(t, c, body)
		if a.status != 200 || a.header.Get(core.HeaderStream) != "1" {
			t.Fatalf("%s: status %d, stream header %q", id, a.status, a.header.Get(core.HeaderStream))
		}
		if a.header.Get("Content-Type") != "text/plain; charset=utf-8" || a.header.Get("X-Accel-Buffering") != "no" ||
			a.header.Get("Cache-Control") != "no-store, no-transform" || a.header.Get(core.HeaderAnswerSignature) != "" {
			t.Fatalf("%s: headers %v", id, a.header)
		}
		s := readStreamed(t, a.body)
		if s.heartbeats < 1 {
			t.Errorf("%s: no heartbeat", id)
		}
		if s.meta.Status != normal.status || string(s.body) != string(normal.body) ||
			str(s.meta.NoRetry) != normal.header.Get(core.HeaderNoRetry) ||
			str(s.meta.RetryAfter) != normal.header.Get(core.HeaderRetryAfter) {
			t.Errorf("%s: streamed %+v %s, normal %d %v %s", id, s.meta, s.body, normal.status, normal.header, normal.body)
		}
		want, err := signAnswer(testKey, sig, s.meta.Status, str(s.meta.NoRetry), str(s.meta.RetryAfter), s.body)
		if err != nil || str(s.meta.Signature) != want {
			t.Errorf("%s: signature %q, want %q", id, str(s.meta.Signature), want)
		}
	}
}

func TestStreamedAnswerHeartbeats(t *testing.T) {
	c := newClient(t, ClientOpts{HeartbeatInterval: 5 * time.Millisecond})
	gate := make(chan struct{})
	define(t, c, "slow", func(ctx context.Context, in Input[charge]) (any, error) {
		<-gate
		return "late", nil
	})
	srv := httptest.NewServer(c.Serve())
	defer srv.Close()
	body := invokeBody(t, "slow", reqOpts{})
	sig, _ := signRequest(testKey, body, testNow)
	req, _ := http.NewRequest(http.MethodPost, srv.URL, strings.NewReader(string(body)))
	req.Header.Set(core.HeaderSignature, sig)
	req.Header.Set(core.HeaderStream, "1")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	r := bufio.NewReader(res.Body)
	// Three heartbeats come before the function ends.
	for i := 0; i < 3; i++ {
		b, err := r.ReadByte()
		if err != nil || b != '\n' {
			t.Fatalf("heartbeat %d: %q %v", i, b, err)
		}
	}
	close(gate)
	rest, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	s := readStreamed(t, rest)
	if s.meta.Status != 200 || string(s.body) != `"late"` {
		t.Fatalf("answer %+v %s", s.meta, s.body)
	}
}

func TestStreamedAnswerStopsWhenEngineGoesAway(t *testing.T) {
	c := newClient(t, ClientOpts{HeartbeatInterval: time.Millisecond})
	stop := make(chan struct{})
	define(t, c, "slow", func(ctx context.Context, in Input[charge]) (any, error) {
		<-stop
		return nil, nil
	})
	body := invokeBody(t, "slow", reqOpts{})
	sig, _ := signRequest(testKey, body, testNow)
	ctx, cancel := context.WithCancel(context.Background())
	r := httptest.NewRequest(http.MethodPost, "https://billing.example.com/api/flow", strings.NewReader(string(body))).WithContext(ctx)
	r.Header.Set(core.HeaderSignature, sig)
	r.Header.Set(core.HeaderStream, "1")
	w := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		c.Serve().ServeHTTP(w, r)
		close(done)
	}()
	time.Sleep(10 * time.Millisecond)
	cancel()
	close(stop)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("the handler did not return")
	}
}

// noFlush is a ResponseWriter that can not flush.
type noFlush struct{ w http.ResponseWriter }

func (n noFlush) Header() http.Header         { return n.w.Header() }
func (n noFlush) Write(b []byte) (int, error) { return n.w.Write(b) }
func (n noFlush) WriteHeader(s int)           { n.w.WriteHeader(s) }

func TestStreamedAnswerNotUsed(t *testing.T) {
	define2 := func(c *Client) {
		define(t, c, "ok", func(ctx context.Context, in Input[charge]) (any, error) { return "done", nil })
	}
	// No request header: the normal answer.
	c := newClient(t, ClientOpts{})
	define2(c)
	if a := run(t, c, "ok", reqOpts{}); a.header.Get(core.HeaderStream) != "" || string(a.body) != `"done"` {
		t.Fatalf("no header: %v %s", a.header, a.body)
	}
	// NoStreaming: the normal answer even when asked.
	off := newClient(t, ClientOpts{NoStreaming: true})
	define2(off)
	if a, _ := sendStreamed(t, off, invokeBody(t, "ok", reqOpts{})); a.header.Get(core.HeaderStream) != "" || string(a.body) != `"done"` {
		t.Fatalf("NoStreaming: %v %s", a.header, a.body)
	}
	// A writer that can not flush: the normal answer.
	body := invokeBody(t, "ok", reqOpts{})
	sig, _ := signRequest(testKey, body, testNow)
	r := httptest.NewRequest(http.MethodPost, "https://billing.example.com/api/flow", strings.NewReader(string(body)))
	r.Header.Set(core.HeaderSignature, sig)
	r.Header.Set(core.HeaderStream, "1")
	w := httptest.NewRecorder()
	c.Serve().ServeHTTP(noFlush{w}, r)
	if w.Header().Get(core.HeaderStream) != "" || w.Body.String() != `"done"` {
		t.Fatalf("no flush: %v %s", w.Header(), w.Body.String())
	}
	// A bad request is never streamed.
	if a, _ := sendStreamed(t, c, []byte("not json")); a.status != 400 || a.header.Get(core.HeaderStream) != "" {
		t.Fatalf("bad request: %d %v", a.status, a.header)
	}
	// A refused call (401) is never streamed.
	r = httptest.NewRequest(http.MethodPost, "https://billing.example.com/api/flow", strings.NewReader(string(body)))
	r.Header.Set(core.HeaderStream, "1")
	w = httptest.NewRecorder()
	c.Serve().ServeHTTP(w, r)
	if w.Code != 401 || w.Header().Get(core.HeaderStream) != "" {
		t.Fatalf("401: %d %v", w.Code, w.Header())
	}
}

func TestStreamedAnswerDevModeUnsigned(t *testing.T) {
	c := newClient(t, ClientOpts{SigningKey: StrPtr(""), Dev: BoolPtr(true)})
	define(t, c, "ok", func(ctx context.Context, in Input[charge]) (any, error) { return "done", nil })
	r := httptest.NewRequest(http.MethodPost, "https://billing.example.com/api/flow", strings.NewReader(string(invokeBody(t, "ok", reqOpts{}))))
	r.Header.Set(core.HeaderStream, "1")
	w := httptest.NewRecorder()
	c.Serve().ServeHTTP(w, r)
	s := readStreamed(t, w.Body.Bytes())
	if s.meta.Status != 200 || s.meta.Signature != nil {
		t.Fatalf("dev answer %+v", s.meta)
	}
}

func TestHeartbeatIntervalNotNegative(t *testing.T) {
	if _, err := NewClient(ClientOpts{AppID: "billing", SigningKey: StrPtr(testKey), HeartbeatInterval: -time.Second}); err == nil {
		t.Fatal("a negative HeartbeatInterval was taken")
	}
}
