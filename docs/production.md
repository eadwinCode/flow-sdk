# Going to production

## Before the first deploy

- **Each app gets its own signing key.** Add the app in the dashboard (**Apps**,
  then **Add app**) to make it. A key works for its app only.
- **Each sender gets its own event key**, so you can revoke one without cutting off
  the others. A revoked key stops working within about 10 seconds.
- **Keys are secrets.** Put them in your host's secret store, never in code or in
  git. The engine keeps only a hash of each event key, so a lost key can not be shown
  again: make a new one.
- **Your endpoint must be a public `https` URL** with a host name: no IP address, no
  `localhost`, `.local` or `.internal` name, and not a `clevixstudio.com` host. The
  engine refuses other URLs, for example with `app url must use a host name, not an
  IP address`.
- **Do not set `FLOW_DEV=1`.** It turns off the signature check.

## Sync on every deploy

The engine only knows the functions from your last sync. The SDK syncs by itself when
the app starts (the **sync at boot**), so most apps need nothing more:

1. The SDK makes a hash of its manifest: every function with all its options, and the
   SDK's language and version (not the URL). So any change to a function, and an SDK
   upgrade, gives a new hash.
2. It asks the engine for the hash of the last sync, and sends its own:
   `GET {FLOW_BASE_URL}/apps/{appId}/sync?hash=...`, signed with the app's key.
3. If the two differ, and the engine's rolling-deploy guard is off (see below), it
   sends its manifest (`PUT .../sync`). Otherwise it does nothing.
4. It checks again every 5 minutes (the engine's `checkEveryMs`) while the app runs.
   So a copy that ends up as the only one left (a kept canary, say) still syncs, a
   few minutes later.

When it runs:

- **Node servers** (Express) and **Go** (`client.Serve()`): when the app starts,
  then on a timer. The Node timer does not keep the process alive. In Go, the first
  check waits 1 second; call `client.Close()` on shutdown to stop the checks.
- **Next.js**: on the first request, not when the module loads (`next build` loads
  route modules too, and must not sync before the deploy). On Vercel it runs in the
  request's `waitUntil`.
- **Cloudflare Workers** (and Hono on Workers): each isolate checks on its first
  request, then on the first request after each 5 minutes, in `ctx.waitUntil`. It
  never slows a request.

It runs in the background and never stops the app or a request. When it fails, it
logs a warning (`flow: sync check of app ...`), tries again in 5 minutes, and the app
runs as before. On a `404` (an older engine, or a wrong `FLOW_BASE_URL`) it asks
again only once an hour. During a key rotation it tries `FLOW_SIGNING_KEY_FALLBACK`
on a `401`. Without a signing key it does nothing. Turn it off with
`serve({ ..., syncOnBoot: false })` (TypeScript) or `ClientOpts{NoSyncOnBoot: true}`
(Go).

The sync at boot sends no URL: the engine keeps the URL it has. So a new app must be
added by URL in the dashboard first. Until then, the app logs
`the sync failed (400): invalid url`.

**Rolling deploys.** While a deploy runs, an old copy of the app can restart and try
to put its old functions back. So after a change, while copies with the new hash
still run (seen in the last 10 minutes), the engine keeps a guard on, and its check
answer has `retryAt`. While `retryAt` is set, the SDK does not `PUT`: it waits until
then and checks again. A `PUT` can still get `409 ManifestReplaced`; the SDK logs it
and waits the same way. So a rollback by deploy also syncs, a little later. To roll
back at once, click **Resync** in the dashboard.

### A backup in CI

A Worker that gets no traffic after a deploy does not sync until its first request.
If that matters (an app with only cron functions, say), sync as the last step of the
deploy, after the new code is live:

```bash
curl -fsS -X PUT https://shop.example.com/api/flow
```

A `PUT` to your endpoint makes the app send its manifest, with the URL of that
request, and gives back the engine's answer. `-f` makes curl fail on an error answer,
so your deploy fails too and you notice. A sync is safe to send more than once:

```json
{"ok":true,"created":false,"urlChanged":null,"modified":[],"archived":[]}
```

In GitHub Actions:

```yaml
- name: Deploy
  run: npx wrangler deploy
- name: Sync functions with the engine
  run: curl -fsS -X PUT https://shop.example.com/api/flow
```

If the app runs on several servers, one sync is enough. You can also click
**Resync** on the Apps page: the engine then asks the app for its functions at the URL
it has.

## What sync changes

- **New functions** start getting events. Other engine machines can take up to about
  10 seconds to see them.
- **Changed functions:** new runs use the new options. Runs already going keep the
  options they started with, but run your new code on their next step, so keep step
  IDs stable.
- **Functions no longer in your app are archived**, not deleted: they stop getting
  events and cron times, and their history stays. Add one back with the same ID and
  it comes back.
- **A renamed function** (a new ID) is a new function, and the old one is archived.
  Its runs that are still going call your app with the old ID and fail with
  `FunctionNotFound`. Let them finish first, or keep the old function for a while.
- **A new URL** from a `PUT` is taken, and the dashboard shows an alert so you notice
  if it was a mistake. To move an app on purpose, use **Change URL** on the Apps page.

## Keys

### Rotate the signing key

Each app has its own signing key. To replace it without any failed calls, open the
app's **Keys** on the Apps page (or the **Keys** page) and follow the four steps:

1. **New key.** The engine now takes the new key and the old one from this app, but
   still signs with the old one.
2. **Deploy the app** with `FLOW_SIGNING_KEY` = the new key and
   `FLOW_SIGNING_KEY_FALLBACK` = the old key. It now takes calls signed with either.
   The table shows which key the app last synced with.
3. **Promote** the new key. The engine signs this app's calls with it from now on.
4. **Revoke** the old key. Remove `FLOW_SIGNING_KEY_FALLBACK` at the app's next
   deploy.

Other apps are not touched. If a signing key leaks, do the same steps quickly. Only
Owners and Admins may promote and revoke keys.

### Event keys

The **Keys** page has a box per app, with its signing keys and its event keys.
**New event key** makes one; it is shown once.

## Runs in the dashboard

A run is in one of these states:

| State | Means |
| --- | --- |
| **Queued** | Made, not started yet (a future `ts`, or held by throttle) |
| **Running** | Working on a step |
| **Sleeping** | In `step.sleep` or `step.sleepUntil` |
| **Waiting** | In `waitForEvent`, or waiting for an invoked function |
| **Waiting for app** | The engine can not reach the app; the run goes on when it answers |
| **Paused** | Paused by hand |
| **Completed** | Done; the output is saved |
| **Failed** | Out of tries, or failed for good |
| **Cancelled** | Cancelled by `cancelOn`, singleton, `timeouts.finish`, or by hand |

What you can do:

- On a run: **Cancel**, **Pause** / **Resume** (it stops at the next step and goes on
  where it was), **Retry** (a failed or cancelled run, in place: finished steps keep
  their results), **Rerun** (a new run with the same event), **Rerun from here** on a
  step (a new run that keeps the results of the steps before it), and **Keep** (it is
  not deleted).
- On a function: **Pause** / **Resume** (while paused, new events and cron times are
  skipped, not saved), **Invoke** (start a run with data you type), **Trigger now**
  for a cron, and **Bulk actions**: replay failed runs, or cancel active runs, at
  most 500 per go.
- On an app: **Resync**, **Change URL**, **Pause all** / **Resume all**, **Delete**.

Runs are deleted 3 days after they end (4 days for failed runs), unless kept. Events
are kept 4 days.

## Troubleshooting

**Sync fails** (the answer to `curl -X PUT <app-url>`, or the app's log)

| Answer | Cause |
| --- | --- |
| `500 NoSigningKey` | The app has no `FLOW_SIGNING_KEY`. |
| `401 invalid signing key` | The key is wrong, revoked, or from another engine. |
| `403 this signing key belongs to another app` | The app has another app's key. Each app needs its own. |
| `403` with `AppLimitReached` | The account has as many apps as its plan allows. |
| `400 invalid url` | The engine does not know the app's URL. Add the app by URL in the dashboard first. |
| `400 app url must be https` | The `PUT` came in over `http`. Send it to the public `https` URL. Behind a proxy the app may see itself as `http`: add the app by URL in the dashboard, and the engine keeps that URL. |
| `400 function <id>: ...` | A bad option, cron or expression in that function. The message says which. |
| `409 ManifestReplaced` | A newer version of the app synced, and copies of it still run. See "Rolling deploys" above. |
| `502 SyncFailed` (TypeScript) / `500 SyncFailed` (Go) | The app could not reach the engine. If you run your own engine, check `FLOW_BASE_URL`. |

**Add app or Change URL is refused**

| Message | Cause |
| --- | --- |
| `the app at this URL says it is at ...` | The app named another URL than the one you typed. Something in between passes the calls on, or a proxy in front of the app does not pass the `Host` header on (nginx: `proxy_set_header Host $host;`). |
| `the answer's signature is wrong` | The answer was changed on the way, or the app at that URL has another signing key. |
| `... signs its answers, but this answer is not signed` | Something in between took the `X-Flow-Answer-Signature` header off. |

**An event starts no run**

- The function is not synced, or was archived. Check **Apps** in the dashboard.
- The event name does not match the trigger exactly (names are case-sensitive).
- The trigger's `if` is false for this event, or fails (a failing `if` counts as
  false).
- The function is paused.
- `rateLimit` dropped it, `idempotency` or the event `id` matched an earlier run, or
  `singleton` skipped it.
- `debounce` or `batchEvents` is still holding it.
- The workspace may start no runs (spent or suspended). The event API then answers
  `402` or `403`.

**Calls to the app fail**

| Error in the run | Cause |
| --- | --- |
| `401 Unauthorized` (`missing or invalid signature`) | The app has another signing key than the engine signs with for it, or its clock is more than 5 minutes off. During a rotation, set the fallback key. |
| `500 NoSigningKey` | The app has no `FLOW_SIGNING_KEY`. |
| `FunctionNotFound` | The engine called a function the app no longer has. Sync, or keep the old function until its runs end. |
| `TimeoutError` | One call took longer than `timeouts.step`. Split the work into more steps. |
| `FunctionTimeout` | The run took longer than `timeouts.finish`, and was cancelled. |
| `OutputTooLarge` | A step or the function returned more than 4 MB. Save big data elsewhere and return its ID. |
| `ResponseTooLarge` | The app's answer to one call was over 5 MB. |
| `StateOverflowed` | The run holds more than 32 MB in all. Return less from each step. |
| `StateLoadFailed` | The SDK could not load a big run's state from the engine. If you run your own engine, check `FLOW_BASE_URL`. It is retried. |
| `RedirectNotAllowed` | The app URL answers with a redirect. Use the final URL (watch for `www.` and a trailing `/`). |
| Express: 500 `BodyAlreadyParsed` | `express.json()` ran before the endpoint. See [TypeScript](typescript.md#express). |

**Runs show "Waiting for app"**

The engine could not reach the app at all (no answer, or the host answered 502, 503,
504, 521, 522, 523 or 530). That is not a failed try: the runs wait, and go on by
themselves when the app answers again. The Apps page shows the app as **Down**, with
the last error. A run that waits 7 days fails with `AppUnavailable`.

**A step ran twice.** That can happen when the app crashes, or the answer is lost,
after the step did its work. Pass the step's idempotency key to outside APIs. See
[Background jobs](background-jobs.md#a-step-runs-at-least-once).

## Upgrading the SDK

Read the [changelog](https://github.com/eadwinCode/flow-sdk/blob/main/CHANGELOG.md)
first. Then:

- TypeScript: change the version in both places of the `.tgz` URL, and install again.
- Go: `go get github.com/eadwinCode/flow-sdk@vX.Y.Z` and `go mod tidy`.

Deploy as usual: an SDK upgrade changes the manifest hash, so the app syncs at boot.
