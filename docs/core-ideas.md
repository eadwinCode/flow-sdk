# Core ideas

These are the words the rest of the docs use. Each one has a short example. Read
them in order: each builds on the one before.

## Workspace

A **workspace** is your team's space on the engine. It holds your apps, keys, runs
and events. Nothing in one workspace can see another. You make one when you sign up
in the dashboard.

## App

An **app** is one of your programs that uses the SDK: a server, or a Cloudflare
Worker. It has an **app ID** that you pick, for example `shop`, and that you never
change. The app serves one endpoint that the engine calls.

```ts
const flow = new Flow({ id: "shop" }); // TypeScript
```

```go
client, err := flow.NewClient(flow.ClientOpts{AppID: "shop"}) // Go
```

## Event

An **event** is a small JSON message that says something happened. It has a
**name**, like `user/signed-up`, and **data**: any JSON you want.

```json
{ "name": "user/signed-up", "data": { "userId": "u_123" } }
```

You send events to the engine: from your app with the SDK, or from anywhere with an
HTTP request. The engine gives each event an ID. [Events](events.md) has all of it.

## Event key

An **event key** lets a sender send events to your workspace. It is a secret. The
SDK reads it from the env var `FLOW_EVENT_KEY`. Without a valid event key, the
engine answers `401 invalid event key`.

## Function

A **function** is code the engine runs for you. You write it in your app with
`createFunction` (TypeScript) or `flow.CreateFunction` (Go). It has an ID, a
trigger, and a body made of steps.

## Trigger

A **trigger** says what starts a function: an event name, or a schedule.

```ts
{ event: "user/signed-up" }    // each user/signed-up event starts a run
{ cron: "0 9 * * MON" }        // every Monday at 09:00 UTC
```

One event can start many functions: every function whose trigger matches gets its
own run.

## Run

A **run** is one time a function runs, from start to end. Each event starts one run
of each matching function. A run can take a second, or months if it sleeps. You see
each run, with its steps, in the dashboard. A run ends as `completed`, `failed` or
`cancelled`.

## Step

A **step** is one piece of work inside a function, with a name you give it, like
`send-welcome-email`. The engine saves each step's result. A step that is done never
runs again in that run.

```ts
const user = await step.run("load-user", () => db.users.find(event.data.userId));
```

The step's name (its **step ID**) is how the engine finds the saved result. Keep it
the same between deploys.

## Retry

When a step fails (it throws, or returns an error in Go), the engine **retries** it:
it waits a little and runs that step again. Steps that are done stay done. By
default a step gets 5 tries in all (1 try, plus 4 retries). When the tries run out,
the error comes back into your function, and if you do not catch it, the run fails.
[Errors and retries](errors.md) has the details.

## Replay: code outside steps runs again

This is the one idea to get right before you write a function.

The engine does not keep your function running between steps. For each step, it
calls your endpoint, and your function **runs again from the top**. Steps that are
done do not run again: they give back their saved result at once. When the function
reaches a step that is not done, the SDK runs it, sends the result, and stops.

Here is a function with two steps, and a log line outside the steps:

::: code-group
<<< @/../examples/ts/steps.ts#replay [TypeScript]
<<< @/../examples/go/steps/main.go#replay [Go]
:::

One event gives this log. The engine called the function three times:

```
the function starts
step-a runs
the function starts
step-b runs
the function starts
the function ends
```

What this means for your code:

- **Put side effects in steps.** An email, a payment, a write to your database: put
  each one in a step. Code outside steps can run many times.
- **Keep step IDs and their order the same** for the same event. Do not choose steps
  based on the time or a random number, unless that value came from a step.
- **Return plain JSON from steps.** The result is saved as JSON. A `Date` comes back
  as a string; a class comes back as a plain object.

## A step runs at least once

The engine saves a step's result only after your app answers. If your app crashes
after the work but before the answer, the engine runs the step again. So a step can
run **more than once**. Make it safe to repeat: for example, pass the step's
**idempotency key** to an outside API, so the API does the work only once.

```ts
await step.run("charge-card", ({ idempotencyKey }) =>
  payments.charge(orderId, { idempotencyKey }), // the same key on every try
);
```

In Go, it is `step.IdempotencyKey(ctx)` inside the step.

## Sleep

A **sleep** pauses a run for a time, or until a moment. Nothing runs while it
sleeps, so a sleep of a month costs nothing.

```ts
await step.sleep("wait-a-day", "1d");
await step.sleepUntil("wait-for-launch", "2027-01-01T09:00:00Z");
```

## Wait for an event

A run can **wait for another event**, with a time limit. For example: after an order
is placed, wait up to 14 days for `order/shipped` for the same order.

```ts
const shipped = await step.waitForEvent("wait-for-shipment", {
  event: "order/shipped",
  match: "data.orderId",
  timeout: "14d",
});
// shipped is the event, or null if 14 days passed first
```

## Sync

**Sync** is how the engine learns which functions your app has. The SDK sends the
list (the **manifest**) to the engine. The first sync happens when you add the app
in the dashboard. After that, the app syncs by itself each time a new version
starts. If you change a function and do not sync, the engine still uses the old
list.

## Signing key

Each app has its own **signing key**, a secret that looks like `signkey-` and 64
hex characters. The engine signs every call to your app with it, and the SDK checks
the signature. The app also uses it to prove who it is when it syncs. The SDK reads
it from `FLOW_SIGNING_KEY`. You get it in the dashboard when you add the app.

Next: the [Quick start](getting-started.md) puts all of this to work.
