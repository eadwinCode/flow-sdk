# TypeScript reference

The TypeScript SDK is `@clevix/flow`. This page lists what it has. For how to use it,
start with the [Quick start](getting-started.md).

## Install

The package is not on the npm registry. Each release puts it on its
[GitHub release](https://github.com/eadwinCode/flow-sdk/releases) as a `.tgz` file.
Install it by URL; no npm account or login is needed.

```bash
npm install https://github.com/eadwinCode/flow-sdk/releases/download/v0.6.5/clevix-flow-0.6.5.tgz
```

pnpm, yarn and bun take the same URL (`pnpm add <url>`, `yarn add <url>`,
`bun add <url>`). Your `package.json` then has:

```json
"dependencies": {
  "@clevix/flow": "https://github.com/eadwinCode/flow-sdk/releases/download/v0.6.5/clevix-flow-0.6.5.tgz"
}
```

and you import from `@clevix/flow` as usual. The lockfile keeps a hash of the file.

To upgrade, put the new version in both places in the URL (`v0.6.5` and
`clevix-flow-0.6.5.tgz`) and install again. `npm update`, Dependabot and Renovate do
not see new versions of a URL install, so watch the releases (on GitHub: **Watch**,
**Custom**, **Releases**).

The package is ESM only and has its own types. It runs on Node 20 or later and on
Cloudflare Workers. For Hono, Express or React, install that package too:
`@clevix/flow` does not depend on them.

v0.6.5 talks to `https://worker.clevixstudio.com` when `FLOW_BASE_URL` is not set.
The next release changes the default to `https://worker.flow.clevixstudio.com`. Both
reach the same engine today.

## Serve your functions

Each adapter wraps the same handler. The code is in
[`examples/ts/adapters/`](https://github.com/eadwinCode/flow-sdk/tree/main/examples/ts/adapters).

### Cloudflare Workers

<<< @/../examples/ts/adapters/cloudflare-worker.ts#worker

The whole Worker is the endpoint. Settings are read from the Worker's `env`:

```bash
wrangler secret put FLOW_SIGNING_KEY
wrangler secret put FLOW_EVENT_KEY
```

To serve the endpoint on one path of a bigger Worker, use Hono.

### Hono

<<< @/../examples/ts/adapters/hono.ts#hono

On Workers, `c.env` is passed on, so settings can live in the Worker's `env`. If a
middleware already read the body, the adapter uses Hono's copy of the raw text.

### Next.js (App Router)

In `app/api/flow/route.ts`:

<<< @/../examples/ts/adapters/next-route.ts#next

Settings are read from `process.env`.

### Express

<<< @/../examples/ts/adapters/express-app.ts#express

The signature is checked over the raw body, so the adapter must see the body as it
came. It reads the body itself, or takes it from `express.raw()` or `express.text()`.
If `express.json()` ran first, calls fail with `500 BodyAlreadyParsed`: mount the
endpoint before `express.json()`, or put `express.raw({ type: "*/*" })` on its path.
Behind a proxy, set `app.set("trust proxy", ...)` (only for your own proxy) so the
URL a `PUT` sync sends uses the real host and `https`.

### Any other runtime

`serve` from `@clevix/flow` is a plain fetch handler:
`(request, env?, ctx?) => Promise<Response>`. On Workers, pass `ctx` as the third
argument so the sync at boot can finish after the answer.

## The endpoint

| Method | What it does |
| --- | --- |
| `POST` | Runs a function. Signed by the engine. |
| `PUT` | Syncs: sends the manifest to the engine, and gives back its answer. `curl -X PUT https://your-app/api/flow`. |
| `GET` | Gives the manifest. Only for signed calls (the engine's **Add app** and **Resync**); otherwise `401`. |

## `new Flow(options)`

| Option | Env var | What it is |
| --- | --- | --- |
| `id` | | Required. The app ID: letters, digits, `-` and `_`, starting with a letter or digit, up to 64. |
| `signingKey` | `FLOW_SIGNING_KEY` | The app's signing key. |
| `signingKeyFallback` | `FLOW_SIGNING_KEY_FALLBACK` | The old key while you rotate. |
| `eventKey` | `FLOW_EVENT_KEY` | For `flow.send`. |
| `baseUrl` | `FLOW_BASE_URL` | The engine's URL. |
| `isDev` | `FLOW_DEV=1` | Turns off signature checks. Local tests only. |
| `fetch` | | The `fetch` to use. Default: the global one. |

A value in code wins over the env var. See [Settings](settings.md) for what each does
when it is not set.

## `flow.createFunction(options, trigger, handler)`

Gives back a function to pass to `serve`. It throws at once on a bad ID, no trigger,
or a bad trigger. The options are in [Functions and steps](functions.md#all-function-options);
the triggers in [Triggers](functions.md#triggers).

The handler gets `{ event, events, step, runId, attempt }`, and its return value is
the run's output.

`step` has:

| Method | Gives back |
| --- | --- |
| `step.run(id, fn)` | `fn`'s result. `fn` gets `{ stepId, idempotencyKey, attempt }`. |
| `step.sleep(id, duration)` | nothing |
| `step.sleepUntil(id, time)` | nothing. `time` is a `Date`, ms, or ISO text. |
| `step.waitForEvent(id, { event, timeout, match?, if? })` | the event, or `null` on timeout |
| `step.sendEvent(id, event or events)` | `{ ids }` |
| `step.invoke(id, { function, data?, timeout? })` | the child's return value |

Durations are text like `"500ms"`, `"30s"`, `"1h30m"`, `"3d"`, `"2w"` (units `ms`,
`s`, `m`, `h`, `d`, `w`, no spaces), or a number of ms.

## `flow.send(events, { env }?)`

Sends one event or a list of up to 100. Gives back `{ ids, status }`. Throws
`sending events failed (<status>): <engine error>` on any answer but `200`, and
`flow.send needs an event key (eventKey or FLOW_EVENT_KEY)` without a key. It does
not retry. See [Events](events.md).

## `flow.realtime`

| Method | What it does |
| --- | --- |
| `publish({ channel, topic, data }, { env }?)` | Sends `data` to the browsers on that topic. Throws on failure. |
| `token({ channel, topics }, { env }?)` | A token for one browser. Throws on failure. |

The browser side is `subscribe` from `@clevix/flow/realtime`, and `useRealtime` from
`@clevix/flow/react`. See [Realtime](realtime.md).

## Errors

| Class | Use |
| --- | --- |
| `NonRetriableError(message)` | Throw it to fail now, with no more tries. |
| `RetryAfterError(message, at)` | Throw it to try again at `at`: a `Date`, ms, or a duration like `"30s"`. |
| `StepError` | What a step call throws when the step failed for good. Has `name`, `message` and `stepId`. |

See [Errors and retries](errors.md).

## `serve(options)`

| Option | What it is |
| --- | --- |
| `client` | Your `Flow`. |
| `functions` | The functions to serve. Each `onFailure` adds its `<id>-failure` function. |
| `syncOnBoot` | Default `true`. The [sync at boot](production.md#sync-on-every-deploy). `false` turns it off. |
| `streaming` | Default on. `false`, or `{ heartbeatMs }` (default 20000). Lets a long step run behind a proxy that ends quiet calls. See [Protocol](protocol.md#streamed-answers-sdk-v060-and-later). |

`serve` throws at once if two functions have the same ID, or a function was made by
another `Flow`.

## Other exports

| Export | What |
| --- | --- |
| `DEFAULT_BASE_URL` | The engine URL used when none is set. |
| `SDK_VERSION` | This SDK's version. |
| `buildManifest`, `manifestHash` | Build the manifest and its hash, as sync sends them. |
| `hashStepId(id, n)` | The hashed ID of a step ID for its `n`th use. |
| Types | `FunctionOptions`, `Trigger`, `HandlerContext`, `StepTools`, `FlowFunction`, `FlowEvent`, `IncomingEvent`, `Json`, `RealtimeToken`, `RealtimeMessage`, and more. |

Subpaths: `@clevix/flow/cloudflare`, `@clevix/flow/hono`, `@clevix/flow/next`,
`@clevix/flow/express`, `@clevix/flow/realtime`, `@clevix/flow/react`.

Both SDKs speak the same protocol, so a TypeScript function can `step.invoke` a Go
function, and the other way round.
