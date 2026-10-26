# Go reference

The Go SDK is the module `github.com/eadwinCode/flow-sdk`. It uses the standard
library only. This page lists what it has. For how to use it, start with the
[Quick start](getting-started.md).

## Install

Needs Go 1.27 or later.

```bash
go get github.com/eadwinCode/flow-sdk@v0.6.5
```

The module is public, so no login or `GOPRIVATE` is needed. Import it as:

```go
import (
	flow "github.com/eadwinCode/flow-sdk"
	"github.com/eadwinCode/flow-sdk/group" // parallel steps
	"github.com/eadwinCode/flow-sdk/step"
)
```

To upgrade, run `go get` again with the new version, then `go mod tidy`. Right after a
release, the Go proxy can take a few minutes to see the new tag; if `go get` says
`unknown revision`, wait, or use `GOPROXY=direct`.

v0.6.5 talks to `https://worker.clevixstudio.com` when `FLOW_BASE_URL` is not set.
The next release changes the default to `https://worker.flow.clevixstudio.com`
(`flow.DefaultBaseURL`). Both reach the same engine today.

## Serve your functions

`client.Serve()` gives an `http.Handler` for the endpoint. Mount it on any path:

<<< @/../examples/go/quickstart/main.go#serve

| Method | What it does |
| --- | --- |
| `POST` | Runs a function. Signed by the engine. |
| `PUT` | Syncs: sends the manifest to the engine, and gives back its answer. |
| `GET` | Gives the manifest. Only for signed calls; otherwise `401`. |

The first `Serve()` also starts the [sync at boot](production.md#sync-on-every-deploy)
in the background, after 1 second. Make every function before you call `Serve`: a
function made after it logs a warning, and may be left out of the first sync. Call
`client.Close()` on shutdown to stop the checks.

Without a signing key, and not in dev mode, `Serve()` logs a warning and answers
every request with `500 NoSigningKey`.

## `flow.NewClient(flow.ClientOpts{...})`

| Field | Env var | What it is |
| --- | --- | --- |
| `AppID` | | Required. Letters, digits, `-` and `_`, starting with a letter or digit, up to 64. |
| `SigningKey` | `FLOW_SIGNING_KEY` | The app's signing key. |
| `SigningKeyFallback` | `FLOW_SIGNING_KEY_FALLBACK` | The old key while you rotate. |
| `EventKey` | `FLOW_EVENT_KEY` | For `client.Send` and `client.SendMany`. |
| `BaseURL` | `FLOW_BASE_URL` | The engine's URL. |
| `Dev` | `FLOW_DEV=1` | Turns off signature checks. Local tests only. |
| `HTTPClient` | | Used for sync and sending events. Default `http.DefaultClient`. |
| `NoStreaming` | | Turns off [streamed answers](protocol.md#streamed-answers-sdk-v060-and-later). |
| `HeartbeatInterval` | | Time between heartbeats in a streamed answer. Default 20s. |
| `NoSyncOnBoot` | | Turns off the sync at boot. |

The pointer fields (`*string`, `*bool`) are read from the env var when nil; a value
you set wins. `flow.StrPtr`, `flow.IntPtr` and `flow.BoolPtr` make pointers.
`NewClient` fails on a bad app ID, or a signing key not in the form
`signkey-<64 hex>`.

## `flow.CreateFunction(client, opts, trigger, handler)`

```go
func CreateFunction[T any](c *Client, opts FunctionOpts, trigger Triggerable, handler Handler[T]) (ServableFunction, error)
```

- `T` is the shape of the event's `data`. The SDK decodes the event JSON into
  `flow.Input[T]`. If it can not, the call fails with no retry.
- The handler is `func(ctx context.Context, in flow.Input[T]) (any, error)`. Its
  first result is the run's output.
- `in` has `Event` and `Events` (`flow.GenericEvent[T]`: `ID`, `Name`, `Data`,
  `Timestamp`, `User`) and `InputCtx` (`FunctionID`, `RunID`, `Attempt`,
  `MaxAttempts`).
- The trigger is `flow.EventTrigger(name, ifExpr)`, `flow.CronTrigger(spec)`, or
  `flow.MultipleTriggers{...}`.
- The result's `FullyQualifiedID()` is `<appId>-<id>`, for `step.Invoke` and failure
  handlers.

`FunctionOpts` has `ID`, `Name`, `Retries`, `Timeouts`, `CancelOn`, `Concurrency`,
`Throttle`, `RateLimit`, `Debounce`, `BatchEvents`, `Priority`, `Idempotency` and
`Singleton`. They are the same options as in TypeScript; see
[Functions and steps](functions.md#all-function-options). Durations are
`time.Duration`; the SDK sends them as whole seconds (`"90s"`) or else as ms.

## The `step` package

| Function | Gives back |
| --- | --- |
| `step.Run[T](ctx, id, func(ctx) (T, error))` | `T`, or a `*step.StepError` once the step failed for good |
| `step.Sleep(ctx, id, d)` | `error` |
| `step.SleepUntil(ctx, id, t)` | `error` |
| `step.WaitForEvent[T](ctx, id, step.WaitForEventOpts{Event, Timeout, Match, If})` | `T` (for example `flow.GenericEvent[MyData]`), or `step.ErrEventNotReceived` on timeout |
| `step.Send(ctx, id, events...)` | the event IDs |
| `step.Invoke[T](ctx, id, step.InvokeOpts{FunctionID, Data, User, Timeout})` | the child's output as `T` |
| `step.IdempotencyKey(ctx)` | inside a `Run` callback: `<runId>:<hashed step id>` |
| `step.Repanic(r)` | call it first in any `recover()` around step calls |

Steps called outside a function, or inside another step's callback, give
`step.ErrNotInFunction`.

**How Go stops at a new step.** Go has no `await`, so when the function reaches a new
step, the SDK stops it with a special panic that `Serve()` catches. If you
`recover()` around step calls, call `step.Repanic(r)` first so it goes on.

**Parallel steps.** `group.Parallel(ctx, fns...)` runs each function up to its first
new step; the engine then runs those steps at the same time. It gives back
`group.Results` (`Value`, `Error` per function, and `AnyError()`). Do not call steps
from goroutines you start yourself.

## Errors

| Function | Use |
| --- | --- |
| `flow.NoRetryError(err)` | Fail now, with no more tries (`NonRetriableError`). |
| `flow.RetryAtError(err, at)` | Try again at `at` (`RetryAfterError`). |
| `*step.StepError` | What a step gives back when it failed for good. Has `Name`, `Message`, `Stack`. |

A panic in a `step.Run` callback is a failed try, named `Panic`. Go has no
`onFailure` option: make a second function on `inngest/function.failed`, as in
[Errors and retries](errors.md#when-a-run-fails-for-good).

## Sending and realtime

| Method | What it does |
| --- | --- |
| `client.Send(ctx, flow.Event{...})` | Sends one event; gives back its ID. |
| `client.SendMany(ctx, []flow.Event{...})` | Sends up to 100; gives back their IDs. |
| `client.Realtime().Publish(ctx, channel, topic, data)` | Sends a live message. |
| `client.Realtime().Token(ctx, channel, topics...)` | A token for one browser. |
| `client.Sync(ctx, serveURL)` | Sends the manifest with this URL. Gives back the engine's status and body. |
| `client.Manifest(serveURL)`, `client.ManifestHash()` | The manifest and its hash. |

`flow.Event` has `Name`, `Data`, `ID` (`*string`), `Timestamp` (ms) and `User`.

Both SDKs speak the same protocol, so a Go function can `step.Invoke` a TypeScript
function, and the other way round.
