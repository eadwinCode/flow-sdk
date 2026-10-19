package flow

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type engineCall struct {
	path, auth string
	body       map[string]any
}

// fakeEngine records calls; answer picks the reply for each one.
func fakeEngine(t *testing.T, answer func(call engineCall) (int, string)) (*httptest.Server, *[]engineCall) {
	t.Helper()
	calls := &[]engineCall{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		call := engineCall{path: r.URL.Path, auth: r.Header.Get("Authorization")}
		_ = json.Unmarshal(raw, &call.body)
		*calls = append(*calls, call)
		status, body := answer(call)
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv, calls
}

func TestRealtimePublish(t *testing.T) {
	srv, calls := fakeEngine(t, func(engineCall) (int, string) { return 202, `{"ok":true}` })
	c := newClient(t, ClientOpts{BaseURL: StrPtr(srv.URL)})
	err := c.Realtime().Publish(context.Background(), "deployment:1", "progress", map[string]int{"pct": 40})
	if err != nil {
		t.Fatal(err)
	}
	got := (*calls)[0]
	if got.path != "/v1/realtime/publish" || got.auth != "Bearer "+testBearer {
		t.Fatalf("call = %+v", got)
	}
	b, _ := json.Marshal(got.body)
	if string(b) != `{"appId":"billing","channel":"deployment:1","data":{"pct":40},"topic":"progress"}` {
		t.Fatalf("body = %s", b)
	}
}

func TestRealtimePublishError(t *testing.T) {
	srv, _ := fakeEngine(t, func(engineCall) (int, string) { return 400, `{"error":"topic must be 1-64 characters"}` })
	c := newClient(t, ClientOpts{BaseURL: StrPtr(srv.URL)})
	err := c.Realtime().Publish(context.Background(), "c", "bad/topic", nil)
	if err == nil || !strings.Contains(err.Error(), "(400): topic must be") {
		t.Fatalf("err = %v", err)
	}
}

func TestRealtimeToken(t *testing.T) {
	srv, calls := fakeEngine(t, func(engineCall) (int, string) {
		return 200, `{"token":"tok","url":"wss://e/v1/realtime/connect","channel":"c","topics":["a","b"],"expiresAt":123}`
	})
	c := newClient(t, ClientOpts{BaseURL: StrPtr(srv.URL)})
	tok, err := c.Realtime().Token(context.Background(), "c", "a", "b")
	if err != nil {
		t.Fatal(err)
	}
	if tok.Token != "tok" || tok.URL != "wss://e/v1/realtime/connect" || len(tok.Topics) != 2 || tok.ExpiresAt != 123 {
		t.Fatalf("token = %+v", tok)
	}
	if got := (*calls)[0]; got.path != "/v1/realtime/token" || got.body["appId"] != "billing" {
		t.Fatalf("call = %+v", got)
	}
	if _, err := c.Realtime().Token(context.Background(), "c"); err == nil {
		t.Fatal("no topics: want an error")
	}
}

func TestRealtimeTriesFallbackKeyOn401(t *testing.T) {
	srv, calls := fakeEngine(t, func(call engineCall) (int, string) {
		if call.auth == "Bearer "+testBearer {
			return 202, `{"ok":true}`
		}
		return 401, `{"error":"invalid signing key"}`
	})
	// The new key is not known to the engine yet; the old one (testKey) is.
	c := newClient(t, ClientOpts{BaseURL: StrPtr(srv.URL), SigningKey: StrPtr(testFallback), SigningKeyFallback: StrPtr(testKey)})
	if err := c.Realtime().Publish(context.Background(), "c", "t", 1); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 2 {
		t.Fatalf("calls = %d, want 2", len(*calls))
	}
}
