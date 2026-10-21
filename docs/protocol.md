# SDK protocol

How an app's SDK talks to the engine. Both SDKs (TypeScript in `packages/flow`, Go at
the repo root) follow this page exactly, so the engine cannot tell them apart and a
TypeScript function can `step.invoke` a Go function. The wire types are in
[`packages/protocol/src/types.ts`](../packages/protocol/src/types.ts); this page says how to use them.

Test vectors for step IDs, signatures, answer signatures and the bearer token are in
[`testdata/vectors.json`](../testdata/vectors.json). Both SDKs test against that file.
The engine's conformance suite, in the engine repo, runs both SDKs against a real
engine.

## Environment variables

| Variable | Use |
| --- | --- |
| `FLOW_SIGNING_KEY` | `signkey-<64 hex>`, the app's own key. Checks calls from the engine, and signs sync. Required unless dev mode. |
| `FLOW_SIGNING_KEY_FALLBACK` | Old key while rotating. Calls signed with either key are accepted. |
| `FLOW_EVENT_KEY` | Event key, for sending events. |
| `FLOW_BASE_URL` | Engine URL. Default: `https://worker.clevixstudio.com`. |
| `FLOW_DEV` | `1` turns off signature checks. Without it, the SDK refuses to serve with no signing key. |

Options passed in code win over these.

## The one endpoint

An app serves one URL (for example `/api/flow`):

| Method | What |
| --- | --- |
| `POST` | Run a function. Signed by the engine. |
| `PUT` | Sync: the app sends its manifest to the engine (`PUT {base}/apps/{appId}/sync`) and returns the engine's answer. Call it on deploy (for example `curl -X PUT https://app/api/flow`). |
| `GET` | Returns the manifest (`AppManifest`) as JSON. Requires a valid signature over the empty body (dev mode: none). The engine calls it to add the app by URL, to resync it, to change its URL, and to ping it while it is down. |

### Signature check (POST and GET)

Header `X-Inngest-Signature: t=<unix seconds>&s=<hex>`. `s` is HMAC-SHA256 with the
signing key minus its `signkey-` prefix, used as UTF-8 text, over
`rawBody + t`. Reject (401, function does not run) if the header is missing, if
`|now - t| > 300`, or if neither the key nor the fallback matches. Compare in constant
time. Check the raw bytes as received, before parsing JSON.

### Answer signature (SDK v0.5.0 and later)

Every answer to a POST or GET that passed the signature check carries
`X-Flow-Answer-Signature: s=<hex>`, whatever its status (200, 206, 400, 500). `s` is
HMAC-SHA256, with the key that matched the request (the current key or the
fallback), over these lines joined by `\n`:

```
flow-answer-v1
<the s value of the request's X-Inngest-Signature>
<HTTP status, for example 206>
<the answer's X-Inngest-No-Retry value, or empty>
<the answer's Retry-After value, or empty>
<the raw body>
```

A 401 is not signed (no key matched). In dev mode an unsigned call is let in and
its answer is not signed; a call signed with one of the app's keys gets a signed
answer.

The engine checks it. It turns on "answers must be signed" for an app only when an
admin's **Add app**, **Resync** or **Change URL** gets a signed answer from it. A
normal call or a `PUT` sync never turns it on. Once it is on, the engine refuses the
app's unsigned answers, so a relay can not strip the header. A `PUT` sync from an SDK
older than v0.5.0 turns it off again (the app went back to an old SDK). An old engine
ignores the header.

So a rolling deploy to v0.5.0 or later is safe: while old and new copies of the app
both answer, nothing is turned on, and the old copies' unsigned answers still work.
When the deploy is done, press **Resync** once to turn it on.

Going back to an SDK older than v0.5.0: send the app's `PUT` sync at once
(`curl -X PUT https://app/api/flow`). Until then the engine refuses the app's
unsigned answers, so steps that already ran may run again. **Resync** can not turn
the check off. The engine may keep the old setting for up to 10 seconds after the
`PUT`.

Add app, Resync and Change URL also refuse an unsigned answer when the app's last
sync said SDK v0.5.0 or later, even if the check is not on yet. So a relay can not
strip the header and say the app runs an older SDK. The one case the engine can not
catch is the very first Add app of a new app, when it knows nothing about it yet.

The signed manifest's `url` is the URL the app was called on, as it sees it. When
an admin types a URL (Add app, Change URL), the engine checks that its host and path
are the same (not the scheme, so TLS may end at a proxy). A relay at another URL that
passes the calls on to the real app fails this check. So the app must see its public
host in the `Host` header: a proxy in front of it must pass it on (nginx:
`proxy_set_header Host $host;`). The SDKs do not read `X-Forwarded-Host`, since
anyone can send it (the Express adapter reads it only if you set `trust proxy`).

### Streamed answers (SDK v0.6.0 and later)

A proxy in front of the app ends a call that sends nothing for too long. Cloudflare
answers `524` after about 100 seconds; nginx stops after 60 seconds by default. So
without help, a step behind such a proxy must finish within that time.

To beat this, the engine adds `X-Flow-Stream: 1` to every `POST`. When the SDK sees
it, it answers like this:

1. At once: status `200` with these headers:
   - `X-Flow-Stream: 1`
   - `Content-Type: text/plain; charset=utf-8`
   - `Cache-Control: no-store, no-transform` (no compression on the way)
   - `X-Accel-Buffering: no` (nginx sends the bytes on at once)
2. A heartbeat, `\n`, right away and then every 20 seconds while the function runs.
3. At the end, one **meta line** and the answer's raw body:

```
\n\n\n{"status":206,"noRetry":null,"retryAfter":null,"signature":"s=…"}
[{"op":"StepCompleted",…}]
```

The meta line holds what a normal answer has in its status and headers: the real
status (`200`, `206`, `500`, ...), `X-Inngest-No-Retry`, `Retry-After`, and the
`X-Flow-Answer-Signature` value (`null` when the answer is not signed). The keys come
in this order with no spaces. The body after it is byte for byte what a normal answer
would have sent, and the signature is made exactly as above, over the real status,
the retry values and that body. Heartbeats carry nothing and are not signed.

Rules:

- Only `\n` is a heartbeat. The meta line ends at the first `\n` after it.
- A `401` (bad signature) and a `400` (bad request) are never streamed: they are
  answered at once, as before.
- In Go, an answer streams only when the server's writer can flush. Otherwise it is
  sent whole, as before.
- Apps can turn streaming off: `serve({ ..., streaming: false })` in TypeScript,
  `ClientOpts{NoStreaming: true}` in Go. The heartbeat time can be changed with
  `streaming: { heartbeatMs }` and `ClientOpts.HeartbeatInterval`.
- An SDK older than v0.6.0 ignores the request header and answers as before. An
  engine older than this never sends it, so the SDK answers as before.
- If a proxy holds the whole answer back until the end (some do), it still works: the
  engine just gets every byte at once.

This lifts the proxy's limit, not the engine's: a step still ends at the function's
step timeout (default 5 minutes, at most 14).

### Sync

`PUT {FLOW_BASE_URL}/apps/{appId}/sync` with
`Authorization: Bearer signkey-<hex sha256 of the secret's hex-decoded bytes>`
and an `AppManifest` body:

```json
{
  "appId": "billing",
  "url": "https://billing.example.com/api/flow",
  "sdk": { "language": "typescript", "version": "0.1.0" },
  "functions": [ { "id": "charge", "name": "Charge", "triggers": [{ "event": "billing/charge" }], "retries": 4 } ]
}
```

- `url` is this endpoint's URL as the request shows it (origin and path; there is no
  setting for it). An app added by URL in the dashboard keeps that URL: the engine
  uses the stored URL when the manifest's is not usable, and Add app, Resync and
  pings always use the stored one.
- The bearer must be the app's own signing key (403 for another app's key).
- `appId` and function IDs match `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`.
- Each function needs at least one trigger: `{ "event": "...", "if"?: "..." }` or `{ "cron": "..." }`.
- Config keys use Inngest's names and shapes and are copied as given: `retries`,
  `timeouts: { step, finish }`, `cancelOn`, `concurrency`, `throttle`, `rateLimit`,
  `debounce`, `batchEvents`, `priority`, `idempotency`, `singleton`. Durations are
  strings like `"30s"`, `"5m"`, `"7d"` or milliseconds as a number.
- The engine answers 200 `{ ok, created, modified, archived, ... }`, or 400/401
  with `{ error, status }`. Functions left out of the manifest are archived.

`onFailure` (TypeScript only, in the config) becomes a second function in the
manifest with ID `<id>-failure` and trigger
`{ "event": "inngest/function.failed", "if": "event.data.function_id == '<appId>-<id>'" }`.
Its handler gets `{ event, error, step }`, where `error` is `event.data.error` and
`event` is the failure event (`event.data.event` is the original trigger event).

## Running a function (POST)

The body is an `InvokeRequest`:

```ts
{ fnId, runId, event, events, memo, attempt, maxAttempts, targetStepId? }
```

- `fnId` is the function's ID **without** the app prefix (`charge`, not `billing-charge`).
  Unknown `fnId`: answer 500 with `{ name: "FunctionNotFound", message }` and
  `X-Inngest-No-Retry: true`.
- `event` is the trigger event; `events` is the batch (one item unless batching).
- `memo` maps hashed step IDs to `{ data }` or `{ error: { name, message, stack? } }`.

The SDK runs the handler from the top. Every step call computes its hashed ID (below).

- **In the memo:** the call returns at once. `{ data }` returns the data. `{ error }`
  throws a `StepError` (Go: returns an error) with that name and message, which the
  function may catch.
- **Not in the memo:** this is new work. What happens depends on how many new steps
  the function reached before it stopped to wait for them.

### Big state: load it from the engine (`useApi`)

Every SDK must support this: the engine sends `useApi` to any app, and an SDK that
ignores it would see an empty memo and run finished steps again.

When a run's state is too big for one request (over 4 MiB, `MAX_REQUEST_STATE_BYTES`),
the engine sets `useApi: true` and sends `memo: {}` and `events: []`. `event` is
always sent. Before running the function, the SDK loads the state page by page:

```
GET {FLOW_BASE_URL}/runs/{runId}/state            first page
GET {FLOW_BASE_URL}/runs/{runId}/state?cursor=... next pages
Authorization: Bearer signkey-<hex sha256 of the secret's bytes>   (same as sync)
```

Each answer is a `RunStatePage`: `{ events?, memo, next }`. `events` (the batch) is
only on the first page. Merge each page's `memo` into one map, and stop when `next` is
null. Then run as usual with that memo and those events.

- 401: bad key. 404: no such run. Treat any failure (status
  not 200, bad JSON, network error) as an error outside a step: answer 500 so the
  engine retries the call. Do not run the function with a partial memo.
- Pages are about 4 MiB each, so a 32 MiB state is about 8 pages.
- Use the current signing key for the bearer (not the fallback).
- The key covers the whole engine: it can read every run, not only this app's (see
  "Keys and signing" in architecture.md).

### Step IDs

Hashed ID = lowercase hex SHA-1 of the user's ID. The SDK counts how many times each
user ID has been used in this call; the Nth repeat (N >= 1) hashes `"<id>:<N>"`.
So a loop calling `step.run("fetch", ...)` three times gets `sha1("fetch")`,
`sha1("fetch:1")`, `sha1("fetch:2")`. Each opcode sends the hashed ID as `id` and the
user's ID as `name`.

### Answers

| Case | HTTP status and body |
| --- | --- |
| The function returned | `200`, body = its return value as JSON (`null` if none) |
| One new `step.run`, and no `targetStepId` | Run its callback now. `206` with `[StepCompleted { id, name, data }]`, or `[StepFailed { id, name, error }]` if it threw |
| Several new steps found together (parallel, for example `Promise.all` or `group.Parallel`), no `targetStepId` | `206` with one opcode per new step: `StepPlanned { id, name }` for each `step.run` (do not run them), and the step's own opcode for the others (`Sleep`, `WaitForEvent`, ...). The engine then calls once per planned step with `targetStepId` set |
| `targetStepId` is set | Replay as usual. When the function reaches the step with that hashed ID, run only it and answer `206 [StepCompleted]` or `[StepFailed]`. Other new steps are not run and not reported: their calls just never return in this request (TypeScript: a promise that never resolves; Go: stop the handler) |
| One new non-run step | `206` with its opcode |
| The function threw outside any step | `500` with `{ name, message, stack? }` |

Opcodes for the step kinds:

| Step | Opcode | Memo value on replay |
| --- | --- | --- |
| `step.run(id, fn)` | `StepCompleted { data }` / `StepFailed { error, noRetry?, retryAt? }` | the output |
| `step.sleep(id, duration)` | `Sleep { until }` (ms since epoch, now + duration) | `null` |
| `step.sleepUntil(id, time)` | `Sleep { until }` | `null` |
| `step.waitForEvent(id, { event, timeout, match? , if? })` | `WaitForEvent { event, timeout, match?, if? }` | the matching event, or `null` on timeout (Go: `ErrEventNotReceived`) |
| `step.sendEvent(id, event \| events)` | `SendEvent { events }` | `{ ids: string[] }` |
| `step.invoke(id, { function, data?, timeout? })` | `InvokeFunction { function, data?, timeout? }` (`function` is the full `<appId>-<functionId>`) | the child's output, or `{ error }` (thrown as `StepError`) |

`Sleep.until` must be computed only when the step is new, never on replay, since the
memo decides replay.

### Errors

- `NonRetriableError` (Go: `flow.NoRetryError(err)`): in a step, `StepFailed` with
  `noRetry: true`; outside a step, the 500 answer gets header `X-Inngest-No-Retry: true`.
- `RetryAfterError(message, at)` (Go: `flow.RetryAtError(err, at)`): in a step,
  `StepFailed` with `retryAt` (ms since epoch); outside a step, header
  `Retry-After: <seconds from now>`.
- `StepError`: what a step call throws on replay when the memo holds `{ error }`
  (the step ran out of retries). Catch it to run compensation steps.

Retries and backoff are the engine's job. The SDK reports one attempt and stops.

### Idempotency key per step

Give users `"<runId>:<hashed step id>"` (same on every attempt) to pass to outside APIs.

## Sending events

`POST {FLOW_BASE_URL}/e` with `Authorization: Bearer <event key>` and a JSON body of
one event or a list (up to 100): `{ name, data?, id?, ts?, user? }`. Names starting
with `inngest/` are reserved. The answer is `{ ids: string[], status: 200 }`.

## Realtime

Both take `Authorization: Bearer <signing key bearer>` (as sync), and on a `401` the
SDK tries the fallback key. `appId` is the app's ID; always send it (a shared legacy
key needs it).

- `POST {FLOW_BASE_URL}/v1/realtime/publish` with `{ appId, channel, topic, data }`.
  The answer is `202 { ok: true }`. Body up to 64 KB (else `413`). Channel: 1-256 of
  `A-Za-z0-9:_-.`; topic: 1-64 of `A-Za-z0-9_-.` (else `400`).
- `POST {FLOW_BASE_URL}/v1/realtime/token` with `{ appId, channel, topics }` (1-10
  topics). The answer is `{ token, url, channel, topics, expiresAt }`.

The browser opens a WebSocket to `<url>?token=<token>` within a minute
(`expiresAt`). Each message from the engine is JSON text:
`{ channel, topic, data, ts }`. A token holds one open socket at a time, so get a
new token for every connect. The engine answers a second connect with the same token
with `409`, but a browser WebSocket can not see that status: it only gets an error
and a close (code `1006`). The client may send `ping`; the engine answers
`pong`. The engine closes the socket with code `4001` after an hour; the client then
gets a new token and connects again.

## Limits worth checking in the SDK

- A step output over 4 MB fails the step (`OutputTooLarge`), so a clear error early helps.
- A run has at most 1,000 steps.
- A run's whole state (its events, every step's output or error, and its output) is
  capped at 32 MiB, like Inngest. Passing it fails the **whole run** at once, with
  `StateOverflowed` ("The function run exceeded the state size limit of 33554432
  bytes."), no retry. It is not a step error the function can catch.
- Step IDs (hashed) are 40 chars, well under the engine's 256.
