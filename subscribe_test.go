package flow

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// wsEngine is a fake engine for sockets: it makes tokens (tok1, tok2, ...)
// whose url names another host, and hands each socket to onConn.
type wsEngine struct {
	srv    *httptest.Server
	onConn func(n int, conn *websocket.Conn)

	mu          sync.Mutex
	tokenBodies []map[string]any
	tokenFail   int        // answer the next tokenFail token calls with 500
	tokenStatus int        // when set, answer every token call with it
	conns       []wsDialed // the sockets, in order
}

type wsDialed struct {
	path  string
	query url.Values
	at    time.Time
}

func newWSEngine(t *testing.T, onConn func(n int, conn *websocket.Conn)) *wsEngine {
	t.Helper()
	e := &wsEngine{onConn: onConn}
	e.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/realtime/token", "/v1/streams/token":
			raw, _ := io.ReadAll(r.Body)
			var body map[string]any
			_ = json.Unmarshal(raw, &body)
			e.mu.Lock()
			e.tokenBodies = append(e.tokenBodies, body)
			n := len(e.tokenBodies)
			fail, status := e.tokenFail > 0, e.tokenStatus
			if fail {
				e.tokenFail--
			}
			e.mu.Unlock()
			if r.Header.Get("Authorization") != "Bearer "+testBearer {
				status = 401
			}
			if fail {
				status = 500
			}
			if status != 0 {
				w.WriteHeader(status)
				_, _ = fmt.Fprintf(w, `{"error":"no","status":%d}`, status)
				return
			}
			connect := strings.TrimSuffix(r.URL.Path, "token") + "connect"
			_, _ = fmt.Fprintf(w, `{"token":"tok%d","url":"wss://elsewhere.invalid%s","expiresAt":1}`, n, connect)
		case "/v1/realtime/connect", "/v1/streams/connect":
			e.mu.Lock()
			e.conns = append(e.conns, wsDialed{path: r.URL.Path, query: r.URL.Query(), at: time.Now()})
			n := len(e.conns)
			e.mu.Unlock()
			conn, err := websocket.Accept(w, r, nil)
			if err != nil {
				return
			}
			defer conn.CloseNow()
			e.onConn(n, conn)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(e.srv.Close)
	return e
}

func (e *wsEngine) dialed() []wsDialed {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]wsDialed(nil), e.conns...)
}

func (e *wsEngine) tokens() []map[string]any {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]map[string]any(nil), e.tokenBodies...)
}

// shortSocketWaits makes the ping and the backoff short for one test.
func shortSocketWaits(t *testing.T, ping, minWait time.Duration) {
	oldPing, oldMin, oldMax := pingEvery, minBackoff, maxBackoff
	pingEvery, minBackoff, maxBackoff = ping, minWait, 30*minWait
	t.Cleanup(func() { pingEvery, minBackoff, maxBackoff = oldPing, oldMin, oldMax })
}

// readUntilClose reads until the client closes, and gives the close code.
func readUntilClose(conn *websocket.Conn) websocket.StatusCode {
	for {
		if _, _, err := conn.Read(context.Background()); err != nil {
			return websocket.CloseStatus(err)
		}
	}
}

func sendText(t *testing.T, conn *websocket.Conn, text string) {
	if err := conn.Write(context.Background(), websocket.MessageText, []byte(text)); err != nil {
		t.Error(err)
	}
}

func recv[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(5 * time.Second):
		t.Fatal("timed out")
		panic("unreachable")
	}
}

func TestSubscribe(t *testing.T) {
	shortSocketWaits(t, 20*time.Millisecond, 2*time.Second)
	closed := make(chan time.Time, 1)
	lastClose := make(chan websocket.StatusCode, 1)
	e := newWSEngine(t, func(n int, conn *websocket.Conn) {
		switch n {
		case 1:
			sendText(t, conn, "pong") // ignored
			sendText(t, conn, "not json")
			sendText(t, conn, `{"channel":"thread.t_1","topic":"events","data":{"n":1},"ts":7}`)
			// Wait for the client's ping, then end the socket's life.
			typ, b, err := conn.Read(context.Background())
			if err != nil || typ != websocket.MessageText || string(b) != "ping" {
				t.Errorf("want a ping, got %v %q %v", typ, b, err)
			}
			closed <- time.Now()
			_ = conn.Close(closeExpired, "expired")
		default:
			sendText(t, conn, `{"channel":"thread.t_1","topic":"events","data":{"n":2},"ts":8}`)
			lastClose <- readUntilClose(conn)
		}
	})
	c := newClient(t, ClientOpts{BaseURL: StrPtr(e.srv.URL)})
	msgs := make(chan RealtimeMessage, 10)
	var mu sync.Mutex
	var states []RealtimeState
	stop, err := c.Realtime().Subscribe(context.Background(), SubscribeOpts{
		Channel:   "thread.t_1",
		Topics:    []string{"events"},
		OnMessage: func(m RealtimeMessage) { msgs <- m },
		OnState: func(s RealtimeState, err error) {
			mu.Lock()
			states = append(states, s)
			mu.Unlock()
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	m := recv(t, msgs)
	if m.Channel != "thread.t_1" || m.Topic != "events" || string(m.Data) != `{"n":1}` || m.TS != 7 {
		t.Fatalf("message = %+v", m)
	}
	m = recv(t, msgs)
	if string(m.Data) != `{"n":2}` {
		t.Fatalf("message = %+v", m)
	}
	stop()
	stop() // twice is fine
	if code := recv(t, lastClose); code != websocket.StatusNormalClosure {
		t.Fatalf("close code = %d, want 1000", code)
	}

	dialed := e.dialed()
	if len(dialed) != 2 {
		t.Fatalf("sockets = %d, want 2", len(dialed))
	}
	// A new token for every connect, and the socket at the base URL's host.
	for i, d := range dialed {
		if d.path != "/v1/realtime/connect" || d.query.Get("token") != fmt.Sprintf("tok%d", i+1) {
			t.Fatalf("socket %d = %+v", i, d)
		}
	}
	toks := e.tokens()
	if len(toks) != 2 {
		t.Fatalf("token calls = %d, want 2", len(toks))
	}
	if b, _ := json.Marshal(toks[0]); string(b) != `{"appId":"billing","channel":"thread.t_1","topics":["events"]}` {
		t.Fatalf("token body = %s", b)
	}
	// 4001: connect again at once, not after the 1s+ backoff.
	if gap := dialed[1].at.Sub(recv(t, closed)); gap > 500*time.Millisecond {
		t.Fatalf("reconnect after 4001 took %v", gap)
	}
	mu.Lock()
	defer mu.Unlock()
	want := "connecting open closed connecting open"
	if got := fmt.Sprint(states); got != "["+want+"]" {
		t.Fatalf("states = %v, want [%s]", got, want)
	}
	select {
	case m := <-msgs:
		t.Fatalf("extra message %+v", m)
	default:
	}
}

func TestSubscribeBacksOffAfterADrop(t *testing.T) {
	shortSocketWaits(t, time.Hour, 200*time.Millisecond)
	dropped := make(chan time.Time, 1)
	e := newWSEngine(t, func(n int, conn *websocket.Conn) {
		if n == 1 {
			dropped <- time.Now()
			_ = conn.CloseNow() // a drop, no close code
			return
		}
		readUntilClose(conn)
	})
	c := newClient(t, ClientOpts{BaseURL: StrPtr(e.srv.URL)})
	opened := make(chan struct{}, 10)
	stop, err := c.Realtime().Subscribe(context.Background(), SubscribeOpts{
		Channel: "c", Topics: []string{"t"}, OnMessage: func(RealtimeMessage) {},
		OnState: func(s RealtimeState, err error) {
			if s == RealtimeOpen {
				opened <- struct{}{}
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	recv(t, opened)
	recv(t, opened)
	dialed := e.dialed()
	// The first wait is 1 step (200ms here) times 0.5 to 1.0.
	if gap := dialed[1].at.Sub(recv(t, dropped)); gap < 100*time.Millisecond {
		t.Fatalf("reconnect after a drop took %v; want a backoff", gap)
	}
}

func TestSubscribeRetriesTokenErrors(t *testing.T) {
	shortSocketWaits(t, time.Hour, 10*time.Millisecond)
	e := newWSEngine(t, func(n int, conn *websocket.Conn) {
		sendText(t, conn, `{"channel":"a","topic":"t","data":1,"ts":1}`)
		readUntilClose(conn)
	})
	e.tokenFail = 2
	c := newClient(t, ClientOpts{BaseURL: StrPtr(e.srv.URL)})
	msgs := make(chan RealtimeMessage, 1)
	errs := make(chan error, 10)
	ctx, cancel := context.WithCancel(context.Background())
	stop, err := c.Realtime().Subscribe(ctx, SubscribeOpts{
		Channels: []string{"a", "b"}, Topics: []string{"t"},
		OnMessage: func(m RealtimeMessage) { msgs <- m },
		OnState: func(s RealtimeState, err error) {
			if s == RealtimeError {
				errs <- err
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	recv(t, msgs)
	if err := recv(t, errs); !strings.Contains(err.Error(), "(500)") {
		t.Fatalf("err = %v", err)
	}
	// Channels: the token is made with TokenMany.
	if b, _ := json.Marshal(e.tokens()[2]); string(b) != `{"appId":"billing","channels":["a","b"],"topics":["t"]}` {
		t.Fatalf("token body = %s", b)
	}
	// Ending ctx stops it too.
	cancel()
	stop()
	if n := len(e.tokens()); n != 3 {
		t.Fatalf("token calls = %d, want 3", n)
	}
}

func TestSubscribeStopFromCallback(t *testing.T) {
	e := newWSEngine(t, func(n int, conn *websocket.Conn) {
		sendText(t, conn, `{"channel":"a","topic":"t","data":1,"ts":1}`)
		readUntilClose(conn)
	})
	c := newClient(t, ClientOpts{BaseURL: StrPtr(e.srv.URL)})
	done := make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stop, err := c.Realtime().Subscribe(ctx, SubscribeOpts{
		Channel: "a", Topics: []string{"t"},
		OnMessage: func(RealtimeMessage) {
			cancel() // the way to end from a callback
			close(done)
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	recv(t, done)
	stop()
}

// stop from another goroutine waits for a running OnMessage to return.
func TestSubscribeStopWaitsForOnMessage(t *testing.T) {
	e := newWSEngine(t, func(n int, conn *websocket.Conn) {
		sendText(t, conn, `{"channel":"a","topic":"t","data":1,"ts":1}`)
		readUntilClose(conn)
	})
	c := newClient(t, ClientOpts{BaseURL: StrPtr(e.srv.URL)})
	inside, release := make(chan struct{}), make(chan struct{})
	var returned atomic.Bool
	stop, err := c.Realtime().Subscribe(context.Background(), SubscribeOpts{
		Channel: "a", Topics: []string{"t"},
		OnMessage: func(RealtimeMessage) {
			close(inside)
			<-release
			returned.Store(true)
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	recv(t, inside)
	stopped := make(chan struct{})
	go func() {
		stop()
		close(stopped)
	}()
	select {
	case <-stopped:
		t.Fatal("stop returned while OnMessage was running")
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
	recv(t, stopped)
	if !returned.Load() {
		t.Fatal("stop returned before OnMessage did")
	}
}

func TestSubscribeBadOptions(t *testing.T) {
	c := newClient(t, ClientOpts{})
	on := func(RealtimeMessage) {}
	for _, o := range []SubscribeOpts{
		{Topics: []string{"t"}, OnMessage: on},
		{Channel: "a", Channels: []string{"b"}, Topics: []string{"t"}, OnMessage: on},
		{Channel: "a", OnMessage: on},
		{Channel: "a", Topics: []string{"t"}},
		{Channels: make([]string, 101), Topics: []string{"t"}, OnMessage: on},
	} {
		if _, err := c.Realtime().Subscribe(context.Background(), o); err == nil {
			t.Fatalf("%+v: want an error", o)
		}
	}
}

func TestSocketURL(t *testing.T) {
	for _, tc := range []struct{ base, tok, want string }{
		{"https://engine.example.com", "wss://other.example.com/v1/realtime/connect", "wss://engine.example.com/v1/realtime/connect?token=t"},
		{"http://127.0.0.1:8787/", "wss://worker.flow.clevixstudio.com/v1/streams/connect", "ws://127.0.0.1:8787/v1/streams/connect?token=t"},
		{"https://proxy.example.com/flow", "ws://x/v1/streams/connect?old=1", "wss://proxy.example.com/flow/v1/streams/connect?token=t"},
	} {
		c := newClient(t, ClientOpts{BaseURL: StrPtr(tc.base)})
		got, err := c.socketURL(tc.tok, url.Values{"token": {"t"}})
		if err != nil || got != tc.want {
			t.Fatalf("socketURL(%s, %s) = %s, %v; want %s", tc.base, tc.tok, got, err, tc.want)
		}
	}
	c := newClient(t, ClientOpts{BaseURL: StrPtr("https://e")})
	if _, err := c.socketURL("", nil); err == nil {
		t.Fatal("no path: want an error")
	}
}

func TestBackoff(t *testing.T) {
	for _, tc := range []struct {
		failures int
		base     time.Duration
	}{{0, time.Second}, {1, 2 * time.Second}, {3, 8 * time.Second}, {4, 16 * time.Second}, {5, 30 * time.Second}, {40, 30 * time.Second}} {
		for range 20 {
			if d := backoff(tc.failures); d < tc.base/2 || d > tc.base {
				t.Fatalf("backoff(%d) = %v, want %v to %v", tc.failures, d, tc.base/2, tc.base)
			}
		}
	}
}
