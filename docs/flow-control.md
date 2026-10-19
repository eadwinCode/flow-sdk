# Flow control

Options that decide **when** and **how many** runs go. You set them on the function;
the engine does the rest.

| Problem | Option | What happens to extra work |
| --- | --- | --- |
| An outside API allows only N calls at once | [`concurrency`](#concurrency) | waits |
| Start at most N runs per minute, smoothly | [`throttle`](#throttle) | waits |
| Start at most N runs per hour, drop the rest | [`rateLimit`](#rate-limit) | **dropped** |
| Many events in a burst, only the last one matters | [`debounce`](#debounce) | replaced by the newest |
| Handle events in groups (bulk insert, one email for many) | [`batchEvents`](#batching) | grouped |
| Some runs should go first | [`priority`](#priority) | reordered |
| One run per order ID, whatever happens | [`idempotency`](#idempotency) | ignored |
| Only one run per user at a time | [`singleton`](#singleton) | skipped, or the old run cancelled |

Most options take a **`key`**: an [expression](functions.md#expressions) over `event`,
like `"event.data.accountId"`. With a key, the limit counts each value apart: "5 at
once **per account**" instead of "5 at once in all".

Durations: in TypeScript text like `"30s"`, `"1m"`, `"24h"`; in Go a `time.Duration`.

Options are checked when you sync. A bad value is rejected with a message such as
`function <id>: throttle period must be between 1s and 168h`.

## Concurrency

Limits how many **steps** of the function run at the same time.

```ts
flow.createFunction(
  {
    id: "sync-crm",
    concurrency: { limit: 5, key: "event.data.accountId" }, // 5 at once per account
  },
  { event: "crm/sync" },
  async ({ event, step }) => { /* ... */ },
);
```

```go
flow.FunctionOpts{
	ID: "sync-crm",
	Concurrency: []flow.Concurrency{
		{Limit: 5, Key: flow.StrPtr("event.data.accountId")}, // 5 at once per account
	},
}
```

- **Steps, not runs.** The limit counts calls to your app that are in progress. A
  run that is sleeping or waiting for an event holds no slot. So 1,000 runs can be
  "in progress" with `limit: 5`; only 5 do work at any moment.
- When the limit is full, new work waits in line (see [priority](#priority)). Nothing
  is dropped.
- `concurrency: 5` (TypeScript) is short for `{ limit: 5 }`. A `limit` of `0` means
  no limit.
- Up to **2** limits, for example 100 in all and 5 per account:
  `concurrency: [{ limit: 100 }, { limit: 5, key: "event.data.accountId" }]`.
- **Share a limit between functions** with `scope: "account"` and a `key`. Every
  function that uses the same key expression and gets the same value shares one
  line. If they set different limits, the lowest one wins. Good for "our whole
  system may call this partner API 10 times at once". (`scope: "env"` means the same
  as `"account"`.)
- If your app dies in the middle of a step, its slot is freed after the step timeout
  plus 2 minutes.

## Throttle

Starts at most `limit` runs per `period`, spread out evenly. Extra runs **wait**;
none are lost.

```ts
throttle: { limit: 60, period: "1m", burst: 10, key: "event.data.userId" },
```

```go
Throttle: &flow.Throttle{Limit: 60, Period: time.Minute, Burst: 10, Key: flow.StrPtr("event.data.userId")},
```

- With `limit: 60, period: "1m"`, a run can start every second. `burst` lets that
  many more start at once after a quiet time (default 0).
- Throttle acts when a run **starts**. After that, the run's steps are not slowed.
  To limit work in progress, use `concurrency`.
- Limits: `limit` 1 to 100,000; `period` 1 second to 7 days.
- Applies to runs from events, cron, debounce and batches. Not to `step.invoke`.

## Rate limit

Starts at most `limit` runs per `period`. Extra events are **dropped**: no run, no
error to the sender, only a line in the engine's log.

```ts
rateLimit: { limit: 1, period: "4h", key: "event.data.userId" }, // at most one alert per user every 4 hours
```

```go
RateLimit: &flow.RateLimit{Limit: 1, Period: 4 * time.Hour, Key: flow.StrPtr("event.data.userId")},
```

- Use it when extra work is truly not wanted (alerts, notifications). When the work
  must happen, use `throttle`.
- Limits: `limit` 1 to 100,000; `period` 1 second to 7 days.
- Applies only to runs started by events. Not to cron or `step.invoke`.

## Debounce

Waits until the events stop for `period`, then starts **one** run with the **last**
event.

```ts
debounce: { period: "5m", key: "event.data.documentId", timeout: "30m" },
```

```go
Debounce: &flow.Debounce{Period: 5 * time.Minute, Key: flow.StrPtr("event.data.documentId"), Timeout: 30 * time.Minute},
```

Example: a user edits a document many times; index it once, 5 minutes after the
last edit.

- Each new event pushes the start back by `period`.
- `timeout` caps the total wait: the run starts at the latest `timeout` after the
  **first** event, even if events keep coming. Without it, a steady stream of
  events could put the run off forever.
- Limits: `period` and `timeout` 1 second to 7 days.
- If the function is paused when the run would start, the event is dropped.
- Debounce ignores `idempotency`, and a future `ts` on the event.
- Cannot be used with `batchEvents`.

## Batching

Collects events and starts **one** run with many of them.

```ts
flow.createFunction(
  { id: "save-clicks", batchEvents: { maxSize: 100, timeout: "10s", key: "event.data.siteId" } },
  { event: "page/clicked" },
  async ({ events, step }) => {
    await step.run("insert", () => db.insertClicks(events.map((e) => e.data)));
    return { saved: events.length };
  },
);
```

```go
_, err := flow.CreateFunction(client,
	flow.FunctionOpts{
		ID:          "save-clicks",
		BatchEvents: &flow.BatchEvents{MaxSize: 100, Timeout: 10 * time.Second, Key: flow.StrPtr("event.data.siteId")},
	},
	flow.EventTrigger("page/clicked", nil),
	func(ctx context.Context, in flow.Input[map[string]any]) (any, error) {
		log.Printf("got %d events", len(in.Events))
		return len(in.Events), nil
	},
)
if err != nil {
	log.Fatal(err)
}
```

- The run starts when the batch has `maxSize` events, or `timeout` after its
  **oldest** event, or when its events add up to 4 MB, whichever comes first.
- The function reads them all in `events` (Go: `in.Events`). `event` is the first.
- `if` (optional) picks which events go into batches. An event that does not match
  starts its own run at once, alone.
- The same event (same ID) is not added twice.
- Limits: `maxSize` 1 to 100; `timeout` 1 second to 1 hour.
- Batching ignores `idempotency`. `rateLimit` still drops events before they reach
  a batch, and the batch run starts like any run, so `singleton`, `throttle` and
  `concurrency` apply to it.
- Cannot be used with `debounce`.

## Priority

Lets some runs jump the line when they wait for a [concurrency](#concurrency) slot.

```ts
concurrency: 10,
priority: { run: "event.data.plan == 'enterprise' ? 120 : 0" },
```

```go
Concurrency: []flow.Concurrency{{Limit: 10}},
Priority:    &flow.Priority{Run: flow.StrPtr("event.data.plan == 'enterprise' ? 120 : 0")},
```

- `run` is an expression that gives a number of **seconds**, from -600 to 600.
  `120` means "treat this as if it had been waiting 2 minutes longer". Negative
  numbers push a run back.
- It only changes the order of work **waiting for a concurrency slot**. Without a
  concurrency limit, nothing waits, and priority does nothing.
- If the expression fails or does not give a number, the priority is 0.

## Idempotency

At most one run per value of an expression.

```ts
idempotency: "event.data.orderId", // one run per order, however many events
```

```go
Idempotency: flow.StrPtr("event.data.orderId"),
```

- Events with a value already seen get no new run. This holds as long as the engine
  keeps the first run: while it runs, and about 3 days after it ends (4 days after a
  failure).
- To build the value from several fields, use an expression:
  `"event.data.userId + '-' + event.data.day"`.
- If the expression fails (for example a missing field), the value is `"null"`, and
  all those events share **one** run. Make sure the field is always there.
- Applies only to runs started by events, and not with `debounce` or `batchEvents`.
- To drop a repeated *event* (the same thing sent twice), you can also give the
  event an [`id`](events.md#send-an-event-only-once).

## Singleton

Only one active run at a time, in all or per key.

```ts
singleton: { key: "event.data.userId", mode: "skip" },
```

```go
Singleton: &flow.Singleton{Key: flow.StrPtr("event.data.userId"), Mode: "skip"},
```

- `mode: "skip"`: while a run is active, new events start no run.
- `mode: "cancel"`: the active run is cancelled, and the new one starts. Good for
  "only the newest request matters".
- A run counts as active until it ends (`completed`, `failed`, `cancelled`), also
  while it sleeps or waits.
- Applies to runs from events and cron. Not to `step.invoke`.

## How they work together

For each event, the engine goes in this order:

1. The trigger's `if`. No match: no run.
2. `idempotency` gives the run its ID. A repeat ends here.
3. `rateLimit` may drop the event.
4. `debounce` or `batchEvents` hold the event; their run continues at step 5 later.
5. `singleton` may skip (or cancel the old run).
6. `throttle` may delay the start.
7. While it runs, `concurrency` and `priority` decide which steps go next.

You can combine any of them, except `debounce` with `batchEvents`.

What applies to which kind of run:

| | Event | Cron | `step.invoke` child |
| --- | --- | --- | --- |
| `concurrency`, `priority` | yes | yes | yes |
| `throttle`, `singleton` | yes | yes | no |
| `rateLimit`, `debounce`, `batchEvents`, `idempotency` | yes | no | no |

Runs keep the flow control they started with. If you change these options and
sync, only new runs use the new values.
