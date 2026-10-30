package flow

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestStart(t *testing.T) {
	srv, calls := fakeEngine(t, func(engineCall) (int, string) {
		return 200, `{"started":true,"runId":"run_1","eventId":"evt_1","existed":true}`
	})
	c := newClient(t, ClientOpts{BaseURL: StrPtr(srv.URL)})
	res, err := c.Start(context.Background(), "agentenkit-run", StartOpts{
		Data: map[string]any{"job": 1}, ID: "job-1", User: map[string]string{"id": "u1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Started || res.RunID != "run_1" || res.EventID != "evt_1" || !res.Existed {
		t.Fatalf("result = %+v", res)
	}
	got := (*calls)[0]
	b, _ := json.Marshal(got.body)
	if got.method != "POST" || got.path != "/v1/functions/agentenkit-run/start" || got.auth != "Bearer "+testBearer ||
		string(b) != `{"appId":"billing","data":{"job":1},"id":"job-1","user":{"id":"u1"}}` {
		t.Fatalf("call = %+v, body = %s", got, b)
	}
}

func TestStartNotStarted(t *testing.T) {
	answer := `{"started":false,"reason":"singleton","activeRunId":"run_9"}`
	srv, calls := fakeEngine(t, func(engineCall) (int, string) { return 200, answer })
	c := newClient(t, ClientOpts{BaseURL: StrPtr(srv.URL)})
	res, err := c.Start(context.Background(), "f", StartOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Started || res.Reason != "singleton" || res.ActiveRunID != "run_9" {
		t.Fatalf("result = %+v", res)
	}
	// No data, id or user: only the app is sent.
	if b, _ := json.Marshal((*calls)[0].body); string(b) != `{"appId":"billing"}` {
		t.Fatalf("body = %s", b)
	}
	answer = `{"started":false,"reason":"singleton","activeRunId":null}`
	if res, _ = c.Start(context.Background(), "f", StartOpts{}); res.ActiveRunID != "" || res.Reason != "singleton" {
		t.Fatalf("result = %+v", res)
	}
	if _, err := c.Start(context.Background(), "", StartOpts{}); err == nil {
		t.Fatal("no function id: want an error")
	}
}

func TestStartError(t *testing.T) {
	srv, _ := fakeEngine(t, func(engineCall) (int, string) {
		return 429, `{"error":"too many events","status":429,"code":"RateLimited"}`
	})
	c := newClient(t, ClientOpts{BaseURL: StrPtr(srv.URL)})
	_, err := c.Start(context.Background(), "f", StartOpts{})
	if err == nil || !strings.Contains(err.Error(), "start failed (429): too many events") {
		t.Fatalf("err = %v", err)
	}
}

func TestRunsList(t *testing.T) {
	srv, calls := fakeEngine(t, func(engineCall) (int, string) {
		return 200, `{"items":[{"id":"run_2","functionId":"agentenkit-run","status":"sleeping","createdAt":20,"endedAt":null,"tags":{"agentRun":"r_1"}},
			{"id":"run_1","functionId":"agentenkit-run","status":"completed","createdAt":10,"endedAt":15,"tags":{}}],"next":"cur"}`
	})
	c := newClient(t, ClientOpts{BaseURL: StrPtr(srv.URL)})
	page, err := c.Runs().List(context.Background(), ListRunsOpts{
		Function: "agentenkit-run", Status: []string{"queued", "sleeping"},
		Tags: map[string]string{"agentRun": "r_1"}, Limit: 20, Before: "c0",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 2 || page.Next != "cur" {
		t.Fatalf("page = %+v", page)
	}
	if it := page.Items[0]; it.ID != "run_2" || it.FunctionID != "agentenkit-run" || it.Status != "sleeping" ||
		it.CreatedAt != 20 || it.EndedAt != 0 || it.Tags["agentRun"] != "r_1" {
		t.Fatalf("item = %+v", it)
	}
	if it := page.Items[1]; it.EndedAt != 15 || len(it.Tags) != 0 {
		t.Fatalf("item = %+v", it)
	}
	got := (*calls)[0]
	want := "appId=billing&before=c0&function=agentenkit-run&limit=20&status=queued%2Csleeping&tag.agentRun=r_1"
	if got.method != "GET" || got.path != "/v1/runs" || got.query.Encode() != want || got.auth != "Bearer "+testBearer {
		t.Fatalf("call = %+v (query %s)", got, got.query.Encode())
	}

	// The last page has next: null.
	srv2, _ := fakeEngine(t, func(engineCall) (int, string) { return 200, `{"items":[],"next":null}` })
	c2 := newClient(t, ClientOpts{BaseURL: StrPtr(srv2.URL)})
	page, err = c2.Runs().List(context.Background(), ListRunsOpts{})
	if err != nil || page.Next != "" || len(page.Items) != 0 {
		t.Fatalf("page = %+v, err = %v", page, err)
	}
}

func TestRunsCounts(t *testing.T) {
	srv, calls := fakeEngine(t, func(engineCall) (int, string) {
		return 200, `{"queued":3,"running":1,"sleeping":12,"waiting":2,"waiting_for_app":4,"paused":5,
			"completed":140,"failed":6,"cancelled":7,"since":1793000000000}`
	})
	c := newClient(t, ClientOpts{BaseURL: StrPtr(srv.URL)})
	n, err := c.Runs().Counts(context.Background(), "agentenkit-run")
	if err != nil {
		t.Fatal(err)
	}
	want := RunCounts{Queued: 3, Running: 1, Sleeping: 12, Waiting: 2, WaitingForApp: 4, Paused: 5,
		Completed: 140, Failed: 6, Cancelled: 7, Since: 1793000000000}
	if n != want {
		t.Fatalf("counts = %+v", n)
	}
	got := (*calls)[0]
	if got.method != "GET" || got.path != "/v1/runs/counts" || got.query.Encode() != "appId=billing&function=agentenkit-run" {
		t.Fatalf("call = %+v", got)
	}
	if _, err := c.Runs().Counts(context.Background(), ""); err == nil {
		t.Fatal("no function: want an error")
	}
}

func TestRunsSingleton(t *testing.T) {
	answer := `{"runId":"run_1","status":"sleeping"}`
	srv, calls := fakeEngine(t, func(engineCall) (int, string) { return 200, answer })
	c := newClient(t, ClientOpts{BaseURL: StrPtr(srv.URL)})
	run, err := c.Runs().Singleton(context.Background(), "agentenkit-run", "hitl-expiry:call_1")
	if err != nil {
		t.Fatal(err)
	}
	if run.RunID != "run_1" || run.Status != "sleeping" {
		t.Fatalf("run = %+v", run)
	}
	got := (*calls)[0]
	if got.method != "GET" || got.path != "/v1/functions/agentenkit-run/singleton" ||
		got.query.Get("key") != "hitl-expiry:call_1" || got.query.Has("keyJson") || got.query.Get("appId") != "billing" {
		t.Fatalf("call = %+v", got)
	}

	// A key that is not a string goes as JSON text.
	answer = `{"runId":null,"status":null}`
	run, err = c.Runs().Singleton(context.Background(), "agentenkit-run", 42)
	if err != nil || run.RunID != "" || run.Status != "" {
		t.Fatalf("run = %+v, err = %v", run, err)
	}
	if got := (*calls)[1]; got.query.Get("keyJson") != "42" || got.query.Has("key") {
		t.Fatalf("call = %+v", got)
	}
	if _, err := c.Runs().Singleton(context.Background(), "agentenkit-run", map[string]int{"a": 1}); err != nil {
		t.Fatal(err)
	}
	if got := (*calls)[2]; got.query.Get("keyJson") != `{"a":1}` {
		t.Fatalf("call = %+v", got)
	}
}

func TestRunsCancel(t *testing.T) {
	srv, calls := fakeEngine(t, func(engineCall) (int, string) {
		return 200, `{"cancelled":["run_1"],"notActive":["run_2"],"more":true,"next":"cur1"}`
	})
	c := newClient(t, ClientOpts{BaseURL: StrPtr(srv.URL)})
	ctx := context.Background()
	res, err := c.Runs().Cancel(ctx, CancelOpts{RunID: "run_1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Cancelled) != 1 || res.Cancelled[0] != "run_1" || len(res.NotActive) != 1 || !res.More || res.Next != "cur1" {
		t.Fatalf("result = %+v", res)
	}
	if _, err := c.Runs().Cancel(ctx, CancelOpts{Function: "f", SingletonKey: "k"}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Runs().Cancel(ctx, CancelOpts{Function: "f", Tag: map[string]string{"agentRun": "r_1"},
		Status: []string{"queued", "sleeping"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Runs().Cancel(ctx, CancelOpts{Function: "f", Tag: map[string]string{"agentRun": "r_1"},
		Cursor: res.Next}); err != nil {
		t.Fatal(err)
	}
	want := []string{
		`{"appId":"billing","runId":"run_1"}`,
		`{"appId":"billing","function":"f","singletonKey":"k"}`,
		`{"appId":"billing","function":"f","status":["queued","sleeping"],"tag":{"agentRun":"r_1"}}`,
		`{"appId":"billing","cursor":"cur1","function":"f","tag":{"agentRun":"r_1"}}`,
	}
	for i, w := range want {
		got := (*calls)[i]
		b, _ := json.Marshal(got.body)
		if got.method != "POST" || got.path != "/v1/runs/cancel" || got.auth != "Bearer "+testBearer || string(b) != w {
			t.Fatalf("call %d = %+v, body = %s", i, got, b)
		}
	}
	for _, bad := range []CancelOpts{
		{},
		{RunID: "run_1", SingletonKey: "k", Function: "f"},
		{SingletonKey: "k"},
		{Function: "f", Tag: map[string]string{"a": "1", "b": "2"}},
		{RunID: "run_1", Status: []string{"queued"}},
		{Function: "f", SingletonKey: "k", Cursor: "cur1"},
		{Function: "f", Tag: map[string]string{"a": "1"}, Status: []string{}},
	} {
		if _, err := c.Runs().Cancel(ctx, bad); err == nil {
			t.Fatalf("%+v: want an error", bad)
		}
	}
	if len(*calls) != 4 {
		t.Fatalf("calls = %d, want 4", len(*calls))
	}
}

// GET calls try the fallback key on a 401 too.
func TestRunsTriesFallbackKeyOn401(t *testing.T) {
	srv, calls := fakeEngine(t, func(call engineCall) (int, string) {
		if call.auth == "Bearer "+testBearer {
			return 200, `{"runId":null,"status":null}`
		}
		return 401, `{"error":"invalid signing key","status":401}`
	})
	c := newClient(t, ClientOpts{BaseURL: StrPtr(srv.URL), SigningKey: StrPtr(testFallback), SigningKeyFallback: StrPtr(testKey)})
	if _, err := c.Runs().Singleton(context.Background(), "f", "k"); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 2 || (*calls)[1].method != "GET" {
		t.Fatalf("calls = %+v", *calls)
	}
}

func TestFunctionTags(t *testing.T) {
	c := newClient(t, ClientOpts{})
	handler := func(context.Context, Input[any]) (any, error) { return nil, nil }
	fn, err := CreateFunction(c, FunctionOpts{ID: "agentenkit-run", Tags: map[string]string{"agentRun": "event.data.job.runId"}},
		EventTrigger("job", nil), handler)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(fn.Config())
	if !strings.Contains(string(b), `"tags":{"agentRun":"event.data.job.runId"}`) {
		t.Fatalf("config = %s", b)
	}
	// No tags: no "tags" key, so the manifest hash of old apps does not change.
	fn2, _ := CreateFunction(c, FunctionOpts{ID: "plain"}, EventTrigger("job", nil), handler)
	if b, _ := json.Marshal(fn2.Config()); strings.Contains(string(b), "tags") {
		t.Fatalf("config = %s", b)
	}
	for _, tags := range []map[string]string{
		{"a": "event.data.a", "b": "event.data.b", "c": "event.data.c", "d": "event.data.d"},
		{"1abc": "event.data.a"},
		{"has-dash": "event.data.a"},
		{strings.Repeat("a", 33): "event.data.a"},
		{"ok": ""},
	} {
		if _, err := CreateFunction(c, FunctionOpts{ID: "bad", Tags: tags}, EventTrigger("job", nil), handler); err == nil {
			t.Fatalf("tags %v: want an error", tags)
		}
	}
	if _, err := CreateFunction(c, FunctionOpts{ID: "ok3", Tags: map[string]string{
		"a": "event.data.a", "b_2": "event.data.b", strings.Repeat("c", 32): "event.data.c",
	}}, EventTrigger("job", nil), handler); err != nil {
		t.Fatal(err)
	}
}

func TestFailedEventData(t *testing.T) {
	raw := `{"id":"e1","name":"inngest/function.failed","ts":1,"data":{"function_id":"billing-charge","run_id":"run_1",
		"error":{"name":"Error","message":"card declined","stack":"at x"},"event":{"name":"charge","data":{"n":1}},"attempts":4}}`
	var e GenericEvent[FailedEventData]
	if err := json.Unmarshal([]byte(raw), &e); err != nil {
		t.Fatal(err)
	}
	d := e.Data
	if d.FunctionID != "billing-charge" || d.RunID != "run_1" || d.Attempts != 4 || d.Error == nil ||
		d.Error.Name != "Error" || d.Error.Message != "card declined" || d.Error.Stack != "at x" ||
		!strings.Contains(string(d.Event), `"charge"`) {
		t.Fatalf("data = %+v", d)
	}
	// An old engine sends no attempts: 0.
	var old FailedEventData
	if err := json.Unmarshal([]byte(`{"function_id":"f","run_id":"r","error":{"message":"x"},"event":{}}`), &old); err != nil || old.Attempts != 0 {
		t.Fatalf("data = %+v, err = %v", old, err)
	}
}

func TestRunsCancelNextNull(t *testing.T) {
	srv, _ := fakeEngine(t, func(engineCall) (int, string) {
		return 200, `{"cancelled":[],"notActive":[],"more":false,"next":null}`
	})
	c := newClient(t, ClientOpts{BaseURL: StrPtr(srv.URL)})
	res, err := c.Runs().Cancel(context.Background(), CancelOpts{RunID: "run_1"})
	if err != nil || res.Next != "" || res.More {
		t.Fatalf("result = %+v, err = %v", res, err)
	}
}

func TestPauseCallsAgainWhileMore(t *testing.T) {
	n := 0
	srv, calls := fakeEngine(t, func(engineCall) (int, string) {
		n++
		if n == 1 {
			return 200, `{"paused":true,"runs":500,"more":true}`
		}
		return 200, `{"paused":true,"runs":20,"more":false}`
	})
	c := newClient(t, ClientOpts{BaseURL: StrPtr(srv.URL)})
	res, err := c.Functions().Pause(context.Background(), "fn")
	if err != nil || res != (PauseResult{Paused: true, Runs: 520}) || len(*calls) != 2 {
		t.Fatalf("pause = %+v, %v after %d calls", res, err, len(*calls))
	}
}

func TestRunControl(t *testing.T) {
	ctx := context.Background()
	srv, calls := fakeEngine(t, func(call engineCall) (int, string) {
		switch {
		case strings.HasSuffix(call.path, "/start"):
			return 200, `{"started":true,"runId":"run_1","eventId":"evt_1"}`
		case strings.HasSuffix(call.path, "/pause"):
			return 200, `{"paused":true,"runs":2}`
		case strings.HasSuffix(call.path, "/resume"):
			return 200, `{"paused":false,"runs":1}`
		case call.path == "/v1/runs":
			return 200, `{"items":[],"next":null}`
		case strings.HasPrefix(call.path, "/v1/runs/run_gone"):
			return 404, `{"error":"run run_gone not found","status":404}`
		case strings.HasSuffix(call.path, "/delete"):
			return 200, `{"deleted":true}`
		case strings.HasSuffix(call.path, "/retry"):
			return 200, `{"retried":false,"reason":"singleton"}`
		default:
			return 200, `{"id":"run_1","functionId":"fn","status":"failed","createdAt":1,"endedAt":2,"tags":{},` +
				`"attempts":4,"error":{"name":"Error","message":"boom"},` +
				`"event":{"id":"evt_1","name":"inngest/function.invoked","data":{"job":1},"ts":1}}`
		}
	})
	c := newClient(t, ClientOpts{BaseURL: StrPtr(srv.URL)})

	if _, err := c.Start(ctx, "fn", StartOpts{WhenPaused: "hold"}); err != nil {
		t.Fatal(err)
	}
	if b, _ := json.Marshal((*calls)[0].body); string(b) != `{"appId":"billing","whenPaused":"hold"}` {
		t.Fatalf("start body = %s", b)
	}
	if _, err := c.Runs().List(ctx, ListRunsOpts{Function: "fn", Order: "oldest"}); err != nil {
		t.Fatal(err)
	}
	if q := (*calls)[1].query.Encode(); q != "appId=billing&function=fn&order=oldest" {
		t.Fatalf("list query = %s", q)
	}

	p, err := c.Functions().Pause(ctx, "fn")
	if err != nil || p != (PauseResult{Paused: true, Runs: 2}) {
		t.Fatalf("pause = %+v, %v", p, err)
	}
	r, err := c.Functions().Resume(ctx, "fn")
	if err != nil || r != (PauseResult{Paused: false, Runs: 1}) {
		t.Fatalf("resume = %+v, %v", r, err)
	}
	if got := (*calls)[2]; got.method != "POST" || got.path != "/v1/functions/fn/pause" || got.body["appId"] != "billing" {
		t.Fatalf("pause call = %+v", got)
	}

	run, err := c.Runs().Get(ctx, "run_1")
	if err != nil || run == nil || run.Status != "failed" || run.Attempts != 4 || run.Error.Message != "boom" ||
		string(run.Event.Data) != `{"job":1}` {
		t.Fatalf("get = %+v, %v", run, err)
	}
	if got := (*calls)[4]; got.method != "GET" || got.path != "/v1/runs/run_1" || got.query.Get("appId") != "billing" {
		t.Fatalf("get call = %+v", got)
	}
	if run, err := c.Runs().Get(ctx, "run_gone"); run != nil || err != nil {
		t.Fatalf("get of a missing run = %+v, %v", run, err)
	}

	res, err := c.Runs().Retry(ctx, "run_1")
	if err != nil || res != (RetryResult{Retried: false, Reason: "singleton"}) {
		t.Fatalf("retry = %+v, %v", res, err)
	}
	if got := (*calls)[6]; got.method != "POST" || got.path != "/v1/runs/run_1/retry" {
		t.Fatalf("retry call = %+v", got)
	}
	if res, err := c.Runs().Retry(ctx, "run_gone"); res.Retried || err != nil {
		t.Fatalf("retry of a missing run = %+v, %v", res, err)
	}

	if ok, err := c.Runs().Delete(ctx, "run_1"); !ok || err != nil {
		t.Fatalf("delete = %v, %v", ok, err)
	}
	if got := (*calls)[len(*calls)-1]; got.method != "POST" || got.path != "/v1/runs/run_1/delete" {
		t.Fatalf("delete call = %+v", got)
	}
	if ok, err := c.Runs().Delete(ctx, "run_gone"); ok || err != nil {
		t.Fatalf("delete of a missing run = %v, %v", ok, err)
	}
}
