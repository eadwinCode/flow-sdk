# Changelog

## Unreleased

- **Sync at boot: a deploy needs no Resync.** When the app starts, both SDKs ask the
  engine for the hash of the app's last sync (`GET {base}/apps/{appId}/sync?hash=<own
  hash>`) and send the manifest (`PUT`) only when it is not their own. The hash covers
  every function's config and the SDK language and version, so an SDK upgrade syncs
  too. Go: at the first `client.Serve()`. Express: when `serve` is called. Next.js
  and Hono: on the first request. Cloudflare Workers: on the first request of each
  isolate, in `ctx.waitUntil`, so it never slows the request.
- **The check repeats** every `checkEveryMs` the engine gives (5 minutes), so a copy
  left on a new version (a kept canary) still syncs. Node: a timer that does not
  keep the process alive. Go: a goroutine, 1 second after `Serve`; new
  `client.Close()` stops it. Workers: the first request after that time. Next.js on
  Vercel: in the request's `waitUntil`. The check and its `PUT` try the fallback
  signing key on a `401`. It runs in the background, sends
  no URL (the engine keeps the one it has), and only logs when it fails. Needs an
  engine with `GET /apps/:id/sync`; with an older one it logs a warning and the app
  runs as before.
- **Rolling deploys:** while the engine's guard is on, its check answer has
  `retryAt`; the SDK then does not `PUT`, and checks again at that time. A `PUT` that
  still gets `409 ManifestReplaced` is logged as a warning and handled the same way.
  So a rollback by deploy still syncs, a little later.
- New option to turn it off: `serve({ ..., syncOnBoot: false })` (TypeScript),
  `ClientOpts.NoSyncOnBoot` (Go).
- The manifest (`PUT` sync body and `GET` answer) has a new `manifestHash` field:
  `v1:` and the sha256 of its SDK and functions. New: `manifestHash()` (TypeScript),
  `client.ManifestHash()` (Go), and `AppManifest.ManifestHash` (Go). In Go,
  `AppManifest.URL` is now left out of the JSON when empty.
- The Cloudflare adapter now passes `ctx` on, and the fetch handler takes it as a
  third argument (`handler(request, env, ctx)`).
- A Worker with no traffic after a deploy syncs only on its first request. If that
  matters (for example, an app with only cron functions), keep
  `curl -X PUT <app-url>` as the last step of the deploy. See
  [docs/production.md](docs/production.md#sync-on-every-deploy).

## v0.6.0

- **Streamed answers: long steps behind a proxy.** Cloudflare's proxy ends a call
  that sends nothing for about 100 seconds (`524`), and nginx stops after 60. When
  the engine asks (`X-Flow-Stream: 1`), both SDKs now answer `200` at once, send a
  `\n` heartbeat every 20 seconds while the function runs, and send the real answer
  (status, retry headers, signature, body) at the end. So a step can run up to its
  step timeout behind a proxy or a tunnel. See "Streamed answers" in
  [docs/protocol.md](docs/protocol.md). Works with older engines: they do not ask,
  so the SDK answers as before.
- New options: `serve({ ..., streaming: false | { heartbeatMs } })` (TypeScript),
  `ClientOpts.NoStreaming` and `ClientOpts.HeartbeatInterval` (Go).
- `@clevix/protocol`: `HEADERS.stream`, `streamedAnswerTail`, `parseStreamedAnswer`,
  `STREAM_ANSWER_HEADERS`, `STREAM_HEARTBEAT`, `DEFAULT_HEARTBEAT_MS`.
- The Express adapter now sends answers chunk by chunk instead of all at once.

## Unreleased (docs only)

- **Docs fix for v0.5.0:** the engine turns on "answers must be signed" for an app
  only when an admin's **Add app**, **Resync** or **Change URL** gets a signed
  answer, never from a normal call or a `PUT` sync (eadwinCode/clevix-worker#43).
  So a rolling deploy to v0.5.0 is safe: old copies of the app keep working while
  the deploy runs. Press **Resync** once when the deploy is done. A `PUT` from an
  SDK older than v0.5.0 still turns it off. The v0.5.0 entry below said the first
  signed answer turned it on; that was wrong after the engine change.
- **Going back to an SDK older than v0.5.0:** send the app's `PUT` sync at once
  (`curl -X PUT https://app/api/flow`). Until then the engine refuses its unsigned
  answers (steps that already ran may run again), and **Resync** can not turn the
  check off. The engine may keep the old setting for up to 10 seconds.
- Add app, Resync and Change URL also refuse an unsigned answer when the app's last
  sync said SDK v0.5.0 or later, so a relay can not strip the header and say the app
  runs an older SDK. The one case the engine can not catch is a new app's very first
  Add app.

## v0.5.0

- **Signed answers.** Both SDKs sign every answer to a signed call (the manifest
  `GET`, and every `POST` answer) with `X-Flow-Answer-Signature`, using the key that
  passed the call. The engine checks it, so a relay at a wrong URL can not change a
  manifest or a step result, and Add app and Change URL can check that the app is
  really at the URL typed in. See "Answer signature" in
  [docs/protocol.md](docs/protocol.md). Needs a proxy in front of the app to pass the
  `Host` header on, for Add app and Change URL.
  Works with older engines (they ignore the header). Once an engine has seen a
  signed answer from an app, it refuses unsigned ones; to go back to an older SDK,
  sync with `PUT` after the downgrade.
- New in `@clevix/protocol`: `signAnswer`, `verifyAnswer`, `matchSignature`
  (`verifySignature` that says which key matched), `HEADERS.answerSignature`.

## v0.4.0

- **Realtime.** Functions send live messages to browsers:
  `flow.realtime.publish()` / `client.Realtime().Publish()`, tokens for the browser
  with `flow.realtime.token()` / `client.Realtime().Token()`, and in the browser
  `subscribe()` from `@clevix/flow/realtime` or the `useRealtime()` hook from
  `@clevix/flow/react` (React is an optional peer dependency). See
  [docs/realtime.md](docs/realtime.md). Needs an engine with realtime
  (eadwinCode/clevix-worker#39) and its `REALTIME_TOKEN_SECRET` set.
  A token holds **one open socket at a time**: get a new token for every connect
  (`subscribe()` and `useRealtime()` do). Do not cache or share a token between
  tabs; the second connect fails and keeps retrying.
- **`timeouts.finish`** (Go: `Timeouts.Finish`): the longest a whole run may take,
  counted from its first step call. A run still going then is cancelled with
  `FunctionTimeout`. Needs an engine that has it; an older engine ignores it.
- Docs: the engine now sends `inngest/function.cancelled` when a run is cancelled,
  with the same data as `inngest/function.failed`.

## v0.3.0

- **Apps are added by URL.** In the engine's dashboard, **Apps → Add app** makes the
  app's own signing key (shown once), and then the engine calls the app's endpoint
  to read its functions. The new flow: Add app → copy the key into the app as
  `FLOW_SIGNING_KEY` → deploy the app → Connect. See
  [docs/getting-started.md](docs/getting-started.md).
- **One signing key per app.** No SDK change: each app gets its own
  `FLOW_SIGNING_KEY`, and `FLOW_SIGNING_KEY_FALLBACK` while you rotate that app's
  key. An app's key can not sync another app. Needs an engine with per-app keys.
- **`FLOW_SERVE_URL` and the `serveUrl` / `ServeURL` option are gone.** The engine
  already knows the app's URL. A `PUT` sync sends the URL of the request it got
  (origin and path), as before when the setting was not set. Remove the variable
  from your apps; it is ignored.
- **`FLOW_BASE_URL` defaults to `https://worker.clevixstudio.com`** (option, then the
  env var, then the default; empty counts as not set). Set it only if you run your
  own engine. New exports: `DEFAULT_BASE_URL` (TypeScript), `flow.DefaultBaseURL` (Go).
  The `500 NoBaseUrl` answer to a sync is gone.

## v0.2.0

- **New signing key format: `signkey-<64 hex>`.** The engine no longer has
  environments, so keys no longer carry one (was `signkey-<env>-<64 hex>`).
  Both SDKs refuse the old format, and SDK v0.1.0 refuses the new one.
  Upgrade an app together with its new `FLOW_SIGNING_KEY`, made in the
  dashboard of an engine that has this change.
- The sync answer has no `env` field.
- The SDK code now lives in this repo. `@clevix/protocol` is released here too,
  for the engine.

## v0.1.0

- First release: the Go SDK and `@clevix/flow`.
