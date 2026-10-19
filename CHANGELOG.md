# Changelog

## v0.4.0

- **Realtime.** Functions send live messages to browsers:
  `flow.realtime.publish()` / `client.Realtime().Publish()`, tokens for the browser
  with `flow.realtime.token()` / `client.Realtime().Token()`, and in the browser
  `subscribe()` from `@clevix/flow/realtime` or the `useRealtime()` hook from
  `@clevix/flow/react` (React is an optional peer dependency). See
  [docs/realtime.md](docs/realtime.md). Needs an engine with realtime.
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
