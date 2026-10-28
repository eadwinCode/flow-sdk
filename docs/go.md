# Go reference

The Go SDK is the module `github.com/eadwinCode/flow-sdk`. Its one dependency is
`github.com/coder/websocket`, for `Subscribe` and `Streams().Read`. This page lists
what it has. For how to use it, start with the
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
| `HTTPClient` | | Used for every call to the engine, and for sockets. Default `http.DefaultClient`. |
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
`Throttle`, `RateLimit`, `Debounce`, `BatchEvents`, `Priority`, `Idempotency`,
`Singleton` and `Tags`. They are the same options as in TypeScript; see
[Functions and steps](functions.md#all-function-options). Durations are
`time.Duration`; the SDK sends them as whole seconds (`"90s"`) or else as ms.

`Tags` (v0.7.0) names up to 3 values of a run, each an expression over `event`.
The engine works them out once, when the run starts. `client.Runs().List` and
`client.Runs().Cancel` can then find runs by them:

```go
flow.FunctionOpts{ID: "agentenkit-run", Tags: map[string]string{"agentRun": "event.data.job.runId"}}
```

A tag name is a letter, then letters, digits or `_`, up to 32 in all.
`CreateFunction` fails for more than 3 tags or a bad name. A value that is not a
string, number or boolean, or is over 256 characters, is left out of the run.

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
[Errors and retries](errors.md#when-a-run-fails-for-good). Use
`flow.FailedEventData` as its `T`:

```go
flow.CreateFunction(client, flow.FunctionOpts{ID: "charge-failed"},
	flow.EventTrigger("inngest/function.failed", flow.StrPtr("event.data.function_id == 'billing-charge'")),
	func(ctx context.Context, in flow.Input[flow.FailedEventData]) (any, error) {
		d := in.Event.Data
		log.Printf("run %s failed after %d tries: %s", d.RunID, d.Attempts, d.Error.Message)
		return nil, nil
	})
```

| Field | What it is |
| --- | --- |
| `FunctionID` | The failed function's full ID, `<appId>-<id>`. |
| `RunID` | The failed run. |
| `Error` | Why it failed, a `*flow.StepError`. |
| `Event` | The run's trigger event, as JSON (`json.RawMessage`). |
| `Attempts` | How many times the step that failed the run was tried. `0` when no step try failed it, for example a finish timeout. Engines before v0.7.0 do not send it. |

## Sending and realtime

| Method | What it does |
| --- | --- |
| `client.Send(ctx, flow.Event{...})` | Sends one event; gives back its ID. |
| `client.SendMany(ctx, []flow.Event{...})` | Sends up to 100; gives back their IDs. |
| `client.Start(ctx, functionID, flow.StartOpts{...})` | Starts a run now. See [Start a run](#start-a-run). |
| `client.Realtime().Publish(ctx, channel, topic, data)` | Sends a live message. |
| `client.Realtime().PublishMany(ctx, []flow.RealtimeOut{...})` | Sends 1 to 100 live messages in one call. |
| `client.Realtime().Token(ctx, channel, topics...)` | A token for one browser. |
| `client.Realtime().TokenMany(ctx, channels, topics...)` | A token for 1 to 100 channels, on one socket. The names may have 8,000 characters in all. |
| `client.Realtime().Subscribe(ctx, flow.SubscribeOpts{...})` | Reads live messages on a server. See [Subscribe from a server](#subscribe-from-a-server). |
| `client.Sync(ctx, serveURL)` | Sends the manifest with this URL. Gives back the engine's status and body. |
| `client.Manifest(serveURL)`, `client.ManifestHash()` | The manifest and its hash. |

`flow.Event` has `Name`, `Data`, `ID` (`*string`), `Timestamp` (ms) and `User`.

Both SDKs speak the same protocol, so a Go function can `step.Invoke` a TypeScript
function, and the other way round.

## Start a run

v0.7.0. `client.Start` starts a run of one of this app's functions now, with no
event to match. Unlike `client.Send`, it tells you at once if the run did not
start:

```go
res, err := client.Start(ctx, "agentenkit-run", flow.StartOpts{
	Data: map[string]any{"job": job},
	ID:   job.ID, // optional: a retry with the same ID finds the same run
})
if err != nil {
	return err // the call failed: 401, 429, a network error, ...
}
if !res.Started && res.Reason == "singleton" {
	// Another run holds the singleton key: res.ActiveRunID
}
```

| `StartResult` field | What it is |
| --- | --- |
| `Started` | `true` when there is a run. |
| `RunID`, `EventID` | The run and its event. |
| `Existed` | `true` when a run with this `ID` was there already. Nothing new started. |
| `Reason` | Why no run started: `singleton`, `paused` or `not_found`. |
| `ActiveRunID` | With `singleton`: the run that holds the key. Empty if it ended in between. |

The first argument is the function's own ID, as in `FunctionOpts.ID`. Singleton,
throttle, concurrency and priority apply. Rate limit, debounce and batching do not.
The run exists when `Start` returns, so a `Runs().Cancel` right after it can not
miss it.

## Find and cancel runs

v0.7.0. `client.Runs()` sees only this app's runs.

| Method | What it does |
| --- | --- |
| `List(ctx, flow.ListRunsOpts{Function, Status, Tags, Limit, Before})` | Lists runs, newest first. Gives a `flow.RunPage`: `Items` and `Next`. Pass `Next` as `Before` for the next page; it is empty on the last page. |
| `Counts(ctx, functionID)` | How many of the function's runs are in each status (`flow.RunCounts`). |
| `Singleton(ctx, functionID, key)` | The active run that holds a singleton key (`RunID`, `Status`), or empty strings when none does. |
| `Cancel(ctx, flow.CancelOpts{...})` | Cancels runs. Gives `Cancelled`, `NotActive` and `More`. |

- `List` and `Counts` read the engine's run index, which is a few seconds behind the
  runs. `Singleton` is exact.
- `ListRunsOpts.Tags` needs `Function`. It takes up to 3 tags; a run must have all of
  them. `Status` takes statuses such as `queued`, `running`, `sleeping`.
- `RunCounts.Since` is a time (ms): ended runs older than it may be gone from the
  counts already.
- `Singleton` takes the value the function's singleton key expression gives: a
  string, or any other JSON value.

`Cancel` takes exactly one of these:

```go
client.Runs().Cancel(ctx, flow.CancelOpts{RunID: "run_..."})
client.Runs().Cancel(ctx, flow.CancelOpts{Function: "agentenkit-run", SingletonKey: "hitl-expiry:call_1"})
client.Runs().Cancel(ctx, flow.CancelOpts{
	Function: "agentenkit-run",
	Tag:      map[string]string{"agentRun": "r_123"},
	Status:   []string{"queued", "sleeping"}, // optional, only with Tag
})
```

A run that has ended already is not an error: it is in `NotActive`. A `Status`
that is empty but not nil is an error, so an empty filter never cancels every
active run. (In `List`, an empty `Status` means every status.) A cancel by tag
cancels up to 500 runs, oldest first. When `More` is `true`, call it again with
`Cursor` set to the answer's `Next`, so it goes on after this page. `Cursor` is only
for a cancel by tag; `Next` is empty when there is no more.

## Subscribe from a server

v0.7.0. `client.Realtime().Subscribe` reads live messages on a server, the way the
TypeScript `subscribe` does in a browser:

```go
stop, err := client.Realtime().Subscribe(ctx, flow.SubscribeOpts{
	Channel:   "agentenkit.thread.t_1", // or Channels: up to 100 (8,000 characters of names), on one socket
	Topics:    []string{"events"},
	OnMessage: func(m flow.RealtimeMessage) { log.Println(m.Topic, string(m.Data)) },
	OnState:   func(s flow.RealtimeState, err error) { log.Println("realtime:", s, err) },
})
if err != nil {
	return err // bad options only
}
defer stop()
```

- It makes a new token before every connect, with the signing key, so you need no
  token route.
- It sends `"ping"` every 30 seconds. When the socket drops, it connects again after
  a wait: 1 second, doubling up to 30 seconds, with some random. When the engine ends
  the socket at the end of its 1-hour life, it connects again at once.
- `OnMessage` runs on one goroutine, one message at a time. `RealtimeMessage` has
  `Channel`, `Topic`, `Data` (`json.RawMessage`) and `TS` (ms).
- `OnState` gets `connecting`, `open`, `closed` and `error` (with the error).
- It runs until you call `stop` or `ctx` ends. `stop` waits until it has ended, so
  no callback runs after it returns. So do not call `stop` inside `OnMessage` or
  `OnState`: to end from there, cancel the `ctx` you gave `Subscribe`, or call
  `go stop()`.

**Messages can be lost.** No message is stored. While the socket connects again,
and at the 1-hour renewal, messages sent in that time are lost. Use them as hints:
keep the real state in your own store, and read what you missed from it when
`OnState` gets `open` again.

`Subscribe` and `Streams().Read` connect to the engine at your `BaseURL`, with the
path from the token. They do not use the host in the token's `url`: the engine makes
that from the host it sees, which is wrong behind a proxy and under `wrangler dev`.

## Streams

v0.7.0. A stream is a short list of items, for example the output of one run, that
a reader can read from any point and then follow live. It belongs to this app. One
writer opens it, appends to it, and closes it with an end item. See
[Limits](limits.md) for the sizes.

```go
s := client.Streams()
_, err := s.Open(ctx, "run_1:1", flow.StreamOpenOpts{Meta: meta, TTL: time.Hour})
offsets, err := s.Append(ctx, "run_1:1", item1, item2) // one offset per item
_, err = s.Close(ctx, "run_1:1", endItem, 5*time.Minute)

for item, err := range s.Read(ctx, "run_1:1", lastOffset) {
	if errors.Is(err, flow.ErrStreamGone) {
		break // never opened, or deleted
	}
	if err != nil {
		return err
	}
	lastOffset = item.Offset
	handle(item) // the last one has item.End set; the loop ends after it
}
```

| Method | What it does |
| --- | --- |
| `Open(ctx, id, flow.StreamOpenOpts{Meta, TTL})` | Makes a stream, deleted `TTL` later (1s to 7 days) if it is not closed. Gives `false` when it existed already; then nothing changes. |
| `Append(ctx, id, items...)` | Adds 1 to 100 items in order. Gives one offset for each. |
| `Snapshot(ctx, id, after)` | The items after `after` now, with no wait: `Meta`, `Items` and `Ended`. Reads every page. `nil, nil` when the stream is gone. |
| `Close(ctx, id, end, grace)` | Writes `end` as the last item and closes the stream. It is deleted `grace` later (0 to 7 days), so late readers still get the end. Gives `false` when it was closed already. |
| `Delete(ctx, id)` | Deletes the stream now. Gives `false` when there was none. |
| `Token(ctx, id)` | A token for one browser to read the stream. |
| `Read(ctx, id, after)` | The items after `after`, then new ones as they come, until the end item. An `iter.Seq2[flow.StreamItem, error]`. |

- A stream ID is letters, digits and `: _ . -`, up to 256. `.`, `..`, `token` and
  `connect` are not allowed.
- Items and `Meta` are any JSON value. `StreamItem` has `Offset`, `Item`
  (`json.RawMessage`) and `End`.
- Offsets are text. Do not read meaning into them: keep the last one you got and
  pass it as `after`. `""` means from the start. `Read` gives an error at once for
  an `after` that is not a whole number of up to 15 digits.
- `Append` fails with `flow.ErrStreamGone` when the stream does not exist, and with
  `flow.ErrStreamClosed` after `Close`. `Close` fails with `flow.ErrStreamGone` too.
  Check them with `errors.Is`.
- `Read` makes a new token before every connect. When the socket drops, it connects
  again from the last offset it gave you, with the same waits as `Subscribe`, so no
  item is lost or given twice. It gives `flow.ErrStreamGone` and stops when the
  stream does not exist or is deleted while you read. It stops with no error when
  `ctx` ends or you `break`, and closes the socket. It also stops with no error and
  no item when the stream is closed and has nothing after `after`: you had the end
  item already.
