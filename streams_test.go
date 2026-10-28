package flow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestStreamsCalls(t *testing.T) {
	srv, calls := fakeEngine(t, func(call engineCall) (int, string) {
		switch {
		case strings.HasSuffix(call.path, "/open"):
			return 200, `{"created":true}`
		case strings.HasSuffix(call.path, "/append"):
			return 200, `{"offsets":["1","2"]}`
		case strings.HasSuffix(call.path, "/close"):
			return 200, `{"closed":true}`
		case call.path == "/v1/streams/token":
			return 200, `{"token":"tok","url":"wss://e/v1/streams/connect","stream":"run_1:1","expiresAt":9}`
		case call.method == "DELETE":
			return 200, `{"deleted":true}`
		}
		return 500, `{"error":"unexpected"}`
	})
	c := newClient(t, ClientOpts{BaseURL: StrPtr(srv.URL)})
	ctx := context.Background()
	s := c.Streams()

	created, err := s.Open(ctx, "run_1:1", StreamOpenOpts{Meta: map[string]string{"threadId": "t_1"}, TTL: time.Hour})
	if err != nil || !created {
		t.Fatalf("open = %v, %v", created, err)
	}
	offsets, err := s.Append(ctx, "run_1:1", map[string]int{"a": 1}, "two")
	if err != nil || len(offsets) != 2 || offsets[1] != "2" {
		t.Fatalf("append = %v, %v", offsets, err)
	}
	closed, err := s.Close(ctx, "run_1:1", map[string]string{"type": "RUN_FINISHED"}, 90*time.Second)
	if err != nil || !closed {
		t.Fatalf("close = %v, %v", closed, err)
	}
	deleted, err := s.Delete(ctx, "run_1:1")
	if err != nil || !deleted {
		t.Fatalf("delete = %v, %v", deleted, err)
	}
	tok, err := s.Token(ctx, "run_1:1")
	if err != nil || tok.Token != "tok" || tok.URL != "wss://e/v1/streams/connect" || tok.Stream != "run_1:1" || tok.ExpiresAt != 9 {
		t.Fatalf("token = %+v, %v", tok, err)
	}

	want := []struct{ method, path, body string }{
		{"POST", "/v1/streams/run_1:1/open", `{"appId":"billing","meta":{"threadId":"t_1"},"ttlMs":3600000}`},
		{"POST", "/v1/streams/run_1:1/append", `{"appId":"billing","items":[{"a":1},"two"]}`},
		{"POST", "/v1/streams/run_1:1/close", `{"appId":"billing","end":{"type":"RUN_FINISHED"},"graceMs":90000}`},
		{"DELETE", "/v1/streams/run_1:1", `null`},
		{"POST", "/v1/streams/token", `{"appId":"billing","stream":"run_1:1"}`},
	}
	for i, w := range want {
		got := (*calls)[i]
		b, _ := json.Marshal(got.body)
		if got.method != w.method || got.path != w.path || string(b) != w.body || got.auth != "Bearer "+testBearer {
			t.Fatalf("call %d = %+v, body = %s; want %+v", i, got, b, w)
		}
	}
	if got := (*calls)[3].query.Get("appId"); got != "billing" {
		t.Fatalf("delete appId = %q", got)
	}

	// Bad IDs and empty appends never reach the engine.
	n := len(*calls)
	if _, err := s.Open(ctx, "has space", StreamOpenOpts{TTL: time.Hour}); err == nil {
		t.Fatal("bad id: want an error")
	}
	if _, err := s.Append(ctx, "run_1:1"); err == nil {
		t.Fatal("no items: want an error")
	}
	if _, err := s.Token(ctx, strings.Repeat("a", 257)); err == nil {
		t.Fatal("long id: want an error")
	}
	for _, id := range []string{".", "..", "token", "connect"} {
		if _, err := s.Append(ctx, id, 1); err == nil {
			t.Fatalf("id %q: want an error", id)
		}
		for _, err := range s.Read(ctx, id, "") {
			if err == nil {
				t.Fatalf("read %q: want an error", id)
			}
		}
	}
	if _, err := s.Delete(ctx, "..."); err != nil {
		t.Fatalf("id ...: %v", err)
	}
	n++ // "..." is a fine id
	if len(*calls) != n {
		t.Fatalf("calls = %d, want %d", len(*calls), n)
	}
}

func TestStreamsErrors(t *testing.T) {
	srv, _ := fakeEngine(t, func(call engineCall) (int, string) {
		switch {
		case strings.HasPrefix(call.path, "/v1/streams/gone"):
			return 404, `{"error":"stream gone","status":404,"code":"StreamGone"}`
		case strings.HasPrefix(call.path, "/v1/streams/closed"):
			return 409, `{"error":"stream closed","status":409,"code":"StreamClosed"}`
		}
		return 413, `{"error":"stream full","status":413,"code":"StreamFull"}`
	})
	c := newClient(t, ClientOpts{BaseURL: StrPtr(srv.URL)})
	ctx := context.Background()
	_, err := c.Streams().Append(ctx, "gone", 1)
	if !errors.Is(err, ErrStreamGone) || errors.Is(err, ErrStreamClosed) || !strings.Contains(err.Error(), "(404): stream gone") {
		t.Fatalf("err = %v", err)
	}
	if _, err := c.Streams().Close(ctx, "gone", nil, 0); !errors.Is(err, ErrStreamGone) {
		t.Fatalf("err = %v", err)
	}
	if _, err := c.Streams().Append(ctx, "closed", 1); !errors.Is(err, ErrStreamClosed) || errors.Is(err, ErrStreamGone) {
		t.Fatalf("err = %v", err)
	}
	_, err = c.Streams().Append(ctx, "full", 1)
	if err == nil || errors.Is(err, ErrStreamGone) || errors.Is(err, ErrStreamClosed) || !strings.Contains(err.Error(), "(413)") {
		t.Fatalf("err = %v", err)
	}
	// Snapshot of a gone stream is nil, nil.
	snap, err := c.Streams().Snapshot(ctx, "gone", "")
	if snap != nil || err != nil {
		t.Fatalf("snapshot = %+v, %v", snap, err)
	}
}

func TestStreamsSnapshotReadsEveryPage(t *testing.T) {
	srv, calls := fakeEngine(t, func(call engineCall) (int, string) {
		if call.query.Get("after") == "" {
			return 200, `{"meta":{"threadId":"t_1"},"items":[{"offset":"1","item":"a"},{"offset":"2","item":"b"}],"ended":false,"more":true}`
		}
		return 200, `{"meta":{"threadId":"t_1"},"items":[{"offset":"3","item":{"type":"RUN_FINISHED"}}],"ended":true,"more":false}`
	})
	c := newClient(t, ClientOpts{BaseURL: StrPtr(srv.URL)})
	snap, err := c.Streams().Snapshot(context.Background(), "run_1:1", "")
	if err != nil {
		t.Fatal(err)
	}
	if string(snap.Meta) != `{"threadId":"t_1"}` || !snap.Ended || len(snap.Items) != 3 ||
		snap.Items[0].Offset != "1" || string(snap.Items[1].Item) != `"b"` || snap.Items[2].Offset != "3" {
		t.Fatalf("snapshot = %+v", snap)
	}
	if len(*calls) != 2 {
		t.Fatalf("calls = %d, want 2", len(*calls))
	}
	first, second := (*calls)[0], (*calls)[1]
	if first.method != "GET" || first.path != "/v1/streams/run_1:1" || first.query.Encode() != "appId=billing" ||
		second.query.Encode() != "after=2&appId=billing" || first.auth != "Bearer "+testBearer {
		t.Fatalf("calls = %+v", *calls)
	}
}

// readAll ranges over Read and gives the items and errors it yielded.
func readAll(ctx context.Context, c *Client, after string, stopAt int) ([]StreamItem, []error) {
	var items []StreamItem
	var errs []error
	for item, err := range c.Streams().Read(ctx, "run_1:1", after) {
		if err != nil {
			errs = append(errs, err)
			continue
		}
		items = append(items, item)
		if len(items) == stopAt {
			break
		}
	}
	return items, errs
}

func offsets(items []StreamItem) string {
	var b strings.Builder
	for _, it := range items {
		b.WriteString(it.Offset)
		if it.End {
			b.WriteString("!")
		}
		b.WriteString(" ")
	}
	return strings.TrimSpace(b.String())
}

func item(offset string, end bool) string {
	if end {
		return fmt.Sprintf(`{"offset":%q,"item":{"type":"RUN_FINISHED"},"end":true}`, offset)
	}
	return fmt.Sprintf(`{"offset":%q,"item":{"n":%s}}`, offset, offset)
}

func TestStreamsReadBacklogThenLiveUntilEnd(t *testing.T) {
	e := newWSEngine(t, func(n int, conn *websocket.Conn) {
		sendText(t, conn, item("3", false)) // the backlog after "2"
		sendText(t, conn, item("4", false))
		sendText(t, conn, "pong")
		time.Sleep(20 * time.Millisecond) // then a live one, and the end
		sendText(t, conn, item("5", false))
		sendText(t, conn, item("6", true))
		_ = conn.Close(websocket.StatusNormalClosure, "")
	})
	c := newClient(t, ClientOpts{BaseURL: StrPtr(e.srv.URL)})
	items, errs := readAll(context.Background(), c, "2", 0)
	if len(errs) != 0 || offsets(items) != "3 4 5 6!" || string(items[0].Item) != `{"n":3}` {
		t.Fatalf("items = %s, errs = %v", offsets(items), errs)
	}
	d := e.dialed()
	if len(d) != 1 || d[0].path != "/v1/streams/connect" || d[0].query.Encode() != "after=2&token=tok1" {
		t.Fatalf("sockets = %+v", d)
	}
	if b, _ := json.Marshal(e.tokens()[0]); string(b) != `{"appId":"billing","stream":"run_1:1"}` {
		t.Fatalf("token body = %s", b)
	}
}

func TestStreamsReadReconnectsFromLastOffset(t *testing.T) {
	shortSocketWaits(t, time.Hour, 10*time.Millisecond)
	e := newWSEngine(t, func(n int, conn *websocket.Conn) {
		switch n {
		case 1: // from the start; then a drop
			sendText(t, conn, item("1", false))
			sendText(t, conn, item("2", false))
			_ = conn.Close(websocket.StatusInternalError, "oops")
		case 2: // the socket's life ends: at once, from "3"
			sendText(t, conn, item("3", false))
			_ = conn.Close(closeExpired, "expired")
		default:
			sendText(t, conn, item("4", true))
			_ = conn.Close(websocket.StatusNormalClosure, "")
		}
	})
	c := newClient(t, ClientOpts{BaseURL: StrPtr(e.srv.URL)})
	items, errs := readAll(context.Background(), c, "", 0)
	if len(errs) != 0 || offsets(items) != "1 2 3 4!" {
		t.Fatalf("items = %s, errs = %v", offsets(items), errs)
	}
	d := e.dialed()
	if len(d) != 3 || d[0].query.Has("after") || d[1].query.Get("after") != "2" || d[2].query.Get("after") != "3" {
		t.Fatalf("sockets = %+v", d)
	}
	for i, s := range d {
		if s.query.Get("token") != fmt.Sprintf("tok%d", i+1) {
			t.Fatalf("socket %d token = %s", i, s.query.Get("token"))
		}
	}
}

func TestStreamsReadGone(t *testing.T) {
	e := newWSEngine(t, func(n int, conn *websocket.Conn) {
		sendText(t, conn, item("1", false))
		_ = conn.Close(closeGone, "gone")
	})
	c := newClient(t, ClientOpts{BaseURL: StrPtr(e.srv.URL)})
	items, errs := readAll(context.Background(), c, "", 0)
	if offsets(items) != "1" || len(errs) != 1 || !errors.Is(errs[0], ErrStreamGone) {
		t.Fatalf("items = %s, errs = %v", offsets(items), errs)
	}
	if len(e.dialed()) != 1 {
		t.Fatalf("sockets = %d, want 1", len(e.dialed()))
	}
}

func TestStreamsReadBreakClosesTheSocket(t *testing.T) {
	closeCode := make(chan websocket.StatusCode, 1)
	e := newWSEngine(t, func(n int, conn *websocket.Conn) {
		sendText(t, conn, item("1", false))
		sendText(t, conn, item("2", false))
		closeCode <- readUntilClose(conn)
	})
	c := newClient(t, ClientOpts{BaseURL: StrPtr(e.srv.URL)})
	items, errs := readAll(context.Background(), c, "", 1)
	if offsets(items) != "1" || len(errs) != 0 {
		t.Fatalf("items = %s, errs = %v", offsets(items), errs)
	}
	if code := recv(t, closeCode); code != websocket.StatusNormalClosure {
		t.Fatalf("close code = %d, want 1000", code)
	}
	if len(e.dialed()) != 1 {
		t.Fatalf("sockets = %d, want 1", len(e.dialed()))
	}
}

func TestStreamsReadStopsWhenCtxEnds(t *testing.T) {
	closeCode := make(chan websocket.StatusCode, 1)
	e := newWSEngine(t, func(n int, conn *websocket.Conn) {
		sendText(t, conn, item("1", false))
		closeCode <- readUntilClose(conn)
	})
	c := newClient(t, ClientOpts{BaseURL: StrPtr(e.srv.URL)})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var got []StreamItem
	for item, err := range c.Streams().Read(ctx, "run_1:1", "") {
		if err != nil {
			t.Fatal(err)
		}
		got = append(got, item)
		cancel() // the loop goes on; Read ends quietly
	}
	if offsets(got) != "1" {
		t.Fatalf("items = %s", offsets(got))
	}
	if code := recv(t, closeCode); code != websocket.StatusNormalClosure {
		t.Fatalf("close code = %d, want 1000", code)
	}
}

func TestStreamsReadTokenRefused(t *testing.T) {
	e := newWSEngine(t, func(int, *websocket.Conn) {})
	e.tokenStatus = 403
	c := newClient(t, ClientOpts{BaseURL: StrPtr(e.srv.URL)})
	items, errs := readAll(context.Background(), c, "", 0)
	if len(items) != 0 || len(errs) != 1 || !strings.Contains(errs[0].Error(), "(403)") {
		t.Fatalf("items = %v, errs = %v", items, errs)
	}
	if len(e.dialed()) != 0 {
		t.Fatal("dialed a socket without a token")
	}
}

func TestStreamsReadRetriesTokenOutage(t *testing.T) {
	shortSocketWaits(t, time.Hour, 10*time.Millisecond)
	e := newWSEngine(t, func(n int, conn *websocket.Conn) {
		sendText(t, conn, item("1", true))
		_ = conn.Close(websocket.StatusNormalClosure, "")
	})
	e.tokenFail = 2
	c := newClient(t, ClientOpts{BaseURL: StrPtr(e.srv.URL)})
	items, errs := readAll(context.Background(), c, "", 0)
	if offsets(items) != "1!" || len(errs) != 0 || len(e.tokens()) != 3 {
		t.Fatalf("items = %s, errs = %v, tokens = %d", offsets(items), errs, len(e.tokens()))
	}
}

func TestStreamsReadReconnectsAtOnceOn4001(t *testing.T) {
	shortSocketWaits(t, time.Hour, 2*time.Second)
	e := newWSEngine(t, func(n int, conn *websocket.Conn) {
		if n == 1 {
			sendText(t, conn, item("1", false))
			_ = conn.Close(closeExpired, "expired")
			return
		}
		sendText(t, conn, item("2", true))
		_ = conn.Close(websocket.StatusNormalClosure, "")
	})
	c := newClient(t, ClientOpts{BaseURL: StrPtr(e.srv.URL)})
	start := time.Now()
	items, errs := readAll(context.Background(), c, "", 0)
	if offsets(items) != "1 2!" || len(errs) != 0 {
		t.Fatalf("items = %s, errs = %v", offsets(items), errs)
	}
	// A backoff would be at least 1s here.
	if took := time.Since(start); took > 500*time.Millisecond {
		t.Fatalf("read took %v; 4001 must reconnect at once", took)
	}
	if d := e.dialed(); len(d) != 2 || d[1].query.Get("after") != "1" {
		t.Fatalf("sockets = %+v", d)
	}
}

func TestStreamsReadEndsQuietlyOn4100(t *testing.T) {
	shortSocketWaits(t, time.Hour, 10*time.Millisecond)
	e := newWSEngine(t, func(n int, conn *websocket.Conn) {
		_ = conn.Close(closeEnded, "ended")
	})
	c := newClient(t, ClientOpts{BaseURL: StrPtr(e.srv.URL)})
	items, errs := readAll(context.Background(), c, "9", 0)
	if len(items) != 0 || len(errs) != 0 {
		t.Fatalf("items = %v, errs = %v", items, errs)
	}
	if d := e.dialed(); len(d) != 1 || d[0].query.Get("after") != "9" {
		t.Fatalf("sockets = %+v; want one, no reconnect", d)
	}
}

func TestStreamsReadBadOffset(t *testing.T) {
	e := newWSEngine(t, func(int, *websocket.Conn) {})
	c := newClient(t, ClientOpts{BaseURL: StrPtr(e.srv.URL)})
	for _, after := range []string{"-1", "1.5", "abc", " 1", "1234567890123456"} {
		items, errs := readAll(context.Background(), c, after, 0)
		if len(items) != 0 || len(errs) != 1 || !strings.Contains(errs[0].Error(), "invalid stream offset") {
			t.Fatalf("after %q: items = %v, errs = %v", after, items, errs)
		}
	}
	if len(e.tokens()) != 0 || len(e.dialed()) != 0 {
		t.Fatal("a bad offset reached the engine")
	}
}

// Each range over the same sequence starts from the same offset.
func TestStreamsReadRangeTwice(t *testing.T) {
	e := newWSEngine(t, func(n int, conn *websocket.Conn) {
		sendText(t, conn, item("3", false))
		sendText(t, conn, item("4", true))
		_ = conn.Close(websocket.StatusNormalClosure, "")
	})
	c := newClient(t, ClientOpts{BaseURL: StrPtr(e.srv.URL)})
	seq := c.Streams().Read(context.Background(), "run_1:1", "2")
	for range 2 {
		var got []StreamItem
		for item, err := range seq {
			if err != nil {
				t.Fatal(err)
			}
			got = append(got, item)
		}
		if offsets(got) != "3 4!" {
			t.Fatalf("items = %s", offsets(got))
		}
	}
	if d := e.dialed(); len(d) != 2 || d[0].query.Get("after") != "2" || d[1].query.Get("after") != "2" {
		t.Fatalf("sockets = %+v", d)
	}
}

// The engine sends {"closing": code} before it closes with 4100, 4404 or
// 4001. Read acts on that frame, never yields it, and the close frame after
// it does not make a second reconnect.
func TestStreamsReadClosingFrame(t *testing.T) {
	shortSocketWaits(t, time.Hour, 2*time.Second) // a backoff would take 1s+
	type closingCase struct {
		code    websocket.StatusCode
		items   string
		gone    bool
		sockets int
		// late: the server sends no close frame until the client has gone,
		// so Read must act on the frame alone.
		late bool
	}
	var cases []closingCase
	for _, late := range []bool{false, true} {
		cases = append(cases,
			closingCase{closeEnded, "1", false, 1, late},
			closingCase{closeGone, "1", true, 1, late},
			closingCase{closeExpired, "1 2!", false, 2, late})
	}
	for _, tc := range cases {
		e := newWSEngine(t, func(n int, conn *websocket.Conn) {
			if n == 1 {
				sendText(t, conn, item("1", false))
				sendText(t, conn, fmt.Sprintf(`{"closing":%d}`, tc.code))
				if tc.late {
					readUntilClose(conn)
				}
				_ = conn.Close(tc.code, "")
				return
			}
			sendText(t, conn, item("2", true))
			_ = conn.Close(websocket.StatusNormalClosure, "")
		})
		c := newClient(t, ClientOpts{BaseURL: StrPtr(e.srv.URL)})
		start := time.Now()
		items, errs := readAll(context.Background(), c, "", 0)
		if offsets(items) != tc.items {
			t.Fatalf("%d: items = %s, want %s", tc.code, offsets(items), tc.items)
		}
		if gone := len(errs) == 1 && errors.Is(errs[0], ErrStreamGone); gone != tc.gone || (!tc.gone && len(errs) != 0) {
			t.Fatalf("%d: errs = %v", tc.code, errs)
		}
		if took := time.Since(start); took > 500*time.Millisecond {
			t.Fatalf("%d: read took %v; want no wait", tc.code, took)
		}
		// Give a wrong second reconnect time to show.
		time.Sleep(50 * time.Millisecond)
		if d := e.dialed(); len(d) != tc.sockets || (tc.sockets == 2 && d[1].query.Get("after") != "1") {
			t.Fatalf("%d: sockets = %+v", tc.code, d)
		}
	}
}
