# Flow control

Options that decide **when** and **how many** runs go. You set them on the function;
the engine does the rest. The code is in
[`examples/ts/flow-control.ts`](https://github.com/eadwinCode/flow-sdk/blob/main/examples/ts/flow-control.ts)
and [`examples/go/flowcontrol/main.go`](https://github.com/eadwinCode/flow-sdk/blob/main/examples/go/flowcontrol/main.go).

| Problem | Option | What happens to extra work |
| --- | --- | --- |
| An outside API takes only N calls at once | [`concurrency`](#concurrency) | waits |
| Start at most N runs a minute, evenly | [`throttle`](#throttle) | waits |
| Start at most N runs an hour, drop the rest | [`rateLimit`](#rate-limit) | **dropped** |
| Many events in a burst; only the last one matters | [`debounce`](#debounce) | replaced by the newest |
| Handle events in groups (one insert for many) | [`batchEvents`](#batching) | grouped |
| Some runs should go first | [`priority`](#priority) | goes first |
| One run per order ID, whatever happens | [`idempotency`](#idempotency) | ignored |
| Only one run per user at a time | [`singleton`](#singleton) | skipped, or the old run cancelled |

Most options take a **`key`**: an [expression](functions.md#expressions) over `event`,
like `"event.data.accountId"`. With a key, the limit counts each value on its own:
"5 at once **per account**" instead of "5 at once in all".

Durations are text like `"30s"`, `"1m"`, `"24h"` in TypeScript, and a
`time.Duration` in Go.

The engine checks the options when you sync. A bad value is refused with a message
such as `function f: throttle period must be between 1s and 168h`.

## Concurrency

Limits how many **steps** of the function run at the same time.

::: code-group
<<< @/../examples/ts/flow-control.ts#concurrency [TypeScript]
<<< @/../examples/go/flowcontrol/main.go#concurrency [Go]
:::

- **Steps, not runs.** The limit counts calls to your app that are in progress. A run
  that is sleeping or waiting for an event holds no slot. So 1,000 runs can be in
  progress with a limit of 5; only 5 do work at any moment.
- When the limit is full, new work waits its turn (see [priority](#priority)).
  Nothing is dropped.
- `concurrency: 5` (TypeScript) is short for `{ limit: 5 }`. A `limit` of `0` means
  no limit. Up to 100,000.
- Up to **2** limits per function. Two limits can not have the same scope and key.
- If your app dies in the middle of a step, its slot is freed after the step timeout
  plus 2 minutes.

### Share a limit between functions

With `scope: "account"` and a `key`, every function in the workspace that uses the
same key expression and gets the same value shares one limit. Good for "all our
code may call this partner API 10 times at once". `scope: "env"` means the same as
`"account"`, and both need a `key`.

::: code-group
<<< @/../examples/ts/flow-control.ts#shared-concurrency [TypeScript]
<<< @/../examples/go/flowcontrol/main.go#shared-concurrency [Go]
:::

The key `'partner-api'` is a fixed text, so every run of both functions gets the same
value.

## Throttle

Starts at most `limit` runs per `period`, spread out evenly. Extra runs **wait**;
none are lost.

::: code-group
<<< @/../examples/ts/flow-control.ts#throttle [TypeScript]
<<< @/../examples/go/flowcontrol/main.go#throttle [Go]
:::

- With `limit: 60, period: "1m"`, one run can start each second. `burst` lets that
  many more start at once after a quiet time (default 0).
- Throttle acts when a run **starts**. After that, its steps are not slowed. To limit
  work in progress, use `concurrency`.
- `limit` 1 to 100,000; `period` 1 second to 7 days.
- Applies to runs from events and cron. Not to `step.invoke`.

## Rate limit

Starts at most `limit` runs per `period`. Extra events are **dropped**: no run, and
no error to the sender.

::: code-group
<<< @/../examples/ts/flow-control.ts#rate-limit [TypeScript]
<<< @/../examples/go/flowcontrol/main.go#rate-limit [Go]
:::

On a local engine, three `stock/low` events (two for `p1`, one for `p2`) started two
runs: one for each product.

- Use it when extra work is truly not wanted (alerts). When the work must happen, use
  `throttle`.
- `limit` 1 to 100,000; `period` 1 second to 7 days.
- Applies only to runs started by events. Not to cron or `step.invoke`.

## Debounce

Waits until events stop coming for `period`, then starts **one** run with the
**last** event.

::: code-group
<<< @/../examples/ts/flow-control.ts#debounce [TypeScript]
<<< @/../examples/go/flowcontrol/main.go#debounce [Go]
:::

- Each new event pushes the start back by `period`.
- `timeout` caps the whole wait: the run starts at the latest `timeout` after the
  **first** event, even if events keep coming.
- `period` and `timeout` 1 second to 7 days.
- If the function is paused when the run would start, the event is dropped.
- Debounce ignores `idempotency` and a future `ts`. It can not be used with
  `batchEvents`.

## Batching

Collects events and starts **one** run with many of them.

::: code-group
<<< @/../examples/ts/flow-control.ts#batch [TypeScript]
<<< @/../examples/go/flowcontrol/main.go#batch [Go]
:::

In Go the handler reads the batch from `in.Events`:

<<< @/../examples/go/flowcontrol/main.go#batch-handler{go}

On a local engine, three `page/clicked` events for one site started one run, 10
seconds after the first, with all three events.

- The run starts when the batch has `maxSize` events, or `timeout` after its
  **oldest** event, or when its events add up to 4 MB, whichever comes first.
- The handler gets all of them in `events` (Go: `in.Events`); `event` is the first.
- `if` (optional) picks which events go into batches. An event that does not match
  starts a run of its own at once.
- `maxSize` 1 to 100; `timeout` 1 second to 1 hour.
- Batching ignores `idempotency`. It can not be used with `debounce`.

## Priority

Lets some runs go first when they wait for a [concurrency](#concurrency) slot.

::: code-group
<<< @/../examples/ts/flow-control.ts#priority [TypeScript]
<<< @/../examples/go/flowcontrol/main.go#priority [Go]
:::

- `run` is an expression that gives a number of **seconds**, from -600 to 600. `120`
  means "treat this run as if it had waited 2 minutes longer". A negative number
  puts a run back.
- It only changes the order of work **waiting for a concurrency slot**. Without a
  concurrency limit nothing waits, and priority does nothing.
- If the expression fails or does not give a number, the priority is 0.

## Idempotency

At most one run per value of an expression.

::: code-group
<<< @/../examples/ts/flow-control.ts#idempotency [TypeScript]
<<< @/../examples/go/flowcontrol/main.go#idempotency [Go]
:::

On a local engine, two `order/paid` events for `o1` started one run.

- An event with a value already seen gets no new run, while the engine keeps the
  first run: while it runs, and 3 days after it ends (4 days after it failed).
- The value is tied to the function's full ID. Deleting the app and adding it again
  with the same ID does not forget the values.
- Build the value from several fields with an expression:
  `"event.data.userId + '-' + event.data.day"`.
- If the expression fails (a missing field), the value is `"null"`, and all those
  events share **one** run. Make sure the field is always there.
- Applies only to runs started by events, and not with `debounce` or `batchEvents`.
- To drop a repeated *event* (the same thing sent twice), give the event an
  [`id`](events.md#send-an-event-only-once).

## Singleton

Only one active run at a time, in all or per key.

::: code-group
<<< @/../examples/ts/flow-control.ts#singleton [TypeScript]
<<< @/../examples/go/flowcontrol/main.go#singleton [Go]
:::

- `mode: "skip"`: while a run is active, new events start no run.
- `mode: "cancel"`: the active run is cancelled, and the new one starts. Good for
  "only the newest request matters".
- A run is active until it ends (completed, failed, cancelled), also while it sleeps
  or waits.
- Applies to runs from events and cron. Not to `step.invoke`.

## How they work together

For each event and each matching function, the engine goes in this order:

1. The trigger's `if`. No match: no run.
2. `idempotency` gives the run its ID. A repeat ends here.
3. `rateLimit` may drop the event.
4. `debounce` or `batchEvents` hold the event; their run goes on at step 5 later.
5. `singleton` may skip the run (or cancel the old one).
6. `throttle` may move the start later.
7. While it runs, `concurrency` and `priority` decide which steps go next.

You can combine any of them, except `debounce` with `batchEvents`.

| | Event | Cron | `step.invoke` child |
| --- | --- | --- | --- |
| `concurrency`, `priority` | yes | yes | yes |
| `throttle`, `singleton` | yes | yes | no |
| `rateLimit`, `debounce`, `batchEvents`, `idempotency` | yes | no | no |

Runs keep the flow control they started with. If you change these options and sync,
only new runs use the new values.

The workspace's plan can also cap how many calls run at once over the whole
workspace ("runs at once, in each workspace" on the plan). That limit works like
`concurrency`: a sleeping or waiting run holds no slot.
