# Settings

Both SDKs read the same env vars. A value you pass in code (`new Flow({ ... })` or
`flow.ClientOpts{...}`) wins over the env var. An empty env var counts as not set.

| Env var | Code (TS / Go) | Default | When it is not set |
| --- | --- | --- | --- |
| `FLOW_SIGNING_KEY` | `signingKey` / `SigningKey` | none | The endpoint answers every request with `500 NoSigningKey` (unless dev mode). The sync at boot does nothing. Realtime calls get `401` from the engine. |
| `FLOW_SIGNING_KEY_FALLBACK` | `signingKeyFallback` / `SigningKeyFallback` | none | Only the main key is used. |
| `FLOW_EVENT_KEY` | `eventKey` / `EventKey` | none | Sending fails at once: `flow.send needs an event key (eventKey or FLOW_EVENT_KEY)` / `flow: no event key (set FLOW_EVENT_KEY or ClientOpts.EventKey)`. Serving works. |
| `FLOW_BASE_URL` | `baseUrl` / `BaseURL` | `https://worker.clevixstudio.com` in v0.6.5; `https://worker.flow.clevixstudio.com` from the next release | The default is used. |
| `FLOW_DEV` | `isDev` / `Dev` | off | Signatures are checked. Only the text `1` turns dev mode on. |

## What each one does

**`FLOW_SIGNING_KEY`** is the app's own signing key, `signkey-` and 64 hex
characters, from **Add app** in the dashboard. It is used to:

- check that each call to your endpoint (`POST`, `GET`) comes from the engine;
- sign the endpoint's answers;
- prove who the app is when it syncs, loads a big run's state, and publishes
  realtime messages.

A key that is not in the right form: TypeScript answers `500 NoSigningKey` with
`the signing key is not in the format signkey-<64 hex chars>`; Go's `NewClient`
gives an error.

**`FLOW_SIGNING_KEY_FALLBACK`** is the old key while you
[rotate](production.md#rotate-the-signing-key). Calls signed with either key are
taken. When the engine answers `401` to the main key (on sync or realtime), the SDK
tries the fallback.

**`FLOW_EVENT_KEY`** lets `flow.send` / `client.Send` send events. Only needed if the
app sends events. `step.sendEvent` inside a function does not need it.

**`FLOW_BASE_URL`** is the engine's address. Set it only for a local engine
(`http://127.0.0.1:8787`) or your own engine. The SDK uses it for sending events,
sync, realtime, and loading a run's state when it is over 4 MB.

**`FLOW_DEV=1`** turns off the signature check: the endpoint takes unsigned calls.
For a quick local test only. Never on a public app: anyone could start your
functions.

## Where the SDK looks

- **Node and Go:** the process environment.
- **Cloudflare Workers:** the handler's `env` first (wrangler secrets and `vars`),
  then `process.env`. `serve` gets `env` by itself. For `flow.send` and
  `flow.realtime`, pass it: `flow.send(event, { env })`.

On Workers:

```bash
wrangler secret put FLOW_SIGNING_KEY
wrangler secret put FLOW_EVENT_KEY
```

For your own engine, put its URL in `vars` in `wrangler.jsonc`:
`"vars": { "FLOW_BASE_URL": "https://flow.example.com" }`.

## Options that are not env vars

| TypeScript | Go | Default |
| --- | --- | --- |
| `serve({ syncOnBoot })` | `ClientOpts.NoSyncOnBoot` | sync at boot on |
| `serve({ streaming })` | `ClientOpts.NoStreaming`, `HeartbeatInterval` | streamed answers on, heartbeat 20 s |
| `new Flow({ fetch })` | `ClientOpts.HTTPClient` | the global `fetch` / `http.DefaultClient` |
