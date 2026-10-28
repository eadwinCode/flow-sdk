# Events

An **event** says that something happened: a user signed up, an order was paid. You
send events to the engine. Every function whose trigger matches the event's name
gets a run.

The sending code on this page is in
[`examples/ts/send-events.ts`](https://github.com/eadwinCode/flow-sdk/blob/main/examples/ts/send-events.ts)
and [`examples/go/events/main.go`](https://github.com/eadwinCode/flow-sdk/blob/main/examples/go/events/main.go).
Both are small scripts, not servers.

## What an event holds

```json
{
  "name": "order/paid",
  "data": { "orderId": "o_123", "total": 4200 },
  "id": "payment-pi_3Nx",
  "ts": 1792400000000,
  "user": { "id": "u_42" }
}
```

| Field | Needed | What it is |
| --- | --- | --- |
| `name` | yes | What happened. 1 to 256 characters. Names starting with `inngest/` are kept for the engine. |
| `data` | no | Any JSON. Your function reads it as `event.data`. Default `{}`. |
| `id` | no | Your own ID, up to 256 characters. Two events with the same `id` are [one event](#send-an-event-only-once). |
| `ts` | no | When it happened, in ms since 1970. Default: when the engine got it. A time in the future [starts the runs later](#start-the-runs-later). |
| `user` | no | Any JSON about who did it. Your function reads it as `event.user`. |

The engine gives every event an ID, like `evt_01M5WT35Z8M2KWAATH0ECRJSKW`. Your
function gets the event with that ID, the `name`, `data`, `ts` and `user`.

**Names.** Use `thing/what-happened`, in the past tense: `user/signed-up`,
`order/paid`. Names are case-sensitive and must match the trigger exactly.

**Data.** Put in what a function needs to start (IDs, a few fields), not whole
records. The function can load the rest in a step, and gets fresh data that way.

## Send events from your app

You need an event key in `FLOW_EVENT_KEY`. Make one in the dashboard: **Add app**
makes one for the app, and the **Keys** page makes more.

::: code-group
<<< @/../examples/ts/send-events.ts#one [TypeScript]
<<< @/../examples/go/events/main.go#one [Go]
:::

Up to 100 events in one request:

::: code-group
<<< @/../examples/ts/send-events.ts#many [TypeScript]
<<< @/../examples/go/events/main.go#many [Go]
:::

Both give back the IDs the engine gave the events, in order. A request is all or
nothing: if one event is bad, none are taken, and you get an error with the engine's
answer:

::: code-group
<<< @/../examples/ts/send-events.ts#error [TypeScript]
<<< @/../examples/go/events/main.go#error [Go]
:::

```
refused: sending events failed (400): event name inngest/anything is reserved
```

The SDK does not retry a failed send. If it matters, retry it yourself, with the
same `id` (below).

**On Cloudflare Workers**, settings live in the handler's `env`, not in
`process.env`. Pass it: `await flow.send(event, { env })`.

## Send an event only once

Networks fail and senders retry. To make sure a retry does not start a second run,
give the event an `id` that is the same every time you send the same thing, for
example the ID of the payment it is about:

::: code-group
<<< @/../examples/ts/send-events.ts#once [TypeScript]
<<< @/../examples/go/events/main.go#once [Go]
:::

Both sends gave back the same event ID:

```
sent twice: evt_8XWXAS18Q0H46SM5WPFWYT7CH0 evt_8XWXAS18Q0H46SM5WPFWYT7CH0
```

Each function runs once for that event ID. This holds while the engine keeps that
run: while it runs, and 3 days after it ends (4 days after it failed). The same `id`
in another workspace is another event. Events sent with `step.sendEvent` follow the
same rule.

A function with `debounce` or `batchEvents` handles a repeat its own way.
`debounce` takes it as a new event: it pushes the start back, and once the run has
started, a repeat starts a new wait. `batchEvents` skips a repeat that is in a batch
now, or was in one up to 1 hour ago.

To run a function once per *value in the data* (one run per order, whatever the
event), use the function's [idempotency](flow-control.md#idempotency) option instead.

## Start the runs later

Set `ts` to a time in the future. The engine makes the runs now, as **Queued**, and
starts them at that time.

::: code-group
<<< @/../examples/ts/send-events.ts#later [TypeScript]
<<< @/../examples/go/events/main.go#later [Go]
:::

There is no upper limit on `ts`. [Singleton](flow-control.md#singleton) and
[throttle](flow-control.md#throttle) are applied when the event arrives, not at `ts`.

This does not work for functions with [debounce](flow-control.md#debounce) or
[batching](flow-control.md#batching). See [Crons and scheduled jobs](crons.md) for all
the ways to wait.

## Send events from inside a function

Inside a function, use `step.sendEvent` (Go: `step.Send`), not `flow.send`. The step
sends the events once, even though the function body runs many times. See
[Functions and steps](functions.md#sendevent-send-events-from-a-function).

## Send events over HTTP

Any program can send events with `POST /e` and the event key. See
[Webhooks and events](webhooks.md#send-events-from-anywhere-over-http) and the
[HTTP API](http-api.md#post-e-send-events).

## Events the engine sends

Names that start with `inngest/` belong to the engine: `inngest/scheduled.timer`,
`inngest/function.failed`, `inngest/function.cancelled` and
`inngest/function.invoked`. You can not send them. Your functions can be triggered
by `inngest/function.failed` and `inngest/function.cancelled`. The other two are only
the first event of a cron run or an invoked run: a trigger on them starts nothing.
See [the table](webhooks.md#events-the-engine-sends).

## Limits

| What | Limit |
| --- | --- |
| Events per request (`flow.send`, `POST /e`, `step.sendEvent`) | 100 |
| One event (all its fields, as JSON) | 1 MB |
| One request body | 10 MB |
| `name`, `id` | 256 characters |
| How long events are kept (for the dashboard) | 4 days |
