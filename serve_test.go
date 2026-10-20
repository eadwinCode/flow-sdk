package flow

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/eadwinCode/flow-sdk/group"
	"github.com/eadwinCode/flow-sdk/internal/core"
	"github.com/eadwinCode/flow-sdk/step"
)

const (
	testKey      = "signkey-abababababababababababababababababababababababababababababababab"
	testFallback = "signkey-cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"
	testBearer   = "signkey-9a2db2e23f1504cd056606553ac049c5e718e8f9ce9233876df1a7a1821af885"
)

var testNow = time.UnixMilli(1_760_000_000_000)

func h(id string, n int) string { return core.HashStepID(id, n) }

func newClient(t *testing.T, opts ClientOpts) *Client {
	t.Helper()
	if opts.AppID == "" {
		opts.AppID = "billing"
	}
	if opts.SigningKey == nil {
		opts.SigningKey = StrPtr(testKey)
	}
	if opts.SigningKeyFallback == nil {
		opts.SigningKeyFallback = StrPtr("")
	}
	for _, p := range []**string{&opts.EventKey, &opts.BaseURL, &opts.ServeURL} {
		if *p == nil {
			*p = StrPtr("")
		}
	}
	if opts.Dev == nil {
		opts.Dev = BoolPtr(false)
	}
	c, err := NewClient(opts)
	if err != nil {
		t.Fatal(err)
	}
	c.now = func() time.Time { return testNow }
	return c
}

type reqOpts struct {
	memo   map[string]any
	target string
	event  any
}

func invokeBody(t *testing.T, fnID string, o reqOpts) []byte {
	t.Helper()
	event := o.event
	if event == nil {
		event = map[string]any{"id": "evt_1", "name": "billing/charge", "data": map[string]any{"amount": 5}, "ts": 1}
	}
	memo := o.memo
	if memo == nil {
		memo = map[string]any{}
	}
	req := map[string]any{
		"fnId": fnID, "runId": "run_1", "event": event,
		"events": []any{event}, "memo": memo, "attempt": 0, "maxAttempts": 5,
	}
	if o.target != "" {
		req["targetStepId"] = o.target
	}
	b, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

type answer struct {
	status int
	header http.Header
	body   []byte
}

func (a answer) ops(t *testing.T) []map[string]any {
	t.Helper()
	if a.status != 206 {
		t.Fatalf("status %d, want 206; body %s", a.status, a.body)
	}
	var ops []map[string]any
	if err := json.Unmarshal(a.body, &ops); err != nil {
		t.Fatalf("body is not a list of ops: %s", a.body)
	}
	return ops
}

func (a answer) errBody(t *testing.T) core.SerializedError {
	t.Helper()
	var e core.SerializedError
	if err := json.Unmarshal(a.body, &e); err != nil {
		t.Fatalf("body is not an error: %s", a.body)
	}
	return e
}

func send(t *testing.T, c *Client, method string, body []byte, sig string) answer {
	t.Helper()
	r := httptest.NewRequest(method, "https://billing.example.com/api/flow", strings.NewReader(string(body)))
	if sig != "" {
		r.Header.Set(core.HeaderSignature, sig)
	}
	w := httptest.NewRecorder()
	c.Serve().ServeHTTP(w, r)
	res := w.Result()
	b, _ := io.ReadAll(res.Body)
	return answer{status: res.StatusCode, header: res.Header, body: b}
}

func signedPost(t *testing.T, c *Client, body []byte) answer {
	t.Helper()
	sig, err := signRequest(testKey, body, testNow)
	if err != nil {
		t.Fatal(err)
	}
	return send(t, c, http.MethodPost, body, sig)
}

func run(t *testing.T, c *Client, fnID string, o reqOpts) answer {
	t.Helper()
	return signedPost(t, c, invokeBody(t, fnID, o))
}

type charge struct {
	Amount int `json:"amount"`
}

func define(t *testing.T, c *Client, id string, fn Handler[charge]) {
	t.Helper()
	if _, err := CreateFunction(c, FunctionOpts{ID: id}, EventTrigger("billing/charge", nil), fn); err != nil {
		t.Fatal(err)
	}
}

func data(v any) map[string]any { return map[string]any{"data": v} }

// ------------------------------------------------------------------ tests

func TestDoneReturnsOutput(t *testing.T) {
	c := newClient(t, ClientOpts{})
	define(t, c, "hello", func(ctx context.Context, in Input[charge]) (any, error) {
		return map[string]any{"amount": in.Event.Data.Amount, "run": in.InputCtx.RunID}, nil
	})
	define(t, c, "nothing", func(ctx context.Context, in Input[charge]) (any, error) { return nil, nil })

	a := run(t, c, "hello", reqOpts{})
	if a.status != 200 || string(a.body) != `{"amount":5,"run":"run_1"}` {
		t.Fatalf("got %d %s", a.status, a.body)
	}
	a = run(t, c, "nothing", reqOpts{})
	if a.status != 200 || string(a.body) != "null" {
		t.Fatalf("got %d %s", a.status, a.body)
	}
}

func TestReplayFromMemo(t *testing.T) {
	c := newClient(t, ClientOpts{})
	calls := 0
	define(t, c, "fn", func(ctx context.Context, in Input[charge]) (any, error) {
		user, err := step.Run(ctx, "load-user", func(ctx context.Context) (map[string]string, error) {
			calls++
			return nil, nil
		})
		if err != nil {
			return nil, err
		}
		n, err := step.Run(ctx, "count", func(ctx context.Context) (int, error) { calls++; return 0, nil })
		return map[string]any{"user": user["name"], "n": n}, err
	})
	a := run(t, c, "fn", reqOpts{memo: map[string]any{
		h("load-user", 0): data(map[string]string{"name": "ada"}),
		h("count", 0):     data(7),
	}})
	if a.status != 200 || string(a.body) != `{"n":7,"user":"ada"}` {
		t.Fatalf("got %d %s", a.status, a.body)
	}
	if calls != 0 {
		t.Fatalf("memoized steps ran %d times", calls)
	}
}

func TestNewRunCompleted(t *testing.T) {
	c := newClient(t, ClientOpts{})
	after := false
	define(t, c, "fn", func(ctx context.Context, in Input[charge]) (any, error) {
		v, err := step.Run(ctx, "load-user", func(ctx context.Context) (string, error) {
			if step.IdempotencyKey(ctx) != "run_1:"+h("load-user", 0) {
				t.Errorf("idempotency key = %q", step.IdempotencyKey(ctx))
			}
			return "ada", nil
		})
		after = true
		return v, err
	})
	ops := run(t, c, "fn", reqOpts{}).ops(t)
	if len(ops) != 1 || ops[0]["op"] != "StepCompleted" || ops[0]["id"] != h("load-user", 0) ||
		ops[0]["name"] != "load-user" || ops[0]["data"] != "ada" {
		t.Fatalf("ops = %v", ops)
	}
	if after {
		t.Fatal("the handler went on after a new step")
	}
}

func TestNewRunNilDataIsSent(t *testing.T) {
	c := newClient(t, ClientOpts{})
	define(t, c, "fn", func(ctx context.Context, in Input[charge]) (any, error) {
		return step.Run(ctx, "x", func(ctx context.Context) (any, error) { return nil, nil })
	})
	a := run(t, c, "fn", reqOpts{})
	if !strings.Contains(string(a.body), `"data":null`) {
		t.Fatalf("StepCompleted must carry data: %s", a.body)
	}
}

func TestNewRunFailed(t *testing.T) {
	at := testNow.Add(time.Minute)
	cases := []struct {
		name    string
		err     error
		errName string
		noRetry bool
		retryAt *int64
	}{
		{"plain", errors.New("boom"), "Error", false, nil},
		{"noRetry", NoRetryError(errors.New("boom")), "NonRetriableError", true, nil},
		{"retryAt", RetryAtError(errors.New("boom"), at), "RetryAfterError", false, func() *int64 { v := at.UnixMilli(); return &v }()},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := newClient(t, ClientOpts{})
			define(t, c, "fn", func(ctx context.Context, in Input[charge]) (any, error) {
				return step.Run(ctx, "charge", func(ctx context.Context) (any, error) { return nil, tc.err })
			})
			a := run(t, c, "fn", reqOpts{})
			var ops []core.Opcode
			if a.status != 206 || json.Unmarshal(a.body, &ops) != nil || len(ops) != 1 {
				t.Fatalf("got %d %s", a.status, a.body)
			}
			op := ops[0]
			if op.Op != "StepFailed" || op.ID != h("charge", 0) || op.Name != "charge" ||
				op.Error == nil || op.Error.Name != tc.errName || op.Error.Message != "boom" {
				t.Fatalf("op = %s", a.body)
			}
			if op.NoRetry != tc.noRetry {
				t.Fatalf("noRetry = %v", op.NoRetry)
			}
			if (op.RetryAt == nil) != (tc.retryAt == nil) || (op.RetryAt != nil && *op.RetryAt != *tc.retryAt) {
				t.Fatalf("retryAt = %v", op.RetryAt)
			}
			if tc.retryAt == nil && strings.Contains(string(a.body), "retryAt") {
				t.Fatalf("retryAt sent when not set: %s", a.body)
			}
		})
	}
}

// A panic in a step callback fails that step's attempt (retried by the engine),
// the same as an error thrown in a TypeScript step. It does not fail the whole call.
func TestStepPanicIsStepFailed(t *testing.T) {
	c := newClient(t, ClientOpts{})
	define(t, c, "fn", func(ctx context.Context, in Input[charge]) (any, error) {
		return step.Run(ctx, "charge", func(ctx context.Context) (any, error) { panic("card reader broke") })
	})
	a := run(t, c, "fn", reqOpts{})
	var ops []core.Opcode
	if a.status != 206 || json.Unmarshal(a.body, &ops) != nil || len(ops) != 1 {
		t.Fatalf("got %d %s", a.status, a.body)
	}
	op := ops[0]
	if op.Op != "StepFailed" || op.ID != h("charge", 0) || op.Error == nil ||
		op.Error.Name != "Panic" || op.Error.Message != "card reader broke" || op.Error.Stack == "" || op.NoRetry {
		t.Fatalf("op = %s", a.body)
	}

	// In a parallel group with a target step, the panic is reported the same way.
	define(t, c, "par", func(ctx context.Context, in Input[charge]) (any, error) {
		group.Parallel(ctx,
			func(ctx context.Context) (any, error) {
				return step.Run(ctx, "a", func(ctx context.Context) (int, error) { return 1, nil })
			},
			func(ctx context.Context) (any, error) {
				return step.Run(ctx, "b", func(ctx context.Context) (int, error) { panic("b broke") })
			},
		)
		return nil, nil
	})
	a = run(t, c, "par", reqOpts{target: h("b", 0)})
	if a.status != 206 || json.Unmarshal(a.body, &ops) != nil || len(ops) != 1 ||
		ops[0].Op != "StepFailed" || ops[0].ID != h("b", 0) || ops[0].Error.Name != "Panic" {
		t.Fatalf("got %d %s", a.status, a.body)
	}
}

func TestStepErrorFromMemo(t *testing.T) {
	c := newClient(t, ClientOpts{})
	define(t, c, "fn", func(ctx context.Context, in Input[charge]) (any, error) {
		_, err := step.Run(ctx, "charge", func(ctx context.Context) (any, error) { return nil, nil })
		var se *step.StepError
		if !errors.As(err, &se) {
			return nil, errors.New("want a StepError")
		}
		return map[string]string{"name": se.Name, "message": se.Message}, nil
	})
	a := run(t, c, "fn", reqOpts{memo: map[string]any{
		h("charge", 0): map[string]any{"error": map[string]string{"name": "CardDeclined", "message": "no funds"}},
	}})
	if a.status != 200 || string(a.body) != `{"message":"no funds","name":"CardDeclined"}` {
		t.Fatalf("got %d %s", a.status, a.body)
	}
}

func TestRepeatedIDsInLoop(t *testing.T) {
	c := newClient(t, ClientOpts{})
	define(t, c, "fn", func(ctx context.Context, in Input[charge]) (any, error) {
		total := 0
		for i := 0; i < 3; i++ {
			n, err := step.Run(ctx, "fetch", func(ctx context.Context) (int, error) { return 100, nil })
			if err != nil {
				return nil, err
			}
			total += n
		}
		return total, nil
	})
	memo := map[string]any{h("fetch", 0): data(1), h("fetch", 1): data(2)}
	ops := run(t, c, "fn", reqOpts{memo: memo}).ops(t)
	if len(ops) != 1 || ops[0]["id"] != h("fetch", 2) || ops[0]["id"] != core.HashStepID("fetch:2", 0) {
		t.Fatalf("ops = %v", ops)
	}
	memo[h("fetch", 2)] = data(3)
	a := run(t, c, "fn", reqOpts{memo: memo})
	if a.status != 200 || string(a.body) != "6" {
		t.Fatalf("got %d %s", a.status, a.body)
	}
}

func parallelFn(ran *[]string) Handler[charge] {
	return func(ctx context.Context, in Input[charge]) (any, error) {
		res := group.Parallel(ctx,
			func(ctx context.Context) (any, error) {
				return step.Run(ctx, "a", func(ctx context.Context) (string, error) { *ran = append(*ran, "a"); return "A", nil })
			},
			func(ctx context.Context) (any, error) {
				return step.Run(ctx, "b", func(ctx context.Context) (string, error) { *ran = append(*ran, "b"); return "B", nil })
			},
			func(ctx context.Context) (any, error) {
				return nil, step.Sleep(ctx, "nap", time.Hour)
			},
		)
		if err := res.AnyError(); err != nil {
			return nil, err
		}
		return []any{res[0].Value, res[1].Value}, nil
	}
}

func TestParallelPlansSteps(t *testing.T) {
	c := newClient(t, ClientOpts{})
	var ran []string
	define(t, c, "fn", parallelFn(&ran))
	ops := run(t, c, "fn", reqOpts{}).ops(t)
	if len(ran) != 0 {
		t.Fatalf("planned steps ran: %v", ran)
	}
	if len(ops) != 3 {
		t.Fatalf("ops = %v", ops)
	}
	want := []struct{ op, id, name string }{
		{"StepPlanned", h("a", 0), "a"},
		{"StepPlanned", h("b", 0), "b"},
		{"Sleep", h("nap", 0), "nap"},
	}
	for i, w := range want {
		if ops[i]["op"] != w.op || ops[i]["id"] != w.id || ops[i]["name"] != w.name {
			t.Fatalf("op %d = %v, want %v", i, ops[i], w)
		}
	}
	if _, ok := ops[0]["data"]; ok {
		t.Fatalf("StepPlanned has data: %v", ops[0])
	}
	if ops[2]["until"] != float64(testNow.Add(time.Hour).UnixMilli()) {
		t.Fatalf("sleep until = %v", ops[2]["until"])
	}
}

func TestParallelTarget(t *testing.T) {
	c := newClient(t, ClientOpts{})
	var ran []string
	define(t, c, "fn", parallelFn(&ran))
	ops := run(t, c, "fn", reqOpts{target: h("b", 0)}).ops(t)
	if len(ran) != 1 || ran[0] != "b" {
		t.Fatalf("ran = %v", ran)
	}
	if len(ops) != 1 || ops[0]["op"] != "StepCompleted" || ops[0]["id"] != h("b", 0) || ops[0]["data"] != "B" {
		t.Fatalf("ops = %v", ops)
	}
}

func TestParallelTargetWithOthersDone(t *testing.T) {
	c := newClient(t, ClientOpts{})
	var ran []string
	define(t, c, "fn", parallelFn(&ran))
	memo := map[string]any{h("b", 0): data("B"), h("nap", 0): data(nil)}
	ops := run(t, c, "fn", reqOpts{target: h("a", 0), memo: memo}).ops(t)
	if len(ran) != 1 || ran[0] != "a" || len(ops) != 1 || ops[0]["id"] != h("a", 0) {
		t.Fatalf("ran = %v, ops = %v", ran, ops)
	}
	memo[h("a", 0)] = data("A")
	a := run(t, c, "fn", reqOpts{memo: memo})
	if a.status != 200 || string(a.body) != `["A","B"]` {
		t.Fatalf("got %d %s", a.status, a.body)
	}
}

func TestParallelSingleNewRunRunsNow(t *testing.T) {
	c := newClient(t, ClientOpts{})
	var ran []string
	define(t, c, "fn", parallelFn(&ran))
	memo := map[string]any{h("b", 0): data("B"), h("nap", 0): data(nil)}
	ops := run(t, c, "fn", reqOpts{memo: memo}).ops(t)
	if len(ran) != 1 || len(ops) != 1 || ops[0]["op"] != "StepCompleted" || ops[0]["data"] != "A" {
		t.Fatalf("ran = %v, ops = %v", ran, ops)
	}
}

func TestTargetNotReached(t *testing.T) {
	c := newClient(t, ClientOpts{})
	var ran []string
	define(t, c, "fn", parallelFn(&ran))
	a := run(t, c, "fn", reqOpts{target: h("zzz", 0)})
	if a.status != 500 || a.errBody(t).Name != "StepNotFound" || len(ran) != 0 {
		t.Fatalf("got %d %s, ran %v", a.status, a.body, ran)
	}
}

func TestTargetSkipsOtherNewSteps(t *testing.T) {
	c := newClient(t, ClientOpts{})
	var ran []string
	define(t, c, "fn", func(ctx context.Context, in Input[charge]) (any, error) {
		_, _ = step.Run(ctx, "first", func(ctx context.Context) (any, error) { ran = append(ran, "first"); return nil, nil })
		return nil, nil
	})
	a := run(t, c, "fn", reqOpts{target: h("other", 0)})
	if a.status != 500 || a.errBody(t).Name != "StepNotFound" || len(ran) != 0 {
		t.Fatalf("got %d %s, ran %v", a.status, a.body, ran)
	}
}

func TestSleepOpcodes(t *testing.T) {
	c := newClient(t, ClientOpts{})
	until := time.UnixMilli(1_900_000_000_000)
	define(t, c, "sleep", func(ctx context.Context, in Input[charge]) (any, error) {
		if err := step.Sleep(ctx, "wait-3-days", 72*time.Hour); err != nil {
			return nil, err
		}
		return "awake", step.SleepUntil(ctx, "until", until)
	})
	ops := run(t, c, "sleep", reqOpts{}).ops(t)
	if ops[0]["op"] != "Sleep" || ops[0]["id"] != h("wait-3-days", 0) ||
		ops[0]["until"] != float64(testNow.Add(72*time.Hour).UnixMilli()) {
		t.Fatalf("ops = %v", ops)
	}
	memo := map[string]any{h("wait-3-days", 0): data(nil)}
	ops = run(t, c, "sleep", reqOpts{memo: memo}).ops(t)
	if ops[0]["op"] != "Sleep" || ops[0]["name"] != "until" || ops[0]["until"] != float64(until.UnixMilli()) {
		t.Fatalf("ops = %v", ops)
	}
	memo[h("until", 0)] = data(nil)
	if a := run(t, c, "sleep", reqOpts{memo: memo}); a.status != 200 || string(a.body) != `"awake"` {
		t.Fatalf("got %d %s", a.status, a.body)
	}
}

type onboarded struct {
	UserID string `json:"userId"`
}

func TestWaitForEvent(t *testing.T) {
	c := newClient(t, ClientOpts{})
	define(t, c, "wait", func(ctx context.Context, in Input[charge]) (any, error) {
		ev, err := step.WaitForEvent[GenericEvent[onboarded]](ctx, "wait-onboarded", step.WaitForEventOpts{
			Event: "user/onboarded", Timeout: 7 * 24 * time.Hour, Match: StrPtr("data.userId"),
			If: StrPtr("async.data.userId == event.data.userId"),
		})
		if errors.Is(err, step.ErrEventNotReceived) {
			return "timeout", nil
		}
		if err != nil {
			return nil, err
		}
		return ev.Data.UserID, nil
	})
	ops := run(t, c, "wait", reqOpts{}).ops(t)
	want := map[string]any{
		"op": "WaitForEvent", "id": h("wait-onboarded", 0), "name": "wait-onboarded",
		"event": "user/onboarded", "timeout": "604800s", "match": "data.userId",
		"if": "async.data.userId == event.data.userId",
	}
	if len(ops) != 1 || len(ops[0]) != len(want) {
		t.Fatalf("ops = %v", ops)
	}
	for k, v := range want {
		if ops[0][k] != v {
			t.Fatalf("%s = %v, want %v", k, ops[0][k], v)
		}
	}
	a := run(t, c, "wait", reqOpts{memo: map[string]any{h("wait-onboarded", 0): data(nil)}})
	if a.status != 200 || string(a.body) != `"timeout"` {
		t.Fatalf("null memo: got %d %s", a.status, a.body)
	}
	ev := map[string]any{"id": "evt_2", "name": "user/onboarded", "data": map[string]any{"userId": "u1"}, "ts": 2}
	a = run(t, c, "wait", reqOpts{memo: map[string]any{h("wait-onboarded", 0): data(ev)}})
	if a.status != 200 || string(a.body) != `"u1"` {
		t.Fatalf("event memo: got %d %s", a.status, a.body)
	}
}

func TestSendOpcode(t *testing.T) {
	c := newClient(t, ClientOpts{})
	define(t, c, "send", func(ctx context.Context, in Input[charge]) (any, error) {
		return step.Send(ctx, "notify", Event{Name: "billing/charged", Data: map[string]int{"amount": 5}, ID: StrPtr("k1")},
			Event{Name: "billing/second"})
	})
	ops := run(t, c, "send", reqOpts{}).ops(t)
	b, _ := json.Marshal(ops[0]["events"])
	if ops[0]["op"] != "SendEvent" || ops[0]["id"] != h("notify", 0) ||
		string(b) != `[{"data":{"amount":5},"id":"k1","name":"billing/charged"},{"name":"billing/second"}]` {
		t.Fatalf("ops = %v (%s)", ops, b)
	}
	a := run(t, c, "send", reqOpts{memo: map[string]any{h("notify", 0): data(map[string]any{"ids": []string{"e1", "e2"}})}})
	if a.status != 200 || string(a.body) != `["e1","e2"]` {
		t.Fatalf("got %d %s", a.status, a.body)
	}
}

func TestInvokeOpcode(t *testing.T) {
	c := newClient(t, ClientOpts{})
	define(t, c, "parent", func(ctx context.Context, in Input[charge]) (any, error) {
		out, err := step.Invoke[map[string]int](ctx, "call-child", step.InvokeOpts{
			FunctionID: "other-app-child", Data: map[string]int{"n": 1}, Timeout: 10 * time.Minute,
		})
		var se *step.StepError
		if errors.As(err, &se) {
			return "child failed: " + se.Message, nil
		}
		return out["n"], err
	})
	ops := run(t, c, "parent", reqOpts{}).ops(t)
	b, _ := json.Marshal(ops[0])
	if string(b) != `{"data":{"n":1},"function":"other-app-child","id":"`+h("call-child", 0)+`","name":"call-child","op":"InvokeFunction","timeout":"600s"}` {
		t.Fatalf("op = %s", b)
	}
	a := run(t, c, "parent", reqOpts{memo: map[string]any{h("call-child", 0): data(map[string]int{"n": 2})}})
	if a.status != 200 || string(a.body) != "2" {
		t.Fatalf("got %d %s", a.status, a.body)
	}
	a = run(t, c, "parent", reqOpts{memo: map[string]any{
		h("call-child", 0): map[string]any{"error": map[string]string{"name": "Error", "message": "bad"}},
	}})
	if a.status != 200 || string(a.body) != `"child failed: bad"` {
		t.Fatalf("got %d %s", a.status, a.body)
	}
}

func TestHandlerErrors(t *testing.T) {
	c := newClient(t, ClientOpts{})
	define(t, c, "plain", func(ctx context.Context, in Input[charge]) (any, error) { return nil, errors.New("oops") })
	define(t, c, "noretry", func(ctx context.Context, in Input[charge]) (any, error) {
		return nil, NoRetryError(errors.New("stop"))
	})
	define(t, c, "retryat", func(ctx context.Context, in Input[charge]) (any, error) {
		return nil, RetryAtError(errors.New("later"), testNow.Add(90*time.Second))
	})
	define(t, c, "panics", func(ctx context.Context, in Input[charge]) (any, error) { panic("bad thing") })

	a := run(t, c, "plain", reqOpts{})
	if e := a.errBody(t); a.status != 500 || e.Name != "Error" || e.Message != "oops" ||
		a.header.Get(core.HeaderNoRetry) != "" || a.header.Get(core.HeaderRetryAfter) != "" {
		t.Fatalf("got %d %s %v", a.status, a.body, a.header)
	}
	a = run(t, c, "noretry", reqOpts{})
	if a.status != 500 || a.header.Get(core.HeaderNoRetry) != "true" || a.errBody(t).Message != "stop" ||
		a.errBody(t).Name != "NonRetriableError" {
		t.Fatalf("got %d %s %v", a.status, a.body, a.header)
	}
	a = run(t, c, "retryat", reqOpts{})
	if a.status != 500 || a.header.Get(core.HeaderRetryAfter) != "90" {
		t.Fatalf("got %d %s %v", a.status, a.body, a.header)
	}
	a = run(t, c, "panics", reqOpts{})
	if a.status != 500 || a.errBody(t).Name != "Panic" || a.errBody(t).Message != "bad thing" {
		t.Fatalf("got %d %s", a.status, a.body)
	}
}

func TestUnknownFunction(t *testing.T) {
	c := newClient(t, ClientOpts{})
	a := run(t, c, "missing", reqOpts{})
	if a.status != 500 || a.errBody(t).Name != "FunctionNotFound" || a.header.Get(core.HeaderNoRetry) != "true" {
		t.Fatalf("got %d %s %v", a.status, a.body, a.header)
	}
}

func TestSignatureRejected(t *testing.T) {
	c := newClient(t, ClientOpts{})
	ran := false
	define(t, c, "fn", func(ctx context.Context, in Input[charge]) (any, error) { ran = true; return nil, nil })
	body := invokeBody(t, "fn", reqOpts{})
	wrongKey := "signkey-0000000000000000000000000000000000000000000000000000000000000000"

	bad, _ := signRequest(wrongKey, body, testNow)
	old, _ := signRequest(testKey, body, testNow.Add(-301*time.Second))
	other, _ := signRequest(testKey, []byte(`{"fnId":"fn"}`), testNow)
	for name, sig := range map[string]string{"missing": "", "wrong key": bad, "old": old, "other body": other, "junk": "t=abc&s=00"} {
		if a := send(t, c, http.MethodPost, body, sig); a.status != 401 {
			t.Errorf("%s: status %d, want 401", name, a.status)
		}
	}
	if ran {
		t.Fatal("function ran with a bad signature")
	}
}

func TestFallbackKeyAccepted(t *testing.T) {
	c := newClient(t, ClientOpts{SigningKey: StrPtr(testFallback), SigningKeyFallback: StrPtr(testKey)})
	define(t, c, "fn", func(ctx context.Context, in Input[charge]) (any, error) { return "ok", nil })
	if a := run(t, c, "fn", reqOpts{}); a.status != 200 {
		t.Fatalf("got %d %s", a.status, a.body)
	}
}

func TestDevModeAndNoKey(t *testing.T) {
	dev := newClient(t, ClientOpts{SigningKey: StrPtr(""), Dev: BoolPtr(true)})
	define(t, dev, "fn", func(ctx context.Context, in Input[charge]) (any, error) { return "ok", nil })
	if a := send(t, dev, http.MethodPost, invokeBody(t, "fn", reqOpts{}), ""); a.status != 200 {
		t.Fatalf("dev: got %d %s", a.status, a.body)
	}
	nokey := newClient(t, ClientOpts{SigningKey: StrPtr("")})
	define(t, nokey, "fn", func(ctx context.Context, in Input[charge]) (any, error) { return "ok", nil })
	a := send(t, nokey, http.MethodPost, invokeBody(t, "fn", reqOpts{}), "")
	if a.status != 500 || a.errBody(t).Name != "NoSigningKey" {
		t.Fatalf("no key: got %d %s", a.status, a.body)
	}
}

func TestEnvVars(t *testing.T) {
	t.Setenv("FLOW_SIGNING_KEY", testKey)
	t.Setenv("FLOW_BASE_URL", "https://engine.example.com/")
	t.Setenv("FLOW_DEV", "1")
	c, err := NewClient(ClientOpts{AppID: "billing"})
	if err != nil {
		t.Fatal(err)
	}
	if c.signingKey != testKey || c.baseURL != "https://engine.example.com" || !c.dev {
		t.Fatalf("env not read: %+v", c)
	}
	c, _ = NewClient(ClientOpts{AppID: "billing", Dev: BoolPtr(false), BaseURL: StrPtr("https://x")})
	if c.dev || c.baseURL != "https://x" {
		t.Fatal("options must win over env")
	}
	t.Setenv("FLOW_BASE_URL", "")
	c, _ = NewClient(ClientOpts{AppID: "billing"})
	if c.baseURL != DefaultBaseURL || DefaultBaseURL != "https://worker.clevixstudio.com" {
		t.Fatalf("default engine URL: got %q", c.baseURL)
	}
	// Empty counts as not set, like in the TypeScript SDK.
	c, _ = NewClient(ClientOpts{AppID: "billing", BaseURL: StrPtr("")})
	if c.baseURL != DefaultBaseURL {
		t.Fatalf("empty BaseURL: got %q", c.baseURL)
	}
	// Without FLOW_SERVE_URL the manifest URL is the request's, without the query.
	// X-Forwarded-Host is not read: anyone can send it.
	r := httptest.NewRequest(http.MethodGet, "https://billing.example.com/api/flow?x=1", nil)
	r.Header.Set("X-Forwarded-Host", "relay.example.com")
	if got := c.serveURLFor(r); got != "https://billing.example.com/api/flow" {
		t.Fatalf("serve URL: got %q", got)
	}
	t.Setenv("FLOW_SERVE_URL", "https://public.example.com/prod/flow")
	c, _ = NewClient(ClientOpts{AppID: "billing"})
	if got := c.serveURLFor(r); got != "https://public.example.com/prod/flow" {
		t.Fatalf("FLOW_SERVE_URL: got %q", got)
	}
	c, _ = NewClient(ClientOpts{AppID: "billing", ServeURL: StrPtr("https://opt.example.com/flow")})
	if got := c.serveURLFor(r); got != "https://opt.example.com/flow" {
		t.Fatalf("ServeURL option must win over env: got %q", got)
	}
	c, _ = NewClient(ClientOpts{AppID: "billing", ServeURL: StrPtr("")})
	if got := c.serveURLFor(r); got != "https://billing.example.com/api/flow" {
		t.Fatalf("empty ServeURL counts as not set: got %q", got)
	}
	for _, bad := range []string{
		"billing.example.com/flow", "/api/flow", "ftp://x.example.com/flow", "https://", "https:host/flow",
		"https://u:p@billing.example.com/flow", "https://billing.example.com/flow?x=1", "https://billing.example.com/flow?",
		"https://billing.example.com/flow#top",
	} {
		if _, err := NewClient(ClientOpts{AppID: "billing", ServeURL: StrPtr(bad)}); err == nil {
			t.Fatalf("bad ServeURL %q accepted", bad)
		}
	}
	if _, err := NewClient(ClientOpts{AppID: "billing", SigningKey: StrPtr("nope")}); err == nil {
		t.Fatal("bad signing key accepted")
	}
	if _, err := NewClient(ClientOpts{AppID: "bad id"}); err == nil {
		t.Fatal("bad app id accepted")
	}
}

func TestRepanicHelper(t *testing.T) {
	c := newClient(t, ClientOpts{})
	define(t, c, "fn", func(ctx context.Context, in Input[charge]) (out any, err error) {
		defer func() {
			if r := recover(); r != nil {
				step.Repanic(r)
				err = errors.New("swallowed")
			}
		}()
		return step.Run(ctx, "x", func(ctx context.Context) (int, error) { return 1, nil })
	})
	ops := run(t, c, "fn", reqOpts{}).ops(t)
	if ops[0]["op"] != "StepCompleted" {
		t.Fatalf("ops = %v", ops)
	}
}

func TestNestedStepFails(t *testing.T) {
	c := newClient(t, ClientOpts{})
	define(t, c, "fn", func(ctx context.Context, in Input[charge]) (any, error) {
		return step.Run(ctx, "outer", func(ctx context.Context) (any, error) {
			return step.Run(ctx, "inner", func(ctx context.Context) (any, error) { return nil, nil })
		})
	})
	ops := run(t, c, "fn", reqOpts{}).ops(t)
	if ops[0]["op"] != "StepFailed" || !strings.Contains(string(mustJSON(ops[0]["error"])), "inside another step") {
		t.Fatalf("ops = %v", ops)
	}
}

func mustJSON(v any) []byte { b, _ := json.Marshal(v); return b }

func testFunctions(t *testing.T, c *Client) {
	t.Helper()
	_, err := CreateFunction(c, FunctionOpts{
		ID:          "charge",
		Name:        "Charge",
		Retries:     IntPtr(4),
		Timeouts:    &Timeouts{Step: 30 * time.Second, Finish: 15 * time.Minute},
		CancelOn:    []CancelOn{{Event: "billing/cancel", Match: StrPtr("data.id"), Timeout: 7 * 24 * time.Hour}},
		Concurrency: []Concurrency{{Limit: 10, Key: StrPtr("event.data.accountId")}},
		Throttle:    &Throttle{Limit: 5, Period: time.Minute, Burst: 2},
		RateLimit:   &RateLimit{Limit: 100, Period: time.Hour, Key: StrPtr("event.data.id")},
		Priority:    &Priority{Run: StrPtr("event.data.boost")},
		Idempotency: StrPtr("event.data.id"),
		Singleton:   &Singleton{Mode: "skip"},
		Debounce:    &Debounce{Period: 1500 * time.Millisecond, Timeout: 5 * time.Minute},
	}, EventTrigger("billing/charge", StrPtr("event.data.amount != 0")), func(ctx context.Context, in Input[charge]) (any, error) {
		return nil, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = CreateFunction(c, FunctionOpts{
		ID:          "nightly",
		BatchEvents: &BatchEvents{MaxSize: 10, Timeout: 5 * time.Second},
	}, MultipleTriggers{CronTrigger("TZ=Africa/Lagos 0 2 * * *"), EventTrigger("billing/run", nil)},
		func(ctx context.Context, in Input[any]) (any, error) { return nil, nil })
	if err != nil {
		t.Fatal(err)
	}
}

const wantFunctions = `[{"id":"charge","name":"Charge","triggers":[{"event":"billing/charge","if":"event.data.amount != 0"}],` +
	`"retries":4,"timeouts":{"step":"30s","finish":"900s"},"cancelOn":[{"event":"billing/cancel","match":"data.id","timeout":"604800s"}],` +
	`"concurrency":[{"limit":10,"key":"event.data.accountId"}],"throttle":{"limit":5,"period":"60s","burst":2},` +
	`"rateLimit":{"limit":100,"period":"3600s","key":"event.data.id"},"debounce":{"period":"1500ms","timeout":"300s"},` +
	`"priority":{"run":"event.data.boost"},"idempotency":"event.data.id","singleton":{"mode":"skip"}},` +
	`{"id":"nightly","triggers":[{"cron":"TZ=Africa/Lagos 0 2 * * *"},{"event":"billing/run"}],` +
	`"batchEvents":{"maxSize":10,"timeout":"5s"}}]`

func TestGetManifest(t *testing.T) {
	c := newClient(t, ClientOpts{})
	testFunctions(t, c)
	sig, _ := signRequest(testKey, nil, testNow)
	a := send(t, c, http.MethodGet, nil, sig)
	if a.status != 200 {
		t.Fatalf("got %d %s", a.status, a.body)
	}
	var m struct {
		AppID     string          `json:"appId"`
		URL       string          `json:"url"`
		SDK       SDKInfo         `json:"sdk"`
		Functions json.RawMessage `json:"functions"`
	}
	if err := json.Unmarshal(a.body, &m); err != nil {
		t.Fatal(err)
	}
	if m.AppID != "billing" || m.URL != "https://billing.example.com/api/flow" || m.SDK.Language != "go" || m.SDK.Version != Version {
		t.Fatalf("manifest = %s", a.body)
	}
	if string(m.Functions) != wantFunctions {
		t.Fatalf("functions =\n%s\nwant\n%s", m.Functions, wantFunctions)
	}
	if a := send(t, c, http.MethodGet, nil, ""); a.status != 401 {
		t.Fatalf("unsigned GET: %d", a.status)
	}
}

func TestPutSync(t *testing.T) {
	var got struct {
		method, path, auth, ctype string
		body                      []byte
	}
	engine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.method, got.path, got.auth, got.ctype = r.Method, r.URL.Path, r.Header.Get("Authorization"), r.Header.Get("Content-Type")
		got.body, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"created":true,"modified":["charge"],"archived":[]}`))
	}))
	defer engine.Close()

	// The manifest URL is the URL of the PUT request itself.
	c := newClient(t, ClientOpts{BaseURL: StrPtr(engine.URL + "/")})
	testFunctions(t, c)
	a := send(t, c, http.MethodPut, nil, "")
	if a.status != 200 || !strings.Contains(string(a.body), `"created":true`) {
		t.Fatalf("got %d %s", a.status, a.body)
	}
	if got.method != http.MethodPut || got.path != "/apps/billing/sync" || got.auth != "Bearer "+testBearer || got.ctype != "application/json" {
		t.Fatalf("request = %+v", got)
	}
	want := `{"appId":"billing","url":"https://billing.example.com/api/flow","sdk":{"language":"go","version":"` + Version +
		`"},"functions":` + wantFunctions + `}`
	if string(got.body) != want {
		t.Fatalf("body =\n%s\nwant\n%s", got.body, want)
	}
}

// ServeURL goes in the manifest of the signed GET answer and of the PUT sync,
// in place of the URL the request shows (here a proxy changed host and path).
func TestServeURLInManifest(t *testing.T) {
	var synced []byte
	engine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		synced, _ = io.ReadAll(r.Body)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer engine.Close()
	const public = "https://public.example.com/prod/api/flow"
	c := newClient(t, ClientOpts{BaseURL: StrPtr(engine.URL), ServeURL: StrPtr(public)})
	testFunctions(t, c)

	sig, _ := signRequest(testKey, nil, testNow)
	a := send(t, c, http.MethodGet, nil, sig)
	var m AppManifest
	if err := json.Unmarshal(a.body, &m); err != nil || a.status != 200 || m.URL != public {
		t.Fatalf("GET: %d %s", a.status, a.body)
	}
	if a.header.Get(core.HeaderAnswerSignature) == "" {
		t.Fatal("GET answer is not signed")
	}

	if a := send(t, c, http.MethodPut, nil, ""); a.status != 200 {
		t.Fatalf("PUT: %d %s", a.status, a.body)
	}
	if err := json.Unmarshal(synced, &m); err != nil || m.URL != public {
		t.Fatalf("sync body = %s", synced)
	}

	// Client.Sync with no URL uses ServeURL.
	synced = nil
	if status, _, err := c.Sync(context.Background(), ""); err != nil || status != 200 {
		t.Fatalf("Sync: %d %v", status, err)
	}
	if err := json.Unmarshal(synced, &m); err != nil || m.URL != public {
		t.Fatalf("Sync body = %s", synced)
	}
	if _, _, err := newClient(t, ClientOpts{}).Sync(context.Background(), ""); err == nil {
		t.Fatal("Sync with no URL and no ServeURL must fail")
	}
}

func TestPutSyncPassesEngineError(t *testing.T) {
	engine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		_, _ = w.Write([]byte(`{"error":"invalid signing key","status":401}`))
	}))
	defer engine.Close()
	c := newClient(t, ClientOpts{BaseURL: StrPtr(engine.URL)})
	a := send(t, c, http.MethodPut, nil, "")
	if a.status != 401 || !strings.Contains(string(a.body), "invalid signing key") {
		t.Fatalf("got %d %s", a.status, a.body)
	}
}

func TestClientSend(t *testing.T) {
	var auth, path string
	var body []byte
	engine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth, path = r.Header.Get("Authorization"), r.URL.Path
		body, _ = io.ReadAll(r.Body)
		if strings.HasPrefix(string(body), "[") {
			_, _ = w.Write([]byte(`{"ids":["e1","e2"],"status":200}`))
			return
		}
		_, _ = w.Write([]byte(`{"ids":["e1"],"status":200}`))
	}))
	defer engine.Close()
	c := newClient(t, ClientOpts{BaseURL: StrPtr(engine.URL), EventKey: StrPtr("evkey")})
	id, err := c.Send(context.Background(), Event{Name: "billing/charge", Data: map[string]int{"amount": 5}})
	if err != nil || id != "e1" || auth != "Bearer evkey" || path != "/e" || string(body) != `{"name":"billing/charge","data":{"amount":5}}` {
		t.Fatalf("id=%q err=%v auth=%q path=%q body=%s", id, err, auth, path, body)
	}
	ids, err := c.SendMany(context.Background(), []Event{{Name: "a"}, {Name: "b"}})
	if err != nil || len(ids) != 2 || string(body) != `[{"name":"a"},{"name":"b"}]` {
		t.Fatalf("ids=%v err=%v body=%s", ids, err, body)
	}
}

func TestCreateFunctionChecks(t *testing.T) {
	c := newClient(t, ClientOpts{})
	ok := func(ctx context.Context, in Input[any]) (any, error) { return nil, nil }
	if _, err := CreateFunction(c, FunctionOpts{ID: "bad id"}, EventTrigger("x", nil), ok); err == nil {
		t.Fatal("bad id accepted")
	}
	if _, err := CreateFunction(c, FunctionOpts{ID: "a"}, MultipleTriggers{}, ok); err == nil {
		t.Fatal("no trigger accepted")
	}
	fn, err := CreateFunction(c, FunctionOpts{ID: "a"}, EventTrigger("x", nil), ok)
	if err != nil || fn.FullyQualifiedID() != "billing-a" {
		t.Fatalf("fn=%v err=%v", fn, err)
	}
	if _, err := CreateFunction(c, FunctionOpts{ID: "a"}, EventTrigger("x", nil), ok); err == nil {
		t.Fatal("duplicate id accepted")
	}
}
