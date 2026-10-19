package flow

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/eadwinCode/flow-sdk/step"
)

// stateCall is one GET to the fake run state API.
type stateCall struct {
	path, rawQuery, cursor, auth string
}

// stateEngine serves pages in order: page i is answered when the cursor is
// the (i-1)th page's next (no cursor for page 0).
func stateEngine(t *testing.T, pages []map[string]any) (*httptest.Server, *[]stateCall) {
	t.Helper()
	var mu sync.Mutex
	calls := &[]stateCall{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		*calls = append(*calls, stateCall{r.URL.Path, r.URL.RawQuery, r.URL.Query().Get("cursor"), r.Header.Get("Authorization")})
		i := len(*calls) - 1
		mu.Unlock()
		if i >= len(pages) {
			w.WriteHeader(500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(pages[i])
	}))
	t.Cleanup(srv.Close)
	return srv, calls
}

// useAPIBody is a request with useApi set and empty memo and events.
func useAPIBody(t *testing.T, fnID string) []byte {
	t.Helper()
	var req map[string]any
	if err := json.Unmarshal(invokeBody(t, fnID, reqOpts{}), &req); err != nil {
		t.Fatal(err)
	}
	req["useApi"] = true
	req["events"] = []any{}
	req["memo"] = map[string]any{}
	return mustJSON(req)
}

func TestUseAPILoadsStatePages(t *testing.T) {
	ev := func(n int) map[string]any {
		return map[string]any{"id": "e", "name": "billing/charge", "data": map[string]any{"amount": n}, "ts": 1}
	}
	cursor1 := "c 1/&=?"
	cursor2 := "c2"
	srv, calls := stateEngine(t, []map[string]any{
		{"events": []any{ev(1), ev(2)}, "memo": map[string]any{h("a", 0): data("A")}, "next": cursor1},
		{"events": []any{ev(99)}, "memo": map[string]any{h("b", 0): data(map[string]int{"n": 7})}, "next": cursor2},
		{"memo": map[string]any{h("c", 0): map[string]any{"error": map[string]any{"name": "Error", "message": "boom"}}}, "next": nil},
	})
	c := newClient(t, ClientOpts{BaseURL: StrPtr(srv.URL + "/")})
	ran := 0
	define(t, c, "fn", func(ctx context.Context, in Input[charge]) (any, error) {
		a, err := step.Run(ctx, "a", func(ctx context.Context) (string, error) { ran++; return "", nil })
		if err != nil {
			return nil, err
		}
		b, err := step.Run(ctx, "b", func(ctx context.Context) (map[string]int, error) { ran++; return nil, nil })
		if err != nil {
			return nil, err
		}
		_, cErr := step.Run(ctx, "c", func(ctx context.Context) (int, error) { ran++; return 0, nil })
		amounts := []int{}
		for _, e := range in.Events {
			amounts = append(amounts, e.Data.Amount)
		}
		return map[string]any{"a": a, "b": b["n"], "c": cErr != nil, "events": amounts}, nil
	})

	a := signedPost(t, c, useAPIBody(t, "fn"))
	if a.status != 200 || string(a.body) != `{"a":"A","b":7,"c":true,"events":[1,2]}` {
		t.Fatalf("got %d %s", a.status, a.body)
	}
	if ran != 0 {
		t.Fatalf("memoized steps ran %d times", ran)
	}
	if len(*calls) != 3 {
		t.Fatalf("got %d calls, want 3: %+v", len(*calls), *calls)
	}
	for i, want := range []string{"", cursor1, cursor2} {
		got := (*calls)[i]
		if got.path != "/runs/run_1/state" || got.cursor != want || got.auth != "Bearer "+testBearer {
			t.Fatalf("call %d = %+v, want cursor %q", i, got, want)
		}
	}
	if (*calls)[0].rawQuery != "" {
		t.Fatalf("first call has a query: %q", (*calls)[0].rawQuery)
	}
}

func TestUseAPIRunsNewStepAfterLoad(t *testing.T) {
	srv, _ := stateEngine(t, []map[string]any{
		{"events": []any{}, "memo": map[string]any{h("a", 0): data(1)}, "next": nil},
	})
	c := newClient(t, ClientOpts{BaseURL: StrPtr(srv.URL)})
	define(t, c, "fn", func(ctx context.Context, in Input[charge]) (any, error) {
		n, _ := step.Run(ctx, "a", func(ctx context.Context) (int, error) { return 0, nil })
		return step.Run(ctx, "b", func(ctx context.Context) (int, error) { return n + 1, nil })
	})
	ops := signedPost(t, c, useAPIBody(t, "fn")).ops(t)
	if len(ops) != 1 || ops[0]["id"] != h("b", 0) || ops[0]["data"] != float64(2) {
		t.Fatalf("ops = %v", ops)
	}
}

func TestUseAPIFailures(t *testing.T) {
	cases := []struct {
		name    string
		handler http.HandlerFunc
		noKey   bool
	}{
		{name: "401", handler: func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(401)
			_, _ = w.Write([]byte(`{"error":"invalid signing key"}`))
		}},
		{name: "404", handler: func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(404) }},
		{name: "bad json", handler: func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(`{"memo":`)) }},
		{name: "second page fails", handler: func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Query().Get("cursor") == "" {
				_, _ = w.Write([]byte(`{"events":[],"memo":{},"next":"p2"}`))
				return
			}
			w.WriteHeader(503)
		}},
		{name: "network error"},
		{name: "no signing key", noKey: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			opts := ClientOpts{}
			switch {
			case tc.handler == nil:
				srv := httptest.NewServer(http.NotFoundHandler())
				u := srv.URL
				srv.Close() // nothing listens here now
				opts.BaseURL = StrPtr(u)
			default:
				srv := httptest.NewServer(tc.handler)
				t.Cleanup(srv.Close)
				opts.BaseURL = StrPtr(srv.URL)
			}
			if tc.noKey {
				opts.SigningKey = StrPtr("")
				opts.Dev = BoolPtr(true)
				opts.BaseURL = StrPtr("http://127.0.0.1:1")
			}
			c := newClient(t, opts)
			ran := false
			define(t, c, "fn", func(ctx context.Context, in Input[charge]) (any, error) { ran = true; return nil, nil })
			a := signedPost(t, c, useAPIBody(t, "fn"))
			if a.status != 500 || a.errBody(t).Name != "StateLoadFailed" {
				t.Fatalf("got %d %s", a.status, a.body)
			}
			if a.header.Get("X-Inngest-No-Retry") != "" {
				t.Fatal("no-retry header is set")
			}
			if ran {
				t.Fatal("the handler ran")
			}
		})
	}
}

func TestNoUseAPIDoesNotCallStateAPI(t *testing.T) {
	srv, calls := stateEngine(t, nil)
	c := newClient(t, ClientOpts{BaseURL: StrPtr(srv.URL)})
	define(t, c, "fn", func(ctx context.Context, in Input[charge]) (any, error) { return "ok", nil })
	a := run(t, c, "fn", reqOpts{})
	if a.status != 200 || string(a.body) != `"ok"` {
		t.Fatalf("got %d %s", a.status, a.body)
	}
	if len(*calls) != 0 {
		t.Fatalf("state API was called: %+v", *calls)
	}
}
