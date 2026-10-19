# Functions and steps

A **function** is code the engine runs for you when an event comes in (or on a
schedule). It is made of **steps**. The engine saves the result of each step, so if
something fails, only the failed step is tried again, and a run can pause for days.

New here? Start with [getting-started.md](getting-started.md).

- [Define a function](#define-a-function)
- [Triggers](#triggers)
- [What the handler gets](#what-the-handler-gets)
- [How a run works (replay)](#how-a-run-works-replay)
- [Steps](#steps): run, sleep, sleepUntil, waitForEvent, sendEvent, invoke
- [Parallel steps](#parallel-steps)
- [Errors and retries](#errors-and-retries)
- [Cancel a run with an event](#cancel-a-run-with-an-event)
- [When a function fails for good](#when-a-function-fails-for-good)
- [All function options](#all-function-options)

## Define a function

TypeScript: `flow.createFunction(options, trigger, handler)`.

```ts
import { Flow } from "@clevix/flow";

const flow = new Flow({ id: "shop" });

export const sendReceipt = flow.createFunction(
  { id: "send-receipt", name: "Send receipt", retries: 3 },
  { event: "order/paid" },
  async ({ event, step }) => {
    const order = await step.run("load-order", () => db.getOrder(event.data.orderId));
    await step.run("email", () => mailer.send(order.email, "Thanks for your order"));
    return { orderId: order.id };
  },
);
```

Go: `flow.CreateFunction(client, opts, trigger, handler)`. The type parameter (here
`OrderPaid`) is the shape of the event's `data`.

```go
type OrderPaid struct {
	OrderID string `json:"orderId"`
}

sendReceipt, err := flow.CreateFunction(client,
	flow.FunctionOpts{ID: "send-receipt", Name: "Send receipt", Retries: flow.IntPtr(3)},
	flow.EventTrigger("order/paid", nil),
	func(ctx context.Context, in flow.Input[OrderPaid]) (any, error) {
		email, err := step.Run(ctx, "load-order", func(ctx context.Context) (string, error) {
			return db.OrderEmail(ctx, in.Event.Data.OrderID)
		})
		if err != nil {
			return nil, err
		}
		_, err = step.Run(ctx, "email", func(ctx context.Context) (bool, error) {
			return true, mailer.Send(ctx, email, "Thanks for your order")
		})
		if err != nil {
			return nil, err
		}
		return map[string]string{"orderId": in.Event.Data.OrderID}, nil
	},
)
if err != nil {
	log.Fatal(err) // a bad ID or option: fix the code
}
```

Then serve it: list it in `serve({ client: flow, functions: [sendReceipt] })` in
TypeScript. In Go, `CreateFunction` adds it to the client, and `client.Serve()`
serves every function on the client. Sync after deploy, and the engine knows it.

**IDs.** The function ID (`send-receipt`) and the app ID use letters, digits, `-`
and `_`, up to 64 characters. The engine knows the function as
`<appId>-<functionId>`, here `shop-send-receipt`. Do not rename a function that has
runs in progress: a new ID is a new function, and the old one is archived on the
next sync.

**Options apply to new runs.** When you change a function's options and sync, runs
that already started keep the old retries, timeout, `cancelOn` and flow control.

**Check option names.** The engine keeps options it does not know without an
error, so a typo like `retry: 3` is silently ignored. In TypeScript the types catch
this; in Go the struct fields do.

**The return value** is the run's output. It is saved as JSON and shown in the
dashboard. `step.invoke` in another function gets it back.

## Triggers

A trigger says what starts a function. A function can have more than one.

| Trigger | TypeScript | Go |
| --- | --- | --- |
| An event | `{ event: "order/paid" }` | `flow.EventTrigger("order/paid", nil)` |
| An event, only some | `{ event: "order/paid", if: "event.data.total > 100" }` | `flow.EventTrigger("order/paid", flow.StrPtr("event.data.total > 100"))` |
| A schedule | `{ cron: "0 9 * * MON" }` | `flow.CronTrigger("0 9 * * MON")` |
| Several | `[{ event: "a/one" }, { event: "a/two" }]` | `flow.MultipleTriggers{flow.EventTrigger("a/one", nil), flow.EventTrigger("a/two", nil)}` |

Every function whose trigger matches gets its own run: one event can start many
functions. `if` is an expression over `event`; see [expressions](#expressions).
Cron schedules are covered in [scheduling.md](scheduling.md).

## What the handler gets

| | TypeScript (`ctx`) | Go (`in flow.Input[T]`) |
| --- | --- | --- |
| The event that started the run | `event` | `in.Event` |
| All events (more than one only with [batching](flow-control.md#batching)) | `events` | `in.Events` |
| The run's ID | `runId` | `in.InputCtx.RunID` |
| Attempt of the current step, from 0 | `attempt` | `in.InputCtx.Attempt` |
| Step tools | `step` | the `step` package, with `ctx` |

An event has `id`, `name`, `data`, `ts` (ms since epoch) and an optional `user`. See
[events.md](events.md).

## How a run works (replay)

This is the one idea to understand before you write steps.

The engine does not keep your code running between steps. Each time it needs
something done, it calls your endpoint, and your function **runs again from the
top**. Steps that already finished do not run again: they return their saved
result at once. When the function reaches a step that has not run yet, the SDK
runs it (or tells the engine to sleep or wait), reports back, and stops. The engine
saves the result and calls again for the next step.

What this means for your code:

1. **Put side effects in steps.** Code outside a step runs on every call. A payment
   made outside a step can happen many times.
2. **Step IDs must not change** between calls or deploys. The engine finds saved
   results by ID. Using the same ID twice in one run (in a loop) is fine: the SDK
   counts them.
3. **Keep the order of steps the same** for the same input. Do not choose steps
   based on the time, random numbers or anything else that changes between calls,
   unless you got that value from a step.
4. **Step results must be JSON.** Return plain data: objects, arrays, strings,
   numbers. A `Date` comes back as a string; a class comes back as a plain object.
5. **Do not catch the SDK's control flow.** In TypeScript, if you wrap step calls in
   `try/catch`, catch only real errors (see [Errors and retries](#errors-and-retries)).
   In Go, if you `recover()` around step calls, call `step.Repanic(r)` first.
6. **Go:** do not call steps from goroutines you start. Use `group.Parallel`.
7. **Up to 1000 steps per run**, and step IDs up to 256 characters. For more work,
   split it: for example, one run per item with `sendEvent`.

## Steps

### `run`: do some work, once

Runs your callback, saves what it returns, and gives the saved value back on every
later call. If the callback throws (TypeScript) or returns an error (Go), the step
fails and the engine retries it.

```ts
const charge = await step.run("charge-card", async ({ idempotencyKey, attempt }) => {
  // idempotencyKey is the same on every attempt of this step: give it to the
  // payment API so a retry never charges twice.
  return payments.charge(event.data.orderId, { idempotencyKey });
});
```

```go
chargeID, err := step.Run(ctx, "charge-card", func(ctx context.Context) (string, error) {
	// Same on every attempt of this step: give it to the payment API.
	key := step.IdempotencyKey(ctx)
	return payments.Charge(ctx, in.Event.Data.OrderID, key)
})
if err != nil {
	return nil, err
}
```

A step can run more than once: if your app crashes after the work is done but
before the result is saved, the engine tries again. So make steps safe to repeat,
for example with the idempotency key.

### `sleep` and `sleepUntil`: pause the run

The run stops and the engine wakes it later. Nothing runs while it sleeps, so a
sleep of a week costs nothing.

```ts
await step.sleep("wait-3-days", "3d");            // "30s", "5m", "2h", "1h30m", "7d", or ms
await step.sleepUntil("wait-for-launch", "2026-12-01T09:00:00Z"); // Date, ms, or ISO string
```

```go
if err := step.Sleep(ctx, "wait-3-days", 72*time.Hour); err != nil {
	return nil, err
}
launch := time.Date(2026, 12, 1, 9, 0, 0, 0, time.UTC)
if err := step.SleepUntil(ctx, "wait-for-launch", launch); err != nil {
	return nil, err
}
```

### `waitForEvent`: wait for something to happen

Pauses until a matching event arrives, or until the timeout. It returns the event,
or `null` (TypeScript) / `step.ErrEventNotReceived` (Go) on timeout.

```ts
const shipped = await step.waitForEvent("wait-shipped", {
  event: "order/shipped",
  match: "data.orderId", // the new event's data.orderId must equal this run's
  timeout: "14d",
});
if (!shipped) {
  await step.run("alert-support", () => support.alert(event.data.orderId));
}
```

```go
shipped, err := step.WaitForEvent[flow.GenericEvent[OrderPaid]](ctx, "wait-shipped", step.WaitForEventOpts{
	Event:   "order/shipped",
	Match:   flow.StrPtr("data.orderId"),
	Timeout: 14 * 24 * time.Hour,
})
if errors.Is(err, step.ErrEventNotReceived) {
	// timed out
} else if err != nil {
	return nil, err
} else {
	log.Println("shipped:", shipped.ID)
}
```

- `match` is a field path. The wait matches when that field is equal in the event
  that started this run and in the new event.
- `if` is an expression for anything more complex. `event` is the event that
  started the run, `async` is the new event. For example
  `"async.data.orderId == event.data.orderId && async.data.carrier == 'dhl'"`.
- `timeout` is required.

- An event that came **a little before** the wait started still counts: anything
  received after the step before the wait began, but no more than one hour back.
  So you do not lose an event that was sent while your function was busy.
- One event ends every open wait it matches, in all runs.

### `sendEvent`: send events from a function

Sends one or more events, once. Use it rather than `flow.send` inside a function,
so a replay does not send them again.

```ts
await step.sendEvent("notify", [
  { name: "invoice/created", data: { invoiceId } },
  { name: "audit/log", data: { action: "invoice", invoiceId } },
]);
```

```go
ids, err := step.Send(ctx, "notify",
	flow.Event{Name: "invoice/created", Data: map[string]any{"invoiceId": invoiceID}},
	flow.Event{Name: "audit/log", Data: map[string]any{"action": "invoice", "invoiceId": invoiceID}},
)
if err != nil {
	return nil, err
}
```

It returns the new event IDs.

### `invoke`: call another function and use its result

Starts a run of another function, waits for it to finish, and returns its output.
The other function can be in another app, written in either language.

```ts
const report = await step.invoke("build-report", {
  function: buildReport,              // a function from this app
  // or a full ID: function: "reports-build-report"
  data: { month: "2026-09" },          // becomes the child's event.data
  timeout: "1h",                       // optional
});
```

```go
report, err := step.Invoke[map[string]any](ctx, "build-report", step.InvokeOpts{
	FunctionID: "reports-build-report", // "<appId>-<functionId>", or buildReport.FullyQualifiedID()
	Data:       map[string]any{"month": "2026-09"},
	Timeout:    time.Hour, // optional
})
if err != nil {
	return nil, err
}
```

If the child fails, `invoke` throws a `StepError` (TypeScript) or returns a
`*step.StepError` (Go). If the timeout runs out first, it fails with
`InvokeTimeout`. 

More about `invoke`:

- If the function does not exist (or was removed), the step fails at once with
  `FunctionNotFound`.
- Without `timeout`, it waits as long as the child takes. When `timeout` runs out,
  the child keeps running; only the wait stops.
- A failed or cancelled child fails the step at once. The step is not retried: the
  child already used its own retries.
- The child gets the event `inngest/function.invoked` with your `data` (up to 1 MB)
  as `event.data`. It uses its own retries, step timeout, `cancelOn` and
  concurrency. Throttle, singleton, rate limit, debounce, batching and idempotency
  do not apply to it.

## Parallel steps

TypeScript: start steps without awaiting each one, then `Promise.all`.

```ts
const [user, orders] = await Promise.all([
  step.run("load-user", () => db.getUser(event.data.userId)),
  step.run("load-orders", () => db.getOrders(event.data.userId)),
]);
```

Go: `group.Parallel`. Each function runs until its first new step.

```go
results := group.Parallel(ctx,
	func(ctx context.Context) (any, error) {
		return step.Run(ctx, "load-user", func(ctx context.Context) (string, error) {
			return db.UserName(ctx, userID)
		})
	},
	func(ctx context.Context) (any, error) {
		return step.Run(ctx, "load-orders", func(ctx context.Context) (int, error) {
			return db.OrderCount(ctx, userID)
		})
	},
)
if err := results.AnyError(); err != nil {
	return nil, err
}
name, count := results[0].Value.(string), results[1].Value.(int)
```

The engine runs each new `run` step in its own call to your app, at the same time.
Give every step its own ID. Sleeps, waits, invokes and sends can be in parallel too.

## Errors and retries

**A step that fails is retried.** Each step gets `retries + 1` attempts (the
function's `retries` option, default 4, max 20). The engine waits longer
between each attempt: about 1 s, then 2 s, 4 s, 8 s and so on, doubling up to 1 hour, with some randomness so that many failing runs do not retry at the same moment. Other steps are not affected: finished steps keep
their results.

**An error outside a step** (in the function body) fails that call. The engine
retries it the same way.

**When a step runs out of attempts**, the error comes back into your function: the
step call throws a `StepError` (TypeScript) or returns a `*step.StepError` (Go). If
you do not catch it, the run fails. If you catch it, you can undo earlier work:

```ts
import { StepError } from "@clevix/flow";

const hold = await step.run("hold-seat", () => seats.hold(event.data.seatId));
try {
  await step.run("charge", () => payments.charge(event.data.orderId));
} catch (err) {
  if (!(err instanceof StepError)) throw err; // let anything else through
  await step.run("release-seat", () => seats.release(hold.id));
  return { status: "payment-failed" };
}
```

```go
if _, err := step.Run(ctx, "charge", func(ctx context.Context) (string, error) {
	return payments.Charge(ctx, in.Event.Data.OrderID, step.IdempotencyKey(ctx))
}); err != nil {
	var se *step.StepError
	if !errors.As(err, &se) {
		return nil, err
	}
	if _, err := step.Run(ctx, "release-seat", func(ctx context.Context) (bool, error) {
		return true, seats.Release(ctx, in.Event.Data.OrderID)
	}); err != nil {
		return nil, err
	}
	return map[string]string{"status": "payment-failed"}, nil
}
```

**Stop retrying** when trying again cannot help (bad input, a record that does not
exist):

```ts
import { NonRetriableError } from "@clevix/flow";

throw new NonRetriableError("no such user"); // in a step: fails the step now; outside: fails the run
```

```go
return "", flow.NoRetryError(errors.New("no such user"))
```

**Retry at a given time**, for example when an API tells you when to come back:

```ts
import { RetryAfterError } from "@clevix/flow";

throw new RetryAfterError("rate limited", "30s"); // or a Date, or ms since epoch
```

```go
return "", flow.RetryAtError(errors.New("rate limited"), time.Now().Add(30*time.Second))
```

**Step timeout.** `timeouts: { step: "2m" }` (Go: `Timeouts: &flow.Timeouts{Step: 2 * time.Minute}`)
limits how long one call to your app may take. The default is 5 minutes. Any value is kept between 1 second and 14 minutes. A
call that takes longer fails with `TimeoutError` and is retried like any other
error. For longer work, split it into several steps.

**Run timeout.** `timeouts: { finish: "15m" }` (Go: `Timeouts: &flow.Timeouts{Finish: 15 * time.Minute}`)
limits how long the whole run may take, counted from its first call to your app. Time
spent queued, scheduled or waiting for a concurrency slot does not count. A run still
going then is **cancelled** with the error `FunctionTimeout`, and the engine sends
`inngest/function.cancelled`. A step that is running finishes, but its result is
dropped. There is no limit by default. Not applied while the run is paused.

In Go, a panic inside a `step.Run` callback counts as a failed attempt, named
`Panic`.

## Cancel a run with an event

`cancelOn` stops a run when a matching event arrives. For example, stop the
onboarding emails when the user deletes their account:

```ts
flow.createFunction(
  {
    id: "onboarding",
    cancelOn: [{ event: "user/deleted", match: "data.userId", timeout: "30d" }],
  },
  { event: "user/signed-up" },
  async ({ step }) => { /* ... */ },
);
```

```go
flow.FunctionOpts{
	ID: "onboarding",
	CancelOn: []flow.CancelOn{{
		Event:   "user/deleted",
		Match:   flow.StrPtr("data.userId"),
		Timeout: 30 * 24 * time.Hour,
	}},
}
```

`match` and `if` work as in `waitForEvent`. `timeout` is optional: after it, the
run no longer listens. 

- Only events that arrive after the run was created count.
- Without `timeout`, the run listens as long as it lives (up to 366 days).
- Up to 5 `cancelOn` entries per function.
- A cancelled run ends with the status `cancelled`. If a step is running in your
  app at that moment, it finishes, but its result is thrown away.
- `onFailure` does **not** run for cancelled runs.

You can also cancel runs by hand in the dashboard: one run from its page, or many at
once from the function's page.

## When a function fails for good

TypeScript: `onFailure` runs after a run fails for good (all retries used, or a
`NonRetriableError`).

```ts
flow.createFunction(
  {
    id: "import-users",
    onFailure: async ({ error, event, step }) => {
      // event.data.event is the event that started the failed run.
      await step.run("alert", () => slack.post(`import failed: ${error.message}`));
    },
  },
  { event: "import/requested" },
  async ({ event, step }) => { /* ... */ },
);
```

It is a separate function with the ID `<id>-failure` (here `import-users-failure`),
started by the event `inngest/function.failed`.

Go has no `onFailure` option. Make that function yourself:

```go
type Failed struct {
	FunctionID string         `json:"function_id"`
	RunID      string         `json:"run_id"`
	Error      map[string]any `json:"error"`
	Event      map[string]any `json:"event"`
}

flow.CreateFunction(client,
	flow.FunctionOpts{ID: "import-users-failure"},
	flow.EventTrigger("inngest/function.failed",
		flow.StrPtr("event.data.function_id == 'shop-import-users'")),
	func(ctx context.Context, in flow.Input[Failed]) (any, error) {
		return step.Run(ctx, "alert", func(ctx context.Context) (bool, error) {
			return true, slack.Post(ctx, "import failed: "+in.Event.Data.RunID)
		})
	},
)
```

The event's data has `function_id` (`<appId>-<functionId>`), `run_id`, `error`
(`name`, `message`, `stack`) and `event` (the event that started the failed run).


It runs only when a run ends `failed`, never when it is `cancelled`. Runs started
by `step.invoke` count too.

To act when a run is **cancelled**, trigger a function on `inngest/function.cancelled`
the same way (same data; `error` is there when the cancel had a reason, such as
`FunctionTimeout`). Needs an engine that sends it.

## Expressions

`if`, `key` and a few other options take a small expression. The variables are
`event` (the event that started the run) and, in `waitForEvent` and `cancelOn`,
`async` (the new event). 

They are a small part of [CEL](https://cel.dev). For example:

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
| Compare | `==` `!=` (exact, no type changes: `1 == '1'` is false), `<` `<=` `>` `>=` (numbers with numbers, text with text) |
| Logic | `&&` `\|\|` `!` and `cond ? a : b` |
| Maths and text | `+ - * / %` (`+` also joins text and lists), `x in list`, `'key' in map` |
| Functions | `size(x)`, `has(event.data.x)`, `.startsWith()`, `.endsWith()`, `.contains()`, `.lowerAscii()`, `.upperAscii()`, `.size()` |

Good to know:

- Which variables you can use: `event` everywhere; `async` only in `waitForEvent`
  and `cancelOn`. Any other name is an error.
- A field that is missing counts as `null` in `==` and `!=`. Anywhere else, a missing
  field makes the expression fail. Use `has(...)` first when a field may be absent.
- When an `if` fails at run time, it counts as `false`. When a `key` fails, its
  value is `"null"`, so all those events share one key.
- A bad expression (bad syntax, unknown function, unknown variable) is rejected
  when you sync, with a message that names the function.
- Up to 2048 characters. No regular expressions.

## All function options

| Option (TypeScript) | Go (`flow.FunctionOpts`) | What it does |
| --- | --- | --- |
| `id` | `ID` | Required. The function's ID. |
| `name` | `Name` | A name for the dashboard. |
| `retries` | `Retries` | Retries per step. Default 4, max 20. |
| `timeouts.step` | `Timeouts.Step` | Longest one call to your app may take. |
| `timeouts.finish` | `Timeouts.Finish` | Longest the whole run may take; then it is cancelled. |
| `cancelOn` | `CancelOn` | [Cancel on an event](#cancel-a-run-with-an-event). |
| `onFailure` | (a second function) | [Runs when it fails for good](#when-a-function-fails-for-good). |
| `concurrency` | `Concurrency` | [Limit runs at once](flow-control.md#concurrency). |
| `throttle` | `Throttle` | [Slow down starts](flow-control.md#throttle). |
| `rateLimit` | `RateLimit` | [Drop extra events](flow-control.md#rate-limit). |
| `debounce` | `Debounce` | [Wait for quiet](flow-control.md#debounce). |
| `batchEvents` | `BatchEvents` | [Many events, one run](flow-control.md#batching). |
| `priority` | `Priority` | [Run some first](flow-control.md#priority). |
| `idempotency` | `Idempotency` | [One run per key](flow-control.md#idempotency). |
| `singleton` | `Singleton` | [One run at a time per key](flow-control.md#singleton). |
