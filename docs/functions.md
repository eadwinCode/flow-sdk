# Functions and steps

A **function** is code the engine runs for you when its trigger fires. Its body is
made of **steps**: the engine saves each step's result, retries a failed step, and
can pause the function between steps. If these words are new, read
[Core ideas](core-ideas.md) first.

All the code on this page is in
[`examples/ts/steps.ts`](https://github.com/eadwinCode/flow-sdk/blob/main/examples/ts/steps.ts)
and [`examples/go/steps/main.go`](https://github.com/eadwinCode/flow-sdk/blob/main/examples/go/steps/main.go).

## Define a function

TypeScript: `flow.createFunction(options, trigger, handler)`. List the result in
`serve({ client: flow, functions: [...] })`.

Go: `flow.CreateFunction(client, opts, trigger, handler)`. It adds the function to
the client, and `client.Serve()` serves every function on the client. Make all
functions before you call `Serve`. The type parameter (`flow.Input[Order]`) is the
shape of the event's `data`; the SDK decodes the JSON into it.

::: code-group
<<< @/../examples/ts/steps.ts#order [TypeScript]
<<< @/../examples/go/steps/main.go#order [Go]
:::

**IDs.** App and function IDs use letters, digits, `-` and `_`, start with a letter
or digit, and are at most 64 characters. The engine knows a function by
`<appId>-<functionId>`; here `orders-fulfil-order`. A new ID is a new function: the
old one is archived on the next sync.

**Options.** The engine checks every option when you sync, and refuses an unknown
one with `function <id>: unknown option "retry"`. A change of options applies to new
runs; runs that already started keep the options they started with.

**The return value** is the run's output. It is saved as JSON and shown in the
dashboard, and `step.invoke` gives it to the caller.

## Triggers

| Trigger | TypeScript | Go |
| --- | --- | --- |
| An event | `{ event: "order/paid" }` | `flow.EventTrigger("order/paid", nil)` |
| An event, only some | `{ event: "order/paid", if: "event.data.total > 100" }` | `flow.EventTrigger("order/paid", flow.StrPtr("event.data.total > 100"))` |
| A schedule | `{ cron: "0 9 * * MON" }` | `flow.CronTrigger("0 9 * * MON")` |
| Several | `[{ event: "a/one" }, { event: "a/two" }]` | `flow.MultipleTriggers{flow.EventTrigger("a/one", nil), flow.EventTrigger("a/two", nil)}` |

`if` is an [expression](#expressions) over `event`. Schedules are in
[Crons and scheduled jobs](crons.md).

## What the handler gets

| | TypeScript (`ctx`) | Go (`in flow.Input[T]`) |
| --- | --- | --- |
| The event that started the run | `event` | `in.Event` |
| All events (more than one only with [batching](flow-control.md#batching)) | `events` | `in.Events` |
| The run's ID | `runId` | `in.InputCtx.RunID` |
| The try number of the current step, from 0 | `attempt` | `in.InputCtx.Attempt` |
| Step tools | `step` | the `step` package, with `ctx` |

An event has `id`, `name`, `data`, `ts` (ms since 1970) and, if the sender set it,
`user`. See [Events](events.md).

## Rules for steps

The function runs from the top on every call from the engine, and steps that are
done give back their saved result
([replay](core-ideas.md#replay-code-outside-steps-runs-again)). So:

1. **Put side effects in steps.** Code outside a step runs on every call.
2. **Step IDs must not change** between calls or deploys. The engine finds saved
   results by ID.
3. **Keep the order of steps the same** for the same input. Do not choose steps based
   on the time or a random number, unless you got that value from a step.
4. **Step results must be JSON.** Return plain data. A `Date` comes back as a string.
5. **Do not swallow the SDK's control flow.** In TypeScript, catch only real errors
   around steps (see [Errors and retries](errors.md)). In Go, if you `recover()` around
   step calls, call `step.Repanic(r)` first: the SDK stops the function with a panic
   when it reaches a new step.
6. **Go: no steps in your own goroutines.** Use `group.Parallel`.
7. **Up to 1000 steps per run.** A run that goes over fails with
   `run exceeded 1000 steps`.

## The steps

### `run`: do some work, once

Runs your callback, saves what it returns, and gives the saved value back on every
later call. If the callback throws (Go: returns an error, or panics), the step fails
and the engine retries it. The callback gets the step's `idempotencyKey`: the same on
every try of this step. In Go it is `step.IdempotencyKey(ctx)`.

A step can run more than once (when the app crashes after the work, before the
answer). Make it safe to repeat. See
[Background jobs](background-jobs.md#a-step-runs-at-least-once).

### `sleep` and `sleepUntil`: pause the run

::: code-group
<<< @/../examples/ts/steps.ts#sleep [TypeScript]
<<< @/../examples/go/steps/main.go#sleep [Go]
:::

Nothing runs while the run sleeps. A time in the past does not wait.

### `waitForEvent`: wait for something to happen

Pauses until a matching event arrives, or until the timeout. It gives back the event,
or `null` on timeout (Go: `step.ErrEventNotReceived`). See the `wait-for-shipment`
step above.

- `match` is a field path. The wait matches when that field is the same in the event
  that started this run and in the new event.
- `if` is an expression for anything more. `event` is the event that started the run,
  `async` is the new one: `"async.data.orderId == event.data.orderId && async.data.carrier == 'dhl'"`.
- `timeout` is required.
- An event that came a little **before** the wait started still counts: anything
  received after the step before the wait started (or after the run was made, if no
  step came before), up to one hour back.
- One event ends every open wait it matches, in all runs.

### `sendEvent`: send events from a function

Sends one event or a list (up to 100), **once**, even though the function body runs
many times. Use it inside a function instead of `flow.send`. It gives back the new
event IDs. See the `ask-for-review` step above, and the
[fan-out](crons.md#one-run-per-user-on-a-schedule) pattern.

### `invoke`: call another function and use its result

Starts a run of another function, waits for it, and gives back its return value. The
other function can be in another app of the same workspace, in either language.

::: code-group
<<< @/../examples/ts/steps.ts#invoke [TypeScript]
<<< @/../examples/go/steps/main.go#invoke [Go]
:::

- The child's event is `inngest/function.invoked`, with your `data` (up to 1 MB) as
  `event.data`.
- If the child fails or is cancelled, the step fails at once with a `StepError`
  (Go: `*step.StepError`). It is not retried: the child already used its own retries.
- With `timeout`, the step fails with `InvokeTimeout` when it runs out. The child
  keeps running; only the wait stops. Without `timeout`, it waits as long as the
  child takes.
- A function that does not exist fails the step at once with `FunctionNotFound`.
- The child uses its own retries, step timeout, `cancelOn`, concurrency and
  priority. Throttle, singleton, rate limit, debounce, batching and idempotency do
  not apply to it.

## Parallel steps

TypeScript: start the steps without awaiting each one, then `Promise.all`. Go:
`group.Parallel`; each function runs up to its first new step.

::: code-group
<<< @/../examples/ts/steps.ts#parallel [TypeScript]
<<< @/../examples/go/steps/main.go#parallel [Go]
:::

The engine runs each new `run` step in its own call to your app, at the same time.
Give every step its own ID. Sleeps, waits, invokes and sends can be in parallel too.

## The same step in a loop

::: code-group
<<< @/../examples/ts/steps.ts#loop [TypeScript]
<<< @/../examples/go/steps/main.go#loop [Go]
:::

The SDK counts each use of an ID, so the three `import-row` steps are three steps.
Keep the loop over the same list on every call: get the list from the event, or from
a step.

## Cancel a run with an event

`cancelOn` stops a run when a matching event arrives:

::: code-group
<<< @/../examples/ts/steps.ts#cancel [TypeScript]
<<< @/../examples/go/steps/main.go#cancel [Go]
:::

- `match` and `if` work as in `waitForEvent`. `timeout` is optional: after it, the run
  no longer listens. Without it, the run listens as long as it lives.
- Only events that arrive after the run was made count.
- Up to 5 `cancelOn` entries per function.
- A cancelled run ends as **Cancelled**. On a local engine the run above ended with
  `cancelled by event user/deleted (evt_...)`. If a step is running in your app at
  that moment, it finishes, but its result is dropped.
- Failure handlers do not run for cancelled runs.

You can also cancel runs in the dashboard: **Cancel** on a run's page, or **Bulk
actions** on the function's page.

## Expressions

`if`, `key`, `idempotency` and `priority.run` take a small expression, a part of
[CEL](https://cel.dev). The variables are `event` (the event that started the run)
and, in `waitForEvent` and `cancelOn`, `async` (the new event).

```
event.data.plan == 'pro'
event.data.total > 100 && event.data.currency == "EUR"
event.data.country in ['NG', 'GH', 'KE']
has(event.data.coupon) && event.data.coupon.startsWith('VIP')
async.data.orderId == event.data.orderId
```

| You can use | |
| --- | --- |
| Values | numbers, `'text'` or `"text"`, `true`, `false`, `null`, lists `[1, 2]` |
| Fields | `event.data.x`, `event.data["x-y"]`, `event.data.items[0]` |
| Compare | `==` `!=` `<` `<=` `>` `>=` |
| Logic | `&&` `\|\|` `!` and `cond ? a : b` |
| Maths and text | `+ - * / %`, `x in list` |
| Functions | `size(x)`, `has(event.data.x)`, `.startsWith()`, `.endsWith()`, `.contains()`, `.lowerAscii()`, `.upperAscii()`, `.size()` |

- A missing field counts as `null` in `==` and `!=`. Anywhere else a missing field is
  an error. Use `has(...)` first when a field may be absent.
- An `if` that fails when it runs counts as `false`. A `key` that fails is `"null"`,
  so all those events share one key.
- A bad expression is refused when you sync, with a message that names the function:
  `function f: bad trigger if: unexpected character '='`.
- Up to 2048 characters. No regular expressions.

## All function options

| Option (TypeScript) | Go (`flow.FunctionOpts`) | What it does |
| --- | --- | --- |
| `id` | `ID` | Required. The function's ID. |
| `name` | `Name` | A name for the dashboard. |
| `retries` | `Retries` | Retries per step, 0 to 20. Default 4. [Errors and retries](errors.md). |
| `timeouts.step` | `Timeouts.Step` | Longest one call to your app may take. Default 5 minutes, 1 second to 14 minutes. |
| `timeouts.finish` | `Timeouts.Finish` | Longest the whole run may take; then it is cancelled. No limit by default. |
| `cancelOn` | `CancelOn` | [Cancel on an event](#cancel-a-run-with-an-event). |
| `onFailure` | (a second function) | [Runs when a run fails for good](errors.md#when-a-run-fails-for-good). |
| `concurrency` | `Concurrency` | [Limit steps at once](flow-control.md#concurrency). |
| `throttle` | `Throttle` | [Slow down starts](flow-control.md#throttle). |
| `rateLimit` | `RateLimit` | [Drop extra events](flow-control.md#rate-limit). |
| `debounce` | `Debounce` | [Wait for quiet](flow-control.md#debounce). |
| `batchEvents` | `BatchEvents` | [Many events, one run](flow-control.md#batching). |
| `priority` | `Priority` | [Some runs first](flow-control.md#priority). |
| `idempotency` | `Idempotency` | [One run per key](flow-control.md#idempotency). |
| `singleton` | `Singleton` | [One run at a time per key](flow-control.md#singleton). |
