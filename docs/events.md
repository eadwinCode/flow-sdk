# Events

An **event** says that something happened: a user signed up, an order was paid. You
send events to the engine. Every function whose trigger matches the event's name
gets a run.

- [What an event holds](#what-an-event-holds)
- [Send events from your app](#send-events-from-your-app)
- [Send events from inside a function](#send-events-from-inside-a-function)
- [Send events over HTTP](#send-events-over-http)
- [Send an event only once](#send-an-event-only-once)
- [Start a run later](#start-a-run-later)
- [Events the engine sends](#events-the-engine-sends)
- [Limits](#limits)

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

| Field | Required | What it is |
| --- | --- | --- |
| `name` | yes | What happened. 1 to 256 characters. Names starting with `inngest/` are kept for the engine. |
| `data` | no | Any JSON. Your function reads it as `event.data`. Default `{}`. |
| `id` | no | Your own ID, up to 256 characters. Two events with the same `id` are [one event](#send-an-event-only-once). |
| `ts` | no | When it happened, in ms since 1970 (UTC). Default: when the engine got it. A time in the future [starts the run later](#start-a-run-later). |
| `user` | no | Any JSON about who did it. Your function reads it as `event.user`. |

**Naming.** Use `thing/what-happened`, in the past tense: `user/signed-up`,
`order/paid`, `invoice/overdue`. Names are case-sensitive and must match the trigger
exactly.

**Data.** Put in what a function needs to start (IDs, a few fields), not whole
records. The function can load the rest in a step, and gets fresh data that way.

The engine gives every event an ID like `evt_01JB...`. The functions get the event
with that `id`, the `name`, `data`, `ts` and `user`.

## Send events from your app

You need an event key in `FLOW_EVENT_KEY` (see
[getting-started.md](getting-started.md#1-get-your-apps-keys)), and `FLOW_BASE_URL` only if
you run your own engine.

TypeScript: `flow.send` takes one event or a list.

```ts
const { ids } = await flow.send({ name: "order/paid", data: { orderId: "o_123" } });

await flow.send([
  { name: "user/signed-up", data: { userId: "u_1" } },
  { name: "user/signed-up", data: { userId: "u_2" } },
]);
```

On Cloudflare Workers, settings live in the handler's `env`, not in `process.env`,
so pass it: `await flow.send(event, { env })`.

Go: `client.Send` for one event, `client.SendMany` for a list.

```go
id, err := client.Send(ctx, flow.Event{
	Name: "order/paid",
	Data: map[string]any{"orderId": "o_123"},
})
if err != nil {
	return nil, err
}

ids, err := client.SendMany(ctx, []flow.Event{
	{Name: "user/signed-up", Data: map[string]any{"userId": "u_1"}},
	{Name: "user/signed-up", Data: map[string]any{"userId": "u_2"}},
})
if err != nil {
	return nil, err
}
log.Println(id, ids)
```

Both return the IDs the engine gave the events, in order. A request is all or
nothing: if one event is bad, none are sent, and you get an error.

## Send events from inside a function

Inside a function, use `step.sendEvent` (Go: `step.Send`), not `flow.send`. The step
makes sure the events go out once, even though the function body runs many times.

```ts
await step.sendEvent("ask-for-review", {
  name: "review/requested",
  data: { orderId: event.data.orderId },
});
```

```go
_, err := step.Send(ctx, "ask-for-review", flow.Event{
	Name: "review/requested",
	Data: map[string]any{"orderId": in.Event.Data.OrderID},
})
if err != nil {
	return nil, err
}
```

This is also how to split big work: one function sends an event per item, and
another function handles one item per run. Each run then has its own retries.

```ts
const userIds = await step.run("list-users", () => db.listActiveUserIds());
await step.sendEvent(
  "fan-out",
  userIds.map((id: string) => ({ name: "digest/send", data: { userId: id } })),
);
```

Up to 100 events per `sendEvent` call. For more, call it several times with
different step IDs (`fan-out-0`, `fan-out-1`, ...).

## Send events over HTTP

Any service, in any language, can send events with a plain HTTP request.

```bash
curl -X POST https://worker.clevixstudio.com/e \
  -H "Authorization: Bearer $FLOW_EVENT_KEY" \
  -H "Content-Type: application/json" \
  -d '[{"name": "order/paid", "data": {"orderId": "o_123"}}]'
```

- `POST /e` with `Authorization: Bearer <event key>`, or `POST /e/<event key>` when
  you cannot set headers (for example a webhook from another service).
- The body is one event or a list of up to 100.
- Answer: `200 {"ids": ["evt_..."], "status": 200}`.
- Errors: `{"error": "...", "status": ...}` with `400` (bad JSON, bad event),
  `401` (unknown or revoked key) or `413` (too many or too big).

Give each sender its own event key, so you can revoke one without cutting off the
others. A revoked key stops working within about 10 seconds.

## Send an event only once

Networks fail, and senders retry. To make sure a retry does not start a second run,
give the event an `id` that is the same every time you send the same thing, for
example the ID of the payment that it is about:

```ts
await flow.send({ id: `payment-${paymentId}`, name: "order/paid", data: { orderId } });
```

```go
_, err := client.Send(ctx, flow.Event{
	ID:   flow.StrPtr("payment-" + paymentID),
	Name: "order/paid",
	Data: map[string]any{"orderId": orderID},
})
```

Events with the same `id` get the same engine ID, and each function runs only once
for them. This holds as long as the engine keeps that run: while it runs, and about
3 days after it ends (4 days after a failure). `step.sendEvent` events with an `id`
follow the same rule.

To make a function run once per *something in the data* (rather than per event),
use the function's [idempotency](flow-control.md#idempotency) option.

## Start a run later

Set `ts` to a time in the future. The run is created now, in the `queued` state, and
starts at that time.

```ts
const in24h = Date.now() + 24 * 60 * 60 * 1000;
await flow.send({ name: "cart/reminder", data: { cartId }, ts: in24h });
```

```go
_, err := client.Send(ctx, flow.Event{
	Name:      "cart/reminder",
	Data:      map[string]any{"cartId": cartID},
	Timestamp: time.Now().Add(24 * time.Hour).UnixMilli(),
})
```

This does not work for functions with [debounce](flow-control.md#debounce) or
[batching](flow-control.md#batching): they start when their own timer says. A
`cancelOn` on the function already listens while the run waits to start, so you
can still cancel it. For other ways to wait, see [scheduling.md](scheduling.md).

## Events the engine sends

You cannot send names that start with `inngest/`, but your functions can be
triggered by them.

| Name | When | `data` |
| --- | --- | --- |
| `inngest/scheduled.timer` | A cron trigger fires | `cron` (the schedule), `scheduledAt` (ms) |
| `inngest/function.failed` | A run fails for good | `function_id`, `run_id`, `error`, `event` |
| `inngest/function.cancelled` | A run is cancelled (by you, `cancelOn`, a singleton, or `timeouts.finish`) | `function_id`, `run_id`, `event`, and `error` when there is one |
| `inngest/function.invoked` | `step.invoke` starts a run | the `data` you passed |

## Limits

| What | Limit |
| --- | --- |
| Events per request (`flow.send`, `/e`, `sendEvent`) | 100 |
| One event (all its fields, as JSON) | 1 MB |
| One request body | 10 MB |
| `name`, `id` | 256 characters |
