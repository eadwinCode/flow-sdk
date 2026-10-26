# Webhooks and events

## The problem

Other services tell you that something happened by calling a URL of yours: GitHub
on a push, Stripe on a payment. This is a **webhook**. Handling them well is hard:

- The sender waits for your answer, often only a few seconds. Slow work in the
  handler makes it time out, and the sender tries again.
- Senders send the same webhook more than once (after a timeout, or on purpose). Your
  code must not do the work twice.
- If your code fails half way, the work is lost, unless the sender tries again.

## The shape of the solution

The engine has **no webhook endpoint** and gives you **no hosted webhook URL**. Its
only way in for events is its own event API, `POST /e`, which takes its own event
shape (`{"name": ..., "data": ...}`) and needs your event key. GitHub and Stripe send
their own shapes, so they can not post to it.

So the webhook goes to a route **in your own app**:

1. The route checks the sender's signature, so you know the webhook is real.
2. It sends one event to the engine, with an **event ID taken from the webhook**, so
   a second delivery of the same webhook is the same event.
3. It answers `200` at once.
4. Functions whose trigger matches the event do the work, in steps, with retries.

The code is in the repo:
[`examples/ts/webhooks.ts`](https://github.com/eadwinCode/flow-sdk/blob/main/examples/ts/webhooks.ts)
and [`examples/go/webhooks/main.go`](https://github.com/eadwinCode/flow-sdk/blob/main/examples/go/webhooks/main.go).
It takes GitHub webhooks; the same shape works for any sender.

## The webhook route

GitHub signs each delivery with a secret you choose when you set up the webhook. It
sends the signature in `X-Hub-Signature-256`, the kind of event in `X-GitHub-Event`,
and an ID for the delivery in `X-GitHub-Delivery`.

::: code-group
<<< @/../examples/ts/webhooks.ts#route [TypeScript]
<<< @/../examples/go/webhooks/main.go#route [Go]
:::

What the route does, and why:

- **It checks the signature over the raw bytes.** Parse the JSON only after the
  check. (In Express, `express.raw()` on this route keeps the bytes.)
- **It names the event after the webhook:** `github/push`, `github/pull_request`, and
  so on. Functions pick the events they want by name.
- **It sends the webhook's body as the event's data**, so functions read
  `event.data.repository.full_name` as GitHub sent it.
- **It gives the event a stable `id`:** `github-<delivery ID>`. Pick an ID that stays
  the same when the sender sends the same thing again; check your sender's docs for
  which one does. For Stripe, the event's own `id` field (`evt_...`) is a good one.
- **It answers after the event is queued, not after the work.** If `flow.send` fails,
  it answers `500`, so the sender tries again later.

## Each delivery is handled once

The engine makes the event ID from your `id` (and your workspace). The same `id`
gives the same event ID, and each function gets **one run** per event ID. So when
GitHub sends delivery `d-1001` twice, both sends answer with the same event ID, and
each function runs once.

We tested this on a local engine: two sends of the same delivery, one with a bad
signature.

```
200 ok          (first delivery)
200 ok          (same delivery again: same event ID, no new runs)
401 bad signature
```

The app's log showed `chat: 2 new commit(s) in acme/shop` once.

This holds while the engine keeps the run: while it runs, and 3 days after it ends
(4 days after it failed). A delivery of the same ID after that starts new runs.

## The functions

One event can start many functions. Here a push starts one run of `record-push`
and one run of `index-push`. Each has its own steps and its own retries: if
`index-push` fails, `record-push` is not touched.

::: code-group
<<< @/../examples/ts/webhooks.ts#functions [TypeScript]
<<< @/../examples/go/webhooks/main.go#functions [Go]
:::

Each step writes in a way that is safe to repeat (keyed by commit, or a set), since a
step can run more than once. See [Background jobs](background-jobs.md#a-step-runs-at-least-once).

## Wait for a later event

A run can wait for another event. Here, when a pull request opens, the run waits up
to 2 days for a review of **that** pull request. If none comes, it reminds the team.

::: code-group
<<< @/../examples/ts/webhooks.ts#wait [TypeScript]
<<< @/../examples/go/webhooks/main.go#wait [Go]
:::

- The trigger's `if` (`event.data.action == 'opened'`) starts runs only for opened
  pull requests. A `closed` one starts no run.
- In the wait's `if`, `event` is the event that started this run, and `async` is the
  new event. For a plain "same field in both", use `match: "data.orderId"` instead.
- `waitForEvent` gives back the event (TypeScript), or `step.ErrEventNotReceived`
  (Go) when the time runs out (TypeScript gives `null`).
- An event that came a little **before** the wait started still counts: anything
  after the step before the wait, up to one hour back.

On a local engine, the review arrived and the run **Completed** with
`{"reviewed": true, "by": "grace"}`.

## Test it

Run the app with `GITHUB_WEBHOOK_SECRET` set, connect it, and post a signed
delivery yourself:

```bash
echo '{"after":"9f2c1e7","repository":{"id":42,"full_name":"acme/shop"},"commits":[{"id":"9f2c1e7"},{"id":"1a2b3c4"}]}' > push.json
sig=$(openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" -hex < push.json | sed 's/^.* //')
curl -X POST http://127.0.0.1:3000/webhooks/github \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: push" -H "X-GitHub-Delivery: d-1001" \
  -H "X-Hub-Signature-256: sha256=$sig" \
  --data-binary @push.json
```

To get real deliveries from GitHub on your laptop, the route must be public: use a
tunnel ([Local development](local-dev.md#the-hosted-engine-through-a-tunnel)) and give
GitHub the tunnel URL plus `/webhooks/github`.

## Send events from anywhere over HTTP

Any program in any language can send events with a plain HTTP request. Use this from
your own services, scripts and jobs, not from third parties.

```bash
curl -X POST https://worker.flow.clevixstudio.com/e \
  -H "Authorization: Bearer $FLOW_EVENT_KEY" \
  -H "Content-Type: application/json" \
  -d '[{"name":"order/paid","data":{"orderId":"o_1"}},{"name":"order/paid","data":{"orderId":"o_2"}}]'
```

```json
{"ids":["evt_01M5WSJQ1WTHAFBNRS4GAMGX82","evt_01M5WSJQ1W21YNYK7WCX80TCNY"],"status":200}
```

- The key goes in `Authorization: Bearer <event key>`, or in the path:
  `POST /e/<event key>`. The header keeps it out of URL logs.
- The body is one event, or a list of up to 100. A request is all or nothing.
- Give each sender its own event key (dashboard, **Keys**), so you can revoke one
  without cutting off the others.

The answers are listed in the [HTTP API](http-api.md#post-e-send-events) reference:
`200` with the IDs, `400` for a bad event, `401` for a bad key, `402` or `403` when
the workspace may start no runs, `413` when it is too big, `429` when the workspace
sends too fast.

## Events the engine sends

The engine sends some events itself. Their names start with `inngest/`, a name you
can not use for your own events. Your functions can be triggered by them:

| Name | When | `data` |
| --- | --- | --- |
| `inngest/scheduled.timer` | A cron trigger fires | `cron`, `scheduledAt` (ms) |
| `inngest/function.failed` | A run fails for good | `function_id`, `run_id`, `error`, `event` |
| `inngest/function.cancelled` | A run is cancelled | `function_id`, `run_id`, `event`, and `error` when there is one |
| `inngest/function.invoked` | `step.invoke` starts a run | the `data` the caller passed |

See [Errors and retries](errors.md#when-a-run-fails-for-good) for a function that runs
when another one fails.

## Limits and gotchas

- **One event is at most 1 MB** (all its fields, as JSON); a request at most 10 MB
  and 100 events. A webhook body bigger than that fails with `413`: send only the
  fields your functions need.
- **Event names** are 1 to 256 characters, and case-sensitive: `github/push` and
  `GitHub/push` are two names.
- **The ID window:** a repeat of the same `id` is caught while the first run is kept
  (3 days after it ends, 4 if it failed).
- **A new wait name:** when a run waits for an event name that no run waited for in
  the last day, an event that comes in the first few seconds can take about 30
  seconds to reach the wait. (We saw a review resume the run 30 seconds late this
  way; once the name was known, the next one resumed it at once.)
- **Signature checks are yours.** The engine only checks your event key. Your route
  must check the sender's signature.
