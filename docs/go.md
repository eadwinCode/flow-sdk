# Go SDK

Write durable functions in Go and run them on the clevix-worker engine. The API
follows Inngest's `inngestgo`. Standard library only.

## Install

Needs Go 1.27+.

```bash
go get github.com/eadwinCode/flow-sdk@latest
```

The module is public, so no login or `GOPRIVATE` is needed. Import it as:

```go
import (
	flow "github.com/eadwinCode/flow-sdk"
	"github.com/eadwinCode/flow-sdk/group" // parallel steps
	"github.com/eadwinCode/flow-sdk/step"
)
```

Pin a version with `@v0.2.0` in place of `@latest`. To upgrade, run `go get`
again with the new version, then `go mod tidy`. The versions are the
[releases](https://github.com/eadwinCode/flow-sdk/releases).

A new release can take a few minutes to show up through the Go proxy. If
`go get ...@vX.Y.Z` says `unknown revision` right after a release, wait a bit or
run it with `GOPROXY=direct`.

## Example

```go
package main

import (
	"context"
	"errors"
	"net/http"
	"time"

	flow "github.com/eadwinCode/flow-sdk"
	"github.com/eadwinCode/flow-sdk/step"
)

type SignedUp struct {
	UserID string `json:"userId"`
}

func main() {
	client, err := flow.NewClient(flow.ClientOpts{AppID: "billing-service"})
	if err != nil {
		panic(err)
	}

	_, err = flow.CreateFunction(client,
		flow.FunctionOpts{ID: "user-onboarding", Retries: flow.IntPtr(5)},
		flow.EventTrigger("user/signed-up", nil),
		func(ctx context.Context, in flow.Input[SignedUp]) (any, error) {
			name, err := step.Run(ctx, "load-user", func(ctx context.Context) (string, error) {
				return loadName(ctx, in.Event.Data.UserID)
			})
			if err != nil {
				return nil, err
			}
			step.Sleep(ctx, "wait-3-days", 72*time.Hour)

			_, err = step.WaitForEvent[flow.GenericEvent[SignedUp]](ctx, "wait-onboarded", step.WaitForEventOpts{
				Event:   "user/onboarded",
				Match:   flow.StrPtr("data.userId"),
				Timeout: 7 * 24 * time.Hour,
			})
			if errors.Is(err, step.ErrEventNotReceived) {
				return "nudged " + name, nil
			}
			return name, err
		},
	)
	if err != nil {
		panic(err)
	}

	// One endpoint: POST runs, PUT syncs, GET shows the manifest.
	http.Handle("/api/flow", client.Serve())
	_ = http.ListenAndServe(":8080", nil)
}

func loadName(ctx context.Context, id string) (string, error) { return "Ada", nil }
```

After each deploy, sync the app: `curl -X PUT https://your-app/api/flow`.

## Settings

Set these as environment variables, or in `flow.ClientOpts` (code wins).

| Variable | Use |
| --- | --- |
| `FLOW_SIGNING_KEY` | Checks calls from the engine and signs sync. Required unless dev. |
| `FLOW_SIGNING_KEY_FALLBACK` | Old key while rotating. |
| `FLOW_EVENT_KEY` | For `client.Send` and `client.SendMany`. |
| `FLOW_BASE_URL` | Engine URL. Also needed to load big run state (see below). |
| `FLOW_SERVE_URL` | Public URL of your endpoint. If unset, taken from the PUT request. |
| `FLOW_DEV` | `1` turns off signature checks. |

Without a signing key, and not in dev mode, `Serve()` answers every request
with 500 `NoSigningKey`.

Both keys come from the dashboard's Keys page. Each is shown once, when you
make it. In code:

```go
client, err := flow.NewClient(flow.ClientOpts{
	AppID:      "billing",
	SigningKey: flow.StrPtr(os.Getenv("MY_SIGNING_KEY")), // any source you like
	EventKey:   flow.StrPtr(os.Getenv("MY_EVENT_KEY")),
	BaseURL:    flow.StrPtr("https://worker.clevixstudio.com"),
	ServeURL:   flow.StrPtr("https://billing.example.com/api/flow"),
})
```

Where each key is used:

- The **signing key** is used by `client.Serve()` only: to check calls from
  the engine, and to sign the sync on `PUT`. Keep it secret.
- The **event key** is used by `client.Send` and `client.SendMany`. Only
  needed if this app sends events. Keep it secret.

```go
id, err := client.Send(ctx, flow.Event{Name: "user/signed-up", Data: map[string]any{"userId": "u_1"}})
```

## Things to know

- **Replay.** The engine calls your function from the top each time. Finished
  steps return their saved result. When the function reaches a new step, the
  SDK runs it (or tells the engine about it) and stops the function with a
  special panic that `Serve()` catches. If you use `recover()` around step
  calls, call `step.Repanic(r)` first so that panic goes on.
- **Step IDs** must not change between calls. Reusing an ID in a loop is fine.
  Do not call steps from your own goroutines.
- **Parallel steps.** Use `group.Parallel(ctx, fns...)`. Give each step inside
  it its own ID.
- **Errors.** An error (or a panic) in a `step.Run` callback fails that attempt;
  the engine retries the step. This is the same as a thrown error in the
  TypeScript SDK. A panic is reported with the name `Panic` and its stack.
  Error names match the TypeScript SDK: `NonRetriableError` for
  `flow.NoRetryError`, `RetryAfterError` for `flow.RetryAtError`, else `Error`. Wrap it with `flow.NoRetryError(err)` to fail at once, or
  `flow.RetryAtError(err, at)` to pick the retry time. When a step is out of
  retries, `step.Run` returns a `*step.StepError`, so you can run compensation
  steps. `step.IdempotencyKey(ctx)` inside a callback gives a key that is the
  same on every attempt.
- **Durations** in config and steps are sent as `"<n>s"` when they are whole
  seconds, else `"<n>ms"`.
- **On failure.** Make a second function with the trigger
  `flow.EventTrigger("inngest/function.failed", flow.StrPtr("event.data.function_id == '<appId>-<id>'"))`.
  Its event data has `function_id`, `run_id`, `error` and `event` (the
  original trigger event).
- **Big state.** When a run's state (events and step results) is over 4 MiB,
  the engine does not send it in the call. The SDK loads it from the engine
  first, signed with your signing key. So set `FLOW_BASE_URL` for apps whose
  runs can hold more than 4 MiB. If loading fails, the call answers 500
  `StateLoadFailed` and the engine tries again.
- **Invoke** takes the full function ID, `"<appId>-<functionId>"`. The other
  function can be in any app and any language.

Both SDKs speak the same wire protocol and pass the same conformance suite, so
an engine cannot tell a Go app from a TypeScript one. The tests check the
shared conformance vectors.
