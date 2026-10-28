package flow

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

type engineCall struct {
	method, path, auth string
	query              url.Values
	body               map[string]any
}

// fakeEngine records calls; answer picks the reply for each one.
func fakeEngine(t *testing.T, answer func(call engineCall) (int, string)) (*httptest.Server, *[]engineCall) {
	t.Helper()
	calls := &[]engineCall{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		call := engineCall{method: r.Method, path: r.URL.Path, query: r.URL.Query(), auth: r.Header.Get("Authorization")}
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
	if _, err := c.Realtime().Token(context.Background(), "", "a"); err == nil {
		t.Fatal("no channel: want an error")
	}
	if len(*calls) != 1 {
		t.Fatalf("calls = %d, want 1", len(*calls))
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

func TestRealtimeTokenMany(t *testing.T) {
	srv, calls := fakeEngine(t, func(engineCall) (int, string) {
		return 200, `{"token":"tok","url":"wss://e/v1/realtime/connect","channels":["a","b"],"topics":["t"],"expiresAt":5}`
	})
	c := newClient(t, ClientOpts{BaseURL: StrPtr(srv.URL)})
	tok, err := c.Realtime().TokenMany(context.Background(), []string{"a", "b"}, "t")
	if err != nil {
		t.Fatal(err)
	}
	if tok.Token != "tok" || tok.Channel != "" || len(tok.Channels) != 2 || tok.Channels[1] != "b" || tok.ExpiresAt != 5 {
		t.Fatalf("token = %+v", tok)
	}
	got := (*calls)[0]
	b, _ := json.Marshal(got.body)
	if got.method != "POST" || got.path != "/v1/realtime/token" || got.auth != "Bearer "+testBearer ||
		string(b) != `{"appId":"billing","channels":["a","b"],"topics":["t"]}` {
		t.Fatalf("call = %+v, body = %s", got, b)
	}
	if _, err := c.Realtime().TokenMany(context.Background(), nil, "t"); err == nil {
		t.Fatal("no channels: want an error")
	}
	if _, err := c.Realtime().TokenMany(context.Background(), []string{"a"}); err == nil {
		t.Fatal("no topics: want an error")
	}
}

func TestRealtimePublishMany(t *testing.T) {
	srv, calls := fakeEngine(t, func(engineCall) (int, string) { return 202, `{"ok":true,"count":2}` })
	c := newClient(t, ClientOpts{BaseURL: StrPtr(srv.URL)})
	err := c.Realtime().PublishMany(context.Background(), []RealtimeOut{
		{Channel: "a", Topic: "t", Data: 1},
		{Channel: "b", Topic: "u", Data: map[string]string{"x": "y"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	got := (*calls)[0]
	b, _ := json.Marshal(got.body)
	want := `{"appId":"billing","messages":[{"channel":"a","data":1,"topic":"t"},{"channel":"b","data":{"x":"y"},"topic":"u"}]}`
	if got.method != "POST" || got.path != "/v1/realtime/publish" || got.auth != "Bearer "+testBearer || string(b) != want {
		t.Fatalf("call = %+v, body = %s", got, b)
	}
	if err := c.Realtime().PublishMany(context.Background(), nil); err == nil {
		t.Fatal("no messages: want an error")
	}
	srv2, _ := fakeEngine(t, func(engineCall) (int, string) { return 400, `{"error":"message 2: topic is bad","status":400}` })
	c2 := newClient(t, ClientOpts{BaseURL: StrPtr(srv2.URL)})
	err = c2.Realtime().PublishMany(context.Background(), []RealtimeOut{{Channel: "a", Topic: "t"}})
	if err == nil || !strings.Contains(err.Error(), "(400): message 2: topic is bad") {
		t.Fatalf("err = %v", err)
	}
}

func TestRealtimeChannelNamesLimit(t *testing.T) {
	srv, calls := fakeEngine(t, func(engineCall) (int, string) { return 200, `{"token":"t","url":"wss://e/v1/realtime/connect"}` })
	c := newClient(t, ClientOpts{BaseURL: StrPtr(srv.URL)})
	ctx := context.Background()
	at := []string{strings.Repeat("a", 4000), strings.Repeat("b", 4000)} // 8000: fine
	if _, err := c.Realtime().TokenMany(ctx, at, "t"); err != nil {
		t.Fatal(err)
	}
	over := []string{strings.Repeat("a", 4000), strings.Repeat("b", 4001)}
	if _, err := c.Realtime().TokenMany(ctx, over, "t"); err == nil || !strings.Contains(err.Error(), "8000") {
		t.Fatalf("err = %v", err)
	}
	// Counted as the engine does: a character outside the BMP is 2.
	emoji := []string{strings.Repeat("a", 7999) + "\U0001F600"}
	if _, err := c.Realtime().TokenMany(ctx, emoji, "t"); err == nil {
		t.Fatal("8001 UTF-16 characters: want an error")
	}
	if _, err := c.Realtime().Subscribe(ctx, SubscribeOpts{Channels: over, Topics: []string{"t"},
		OnMessage: func(RealtimeMessage) {}}); err == nil {
		t.Fatal("Subscribe: want an error")
	}
	if len(*calls) != 1 {
		t.Fatalf("calls = %d, want 1", len(*calls))
	}
}
