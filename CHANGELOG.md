# Changelog

## v0.5.1

- **`FLOW_SERVE_URL` is back, as an optional setting** (TypeScript `serveUrl` on
  `new Flow({...})`, Go `ClientOpts.ServeURL`). It is the app's public URL, and it is
  used only as the `url` in the manifest (the `GET` answer and the `PUT` sync). Set
  it when a proxy in front of the app changes the host or the path (a Kubernetes
  ingress with `rewrite-target`, an API gateway stage prefix, nginx without
  `proxy_set_header Host`). With v0.5.0 such an app can not pass the Add app and
  Change URL check, which compares the signed manifest `url` (host and path) to the
  URL the admin typed. Only the app's own config sets it, and the answer is signed
  with the app's key, so a relay can not fake it. When it is not set, nothing
  changes: the SDKs send the URL the request shows, and still do not read
  `X-Forwarded-Host`. A value that is not a full `http` or `https` URL is refused
  (TypeScript: `500 BadServeUrl`; Go: `NewClient` fails).
- **Docs fix for v0.5.0:** the engine turns on "answers must be signed" for an app
  only when an admin's **Add app**, **Resync** or **Change URL** gets a signed
  answer, never from a normal call or a `PUT` sync (eadwinCode/clevix-worker#43).
  So a rolling deploy to v0.5.0 is safe: old copies of the app keep working while
  the deploy runs. Press **Resync** once when the deploy is done. A `PUT` from an
  SDK older than v0.5.0 still turns it off. The v0.5.0 entry below said the first
  signed answer turned it on; that was wrong after the engine change.

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
