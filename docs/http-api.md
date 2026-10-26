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
- **The same `id`** gives the same event ID, and no new runs.

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

## Realtime

| Route | Key | What |
| --- | --- | --- |
| `POST /v1/realtime/publish` | signing key | `{ channel, topic, data }`: send a live message |
| `POST /v1/realtime/token` | signing key | `{ channel, topics }`: a token for one browser |
| `GET /v1/realtime/connect?token=...` | the token | the WebSocket a browser opens |

Without realtime set up on the engine, these answer `503`. See [Realtime](realtime.md).

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
