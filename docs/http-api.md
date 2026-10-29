# HTTP API

The engine's routes that your code can call, and the endpoint your app serves. The
SDKs call these for you; use them directly from other languages, scripts and CI.

The engine is at `https://worker.flow.clevixstudio.com` (a local engine:
`http://127.0.0.1:8787`). Every error answer is JSON like
`{"error": "...", "status": 400}`; some also have a `code`.

## `POST /e`: send events

```bash
curl -X POST https://worker.flow.clevixstudio.com/e \
  -H "Authorization: Bearer $FLOW_EVENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "order/paid", "data": {"orderId": "o_123"}}'
```

- **Key:** `Authorization: Bearer <event key>`, or in the path: `POST /e/<event key>`.
  The header keeps the key out of URL logs.
- **Body:** one event, or a list of 1 to 100. Each event is
  `{ "name", "data"?, "id"?, "ts"?, "user"? }` (see [Events](events.md#what-an-event-holds)).
- **All or nothing:** if one event is bad, none are taken.
- **The same `id`** gives the same event ID, and no new runs while the first runs
  are kept (see [Events](events.md#send-an-event-only-once)).

Answers, as the engine gave them on a local engine:

| Status | Body | When |
| --- | --- | --- |
| `200` | `{"ids":["evt_01M5WSJQ29DH5SYPSPS2WSS2SF"],"status":200}` | Taken. One ID per event, in order. |
| `400` | `{"error":"body must be JSON","status":400}` | The body is not JSON. |
| `400` | `{"error":"no events","status":400}` | An empty list. |
| `400` | `{"error":"each event needs a name (1-256 chars)","status":400}` | No name, or too long. |
| `400` | `{"error":"event name inngest/x is reserved","status":400}` | A name starting with `inngest/`. |
| `400` | `{"error":"event ts must be a number (ms since epoch)","status":400}` | `ts` is not a number. Also `event id must be a string up to 256 chars`, `each event must be an object`. |
| `401` | `{"error":"invalid event key","status":401}` | No key, a wrong key, or a revoked one. |
| `402` | `{"error":"this workspace's account has no credit or wallet money left: ...","status":402,"code":"SpendLimitReached"}` | The account's money is used up. No new runs start. |
| `403` | `{"error":"this workspace is suspended: no new runs start","status":403,"code":"WorkspaceSuspended"}` | The workspace is suspended, being deleted, or not set up. |
| `405` | `{"error":"method not allowed","status":405}` | Not a `POST`. |
| `413` | `{"error":"at most 100 events per request","status":413}` | More than 100 events. |
| `413` | `{"error":"event big is larger than 1000000 bytes","status":413}` | One event over 1 MB. `request too large` for a body over 10 MB. |
| `429` | `{"error":"this workspace sends more events per second than its plan allows; try again shortly","status":429,"code":"RateLimited"}` | Too many events a second for the plan. Has a `Retry-After` header in seconds. |

## `PUT /apps/{appId}/sync`: sync an app

Sends the app's manifest. The SDK does this for you; you do not need to build a
manifest by hand. To make your app sync, send a `PUT` to **your app's endpoint**
instead: `curl -X PUT https://your-app/api/flow`. The answer:

```json
{"ok":true,"created":false,"urlChanged":null,"modified":["shop-onboard-user"],"archived":[]}
```

`modified` lists the functions that are new or changed; `archived` the ones that are
gone. The key is the app's signing key, as a bearer: see
[Protocol](protocol.md#sync).

## `GET /apps/{appId}/sync?hash=...`: check the last sync

What the engine has from the app's last sync: `manifestHash`, `syncedAt`, `retryAt`
and `checkEveryMs`. The SDK's sync at boot calls it. Same key as the `PUT`.

## `GET /runs/{runId}/state`: a big run's state

A run's step results and events, page by page. The SDK calls it when a run's state
is over 4 MB. Same key as sync; an app can read only its own runs.

## Calls with the signing key

The routes below take the app's signing key as a bearer, as sync does:
`Authorization: Bearer <signingKeyBearer(key)>` (see [Protocol](protocol.md#sync)).
The key says which workspace and app. An old shared key also needs the app's ID: as
`appId` in the body of a `POST`, or in the query of a `GET` or `DELETE`. The SDKs
always send it.

A function ID in these routes is the function's own ID, as in `createFunction` (for
example `send-welcome`), not the full `<appId>-<id>`. A key sees only its own app's
functions and runs.

Answers have `Cache-Control: no-store`. `401` is a missing or wrong key. The SDKs try
the fallback key (`FLOW_SIGNING_KEY_FALLBACK`) on a `401`.

## `POST /v1/functions/{functionId}/start`: start a run

Starts a run of one function now, without an event, and tells you if it did not
start.

```json
{ "data": { "orderId": "o_123" }, "id": "order-o_123", "user": { "id": "u_1" }, "whenPaused": "hold" }
```

- `data` defaults to `{}`. `user` is optional.
- `whenPaused` is `"refuse"` (the default) or `"hold"`. With `"hold"`, a paused
  function takes the run anyway: it is made `paused`, and starts when the function is
  resumed. The answer is then `started: true`.
- `id` (1 to 256 characters) makes a retry safe: the same `id` lands on the same run.
  The answer then has `"existed": true`, whatever the run's state.
- Singleton, throttle, concurrency and priority apply. Rate limit, debounce and
  batching do not. See [Flow control](flow-control.md#start-a-run-directly).
- The run's event is named `inngest/function.invoked`.

Answers:

| Status | Body | When |
| --- | --- | --- |
| `200` | `{"started":true,"runId":"run_...","eventId":"evt_..."}` | The run started. With `"existed":true` when the same `id` started it before. |
| `200` | `{"started":false,"reason":"singleton","activeRunId":"run_..."}` | A run with the same singleton key is active. `activeRunId` is `null` if it ended in between. |
| `200` | `{"started":false,"reason":"paused"}` | The function is paused. |
| `200` | `{"started":false,"reason":"not_found"}` | The app has no function with that ID. |
| `400` | `{"error":"...","status":400}` | The body is not JSON, `id` is not 1 to 256 characters, or `whenPaused` is not `"refuse"` or `"hold"`. |
| `402`, `403` | as for [`POST /e`](#post-e-send-events) | The account's money is used up, or the workspace is suspended. |
| `413` | `{"error":"...","status":413}` | The event is over 1 MB, or the body over 2 MB. |
| `429` | `{"error":"...","status":429,"code":"RateLimited"}` | Too many events a second for the plan. Has `Retry-After`. |

A start uses one of the plan's events a second only when it starts a new run: the
`existed`, `not_found` and `paused` answers use none.

## `GET /v1/runs`: list runs

```
GET /v1/runs?function=send-welcome&status=queued,sleeping&tag.orderId=o_123&limit=20
```

| Query | What it is |
| --- | --- |
| `function` | Only this function's runs. Needed for a `tag.*` filter. |
| `status` | A comma list of statuses: `queued`, `running`, `sleeping`, `waiting`, `waiting_for_app`, `paused` (active), `completed`, `failed`, `cancelled` (ended). |
| `tag.<name>` | Only runs with this [tag](functions.md#tags) value. Up to 3; all must match. |
| `limit` | 1 to 200. Default 50. |
| `before` | The `next` of the last page. |
| `order` | `newest` (the default) or `oldest`: oldest first. |

Answer, newest first (or oldest first):

```json
{
  "items": [
    { "id": "run_...", "functionId": "send-welcome", "status": "sleeping",
      "createdAt": 1793000000000, "endedAt": null, "tags": { "orderId": "o_123" } }
  ],
  "next": "..."
}
```

`next` is `null` on the last page. `tags` is `{}` for a run with none. An unknown
function gives an empty list, not `404`. `400` for a `tag.*` filter with no
`function`, an unknown status, a bad tag name, or a bad `limit` or `before` (they are
not clamped).

The list reads an index that lags the runs by a few seconds. A run that just started
may not be in it yet.

## `GET /v1/runs/counts`: count runs

```
GET /v1/runs/counts?function=send-welcome
```

```json
{ "queued": 3, "running": 1, "sleeping": 12, "waiting": 0, "waiting_for_app": 0, "paused": 0,
  "completed": 140, "failed": 2, "cancelled": 5, "since": 1793000000000 }
```

`function` is needed. Every status is always there; an unknown function gives all
zeros, not `404`. Ended runs are deleted after a few
days (see [Limits](limits.md#keeping-data)), so they are counted only from `since`
(ms since epoch). The counts read the same index as the list, with the same lag.

## `GET /v1/functions/{functionId}/singleton`: who holds a singleton key

```
GET /v1/functions/send-welcome/singleton?key=u_1
GET /v1/functions/send-welcome/singleton?keyJson=42
```

The key is the value the function's `singleton.key` expression gives. Send a text
value as `key`, and any other JSON value (a number, say) as text in `keyJson`.

```json
{ "runId": "run_...", "status": "sleeping" }
```

Both are `null` when no active run holds the key. This reads the singleton itself, so
it has no lag. `404` for an unknown function. `400` for a function with no
`singleton`, or with neither or both of `key` and `keyJson`.

## `POST /v1/runs/cancel`: cancel runs

The body has exactly one of these:

```json
{ "runId": "run_..." }
{ "function": "send-welcome", "singletonKey": "u_1" }
{ "function": "send-welcome", "tag": { "orderId": "o_123" }, "status": ["queued", "sleeping"], "cursor": "..." }
```

- `runId`: that run. A run of another app is not found, the same as a missing one.
- `singletonKey`: the active run that holds that key, if any.
- `tag`: the active runs with that tag (one tag only), up to 500 a call, oldest first.
  `status` (only with `tag`) narrows it to some active statuses. The tag lookup reads
  the index, with its lag. `cursor` (only with `tag`) is the `next` of the last call.

```json
{ "cancelled": ["run_..."], "notActive": ["run_..."], "more": false, "next": null }
```

A run that has ended, or is not found, goes in `notActive`; that is not an error.
`more` is `true` when a tag matched more than 500 runs: call again with `next` as
`cursor`, so the next call goes on after this page. `next` is `null` otherwise. By tag, an unknown
function gives empty lists. By `singletonKey`, it is `404` for an unknown function and
`400` for a function with no `singleton`. `400` when the body does not have exactly
one of the three, or a `tag` with more than one entry.

## `GET /v1/runs/{runId}`: one run

```json
{ "id": "run_...", "functionId": "send-welcome", "status": "failed",
  "createdAt": 1793000000000, "endedAt": 1793000060000, "tags": {},
  "attempts": 4, "error": { "name": "Error", "message": "the mail server is down" },
  "event": { "id": "evt_...", "name": "inngest/function.invoked", "data": { "orderId": "o_123" }, "ts": 1793000000000 } }
```

- The fields of [`GET /v1/runs`](#get-v1runs-list-runs), plus:
- `attempts`: for a failed run, how many times the call that failed it was tried (as
  the failure function's `attempts`). For any other run, how many times it was called.
- `error`: why it failed or was cancelled, or `null`.
- `event`: the event that started it. Not its steps or output: the dashboard shows those.

It asks the run itself, so it has no lag. `404` for a run that is missing, deleted
after its retention, or another app's.

## `POST /v1/runs/{runId}/retry`: retry a run

Body: `{}`. Retries a failed or cancelled run from where it stopped, as the
dashboard's Retry. It keeps its run ID, and its finished steps are not run again.

```json
{ "retried": true }
{ "retried": false }
{ "retried": false, "reason": "singleton" }
```

`retried` is `false` for a run that has not failed or been cancelled. With `reason:
"singleton"`, another run holds its singleton key now. `404` for a run that is
missing or another app's. `402` or `403`, as for a start, when the workspace may
start no runs.

## `POST /v1/runs/{runId}/delete`: delete a run that has ended

Body: `{}`. Deletes a completed, failed or cancelled run now, as its retention would
later: its state, its stored files and its row in the run index.

```json
{ "deleted": true }
```

`deleted` is `false` for an active run (cancel it first). The delete runs a moment
after the answer, so `GET /v1/runs` may list the run for a few seconds more. `404` for
a run that is missing or another app's.

## `POST /v1/functions/{functionId}/pause` and `/resume`

Body: `{}`. Pauses (or resumes) one of the app's functions, as the dashboard does.

```json
{ "paused": true, "runs": 3 }
```

- Pause: new runs are refused (`reason: "paused"`), or held with a start's
  `whenPaused: "hold"`. Events for the function are skipped. Its active runs pause at
  their next step.
- Resume: the function takes runs again, and its paused runs go on, held ones too.
- `runs` is how many runs it paused or resumed. It finds them in the run index, which
  lags: a run held a moment before a resume checks its function itself, within 30
  seconds.
- `404` for a function the app does not have.

## Realtime

| Route | Key | What |
| --- | --- | --- |
| `POST /v1/realtime/publish` | signing key | `{ channel, topic, data }`: send a live message |
| `POST /v1/realtime/publish` | signing key | `{ messages: [{ channel, topic, data }, ...] }`: send 1 to 100 at once |
| `POST /v1/realtime/token` | signing key | `{ channel, topics }` or `{ channels, topics }`: a token for one socket |
| `GET /v1/realtime/connect?token=...` | the token | the WebSocket a browser opens |

Publish answers `202 {"ok":true}`, or `202 {"ok":true,"count":2}` for a list. A list
is checked in full before any message is sent: one bad message is `400` for the whole
call. The body is at most 1 MB, and each message's `data` at most 64 KB.

A token is for `channel`, or for 1 to 100 `channels` on one socket (exactly one of
the two, else `400`). The `channels` names may have at most 8,000 characters in all,
so the token fits in a connect URL. Its answer has the same field back. `topics` (1 to 10) apply to
every channel.

Without realtime set up on the engine (no `REALTIME_TOKEN_SECRET`), the token and
connect routes answer `503`. See [Realtime](realtime.md).

## Streams

A stream is a list of items kept for a while, that a reader reads from any offset and
then follows live. See [Streams](streams.md). A stream ID is letters, digits and
`:_.-`, up to 256, but not `.`, `..`, `token` or `connect` (`400`).

| Route | Body or query | Answer |
| --- | --- | --- |
| `POST /v1/streams/{id}/open` | `{ "meta"?: Json, "ttlMs": number }` | `{ "created": true }`, or `false` when it is there already (nothing changes) |
| `POST /v1/streams/{id}/append` | `{ "items": [Json, ...] }` | `{ "offsets": ["1", "2"] }` |
| `POST /v1/streams/{id}/close` | `{ "end": Json, "graceMs": number }` | `{ "closed": true }`, or `false` when it was closed already |
| `DELETE /v1/streams/{id}` | | `{ "deleted": true }`, or `false` when there was none |
| `GET /v1/streams/{id}?after=&limit=` | | `{ "meta", "items": [{ "offset", "item" }], "ended", "more" }` |
| `POST /v1/streams/token` | `{ "stream": "<id>" }` | `{ "token", "url", "stream", "expiresAt" }` |
| `GET /v1/streams/connect?token=...&after=...` | the token | the WebSocket a reader opens |

- **Offsets** are each item's place in the stream (`"1"`, `"2"`, ...), as text. Treat
  them as opaque: keep the last one you saw and send it back as `after`. An empty or
  missing `after` means from the start. Anything that is not a whole number of 0 or
  more is `400`.
- **open** deletes the stream `ttlMs` later unless it is closed.
- **close** writes `end` as the last item (it gets an offset too), and deletes the
  stream `graceMs` later.
- **GET** gives the items after `after`, oldest first: up to `limit` (1 to 1000,
  default 1000) and about 4 MB. `more: true` means there are more: read again from
  the last offset. `ended` is `true` when the stream is closed.
- **The socket** first sends every item after `after`, then each new one. Each frame
  is `{ "offset": "12", "item": ... }`. The end item's frame also has `"end": true`,
  and the engine then closes the socket with code `1000`. Send `"ping"` to get
  `"pong"`. A socket lives up to 1 hour, then closes with `4001`: connect again with a
  new token and the last offset. A stream that is gone closes it with `4404`. A
  closed stream with nothing after `after` (the reader already had the end item)
  closes it at once with `4100`: the read is over, so do not connect again. Right
  before a `4100`, `4404` or `4001` close, the engine sends `{ "closing": <code> }`:
  act on that code then, as some clients (Node's) report the close seconds late. It
  is never an item. A token
  opens one socket, within 60 seconds.

Errors:

| Status | `code` | When |
| --- | --- | --- |
| `400`, `413` | | A bad ID, body, `after` or `limit`, or a call over a [limit](limits.md#streams) (an item over 64 KB, more than 100 items, a body over 1 MB). |
| `404` | `StreamGone` | The stream was never opened, or was deleted. From append, close and GET. |
| `409` | `StreamClosed` | An append to a closed stream. |
| `413` | `StreamFull` | The append would pass a limit for one stream (items or bytes). |
| `503` | | Token and connect: realtime is not set up (no `REALTIME_TOKEN_SECRET`). |

See [Limits](limits.md#streams) for every limit.

## `GET /health`

Answers `{"ok":true}`.

## Your app's endpoint

The endpoint your app serves (for example `/api/flow`):

| Method | Who calls it | What it does |
| --- | --- | --- |
| `POST` | the engine, signed | Runs a function. Unsigned or wrongly signed: `401 {"name":"Unauthorized","message":"missing or invalid signature"}`. |
| `GET` | the engine, signed (**Add app**, **Resync**, **Change URL**) | Gives the manifest. Unsigned: `401`. |
| `PUT` | you, for example in CI | Syncs, and gives back the engine's answer. Needs no signature: anyone can make your app sync its own functions, but only with your key. |
| other | | `405 MethodNotAllowed` |

There is no hosted webhook URL. Webhooks from other services go to a route in your
app; see [Webhooks and events](webhooks.md).
