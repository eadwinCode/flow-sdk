# Running in production

- [Sync on every deploy](#sync-on-every-deploy)
- [What sync changes](#what-sync-changes)
- [Keys](#keys): rotate the signing key, event keys
- [Runs in the dashboard](#runs-in-the-dashboard)
- [Limits](#limits)
- [Troubleshooting](#troubleshooting)
- [Upgrading the SDK](#upgrading-the-sdk)

## Sync on every deploy

The engine only knows the functions from your last sync. Make sync the last step of
every deploy, after the new code is live:

```bash
curl -fsS -X PUT https://shop.example.com/api/flow
```

`-f` makes curl fail on an error answer, so your deploy fails too and you notice.
Instead of `curl`, you can press **Resync** on the Apps page: the engine then asks
the app for its functions at the URL it was added with.

In GitHub Actions:

```yaml
- name: Deploy
  run: npx wrangler deploy
- name: Sync functions with the engine
  run: curl -fsS -X PUT https://shop.example.com/api/flow
```

If the app runs on several servers, one sync is enough. Any server can answer it.

## What sync changes

- **New functions** start getting events (other engine machines can take up to about
  10 seconds to see them).
- **Changed functions**: new runs use the new options. Runs already going keep the
  options they started with (retries, timeout, `cancelOn`, flow control). They do
  run your new code on their next step, so keep step IDs stable.
- **Functions no longer in your app are archived**, not deleted: they stop getting
  events and cron times, and their history stays. If you add one back with the same
  ID, it comes back.
- **Renaming a function** (a new ID) is a new function. The old one is archived. Its
  runs that are still going call your app with the old ID and fail with
  `FunctionNotFound`, so let them finish first, or keep the old function for a while.
- **A new URL** for the app is accepted, and the dashboard shows an alert so you
  notice if it was a mistake.
- The app URL must be `https`.

The answer to sync looks like:

```json
{ "ok": true, "created": false, "urlChanged": null, "modified": ["shop-send-receipt"], "archived": [] }
```

## Keys

### The signing key

Each app has its own signing key, made when you add the app (**Apps → Add app**). The
engine signs its calls to the app with it, and the app syncs with it. An app's key
works for that app only: it can not sync another app or read another app's runs.
To replace an app's key without any failed calls:

1. In the dashboard, open the app's **Keys** (on the Apps page) and click **New key**.
   The engine now accepts the new key and the old one from this app, but still
   signs with the old one.
2. Deploy the app with `FLOW_SIGNING_KEY` = the new key and
   `FLOW_SIGNING_KEY_FALLBACK` = the old key. It now accepts calls signed with
   either. The table shows which key the app last synced with.
3. **Promote** the new key. The engine signs this app's calls with it from now on.
4. **Revoke** the old key. Remove `FLOW_SIGNING_KEY_FALLBACK` at the app's next
   deploy.

Other apps are not touched.

If a signing key leaks, do the same steps quickly.

### Event keys

Make one event key per sender (each app, each outside service), so you can revoke
one without cutting off the others. A revoked key stops working within about
10 seconds. The engine stores only a hash of each key, so a lost key cannot be shown
again: make a new one.

## Runs in the dashboard

A run is in one of these states:

| State | Means |
| --- | --- |
| `queued` | Made, not started yet (a future `ts`, or held by throttle) |
| `running` | Working on a step |
| `sleeping` | In `step.sleep` or `step.sleepUntil` |
| `waiting` | In `waitForEvent`, or waiting for an invoked function |
| `paused` | Paused by hand |
| `completed` | Done; the output is saved |
| `failed` | Ran out of retries, or failed for good |
| `cancelled` | Cancelled by `cancelOn`, singleton, or by hand |

What you can do there:

- **Cancel** a run that has not ended. Or cancel many at once from the function's
  page (up to 500 per click).
- **Pause / resume** a run. It stops at the next step and goes on where it was.
- **Pause a function** (or a whole app). While paused, new events and cron times
  are **skipped**, not saved. Runs already going are paused too.
- **Retry** a failed or cancelled run: it runs again in place. Finished steps keep
  their results; only failed steps run again.
- **Rerun from a step**: a new run that keeps the results of the steps before the
  one you pick, and runs from there.
- **Replay** many failed runs at once from the function's page.
- **Keep** a run so it is not deleted.

Runs are deleted 3 days after they end (4 days for failed runs), unless kept.
Events are kept 4 days.

## Limits

| What | Limit |
| --- | --- |
| App ID, function ID | 1-64 characters: letters, digits, `-`, `_`, starting with a letter or digit |
| Step ID | 1-256 characters |
| Steps per run | 1000 |
| Retries per step | 0-20 (default 4) |
| One call to your app (`timeouts.step`) | default 5 min, between 1 s and 14 min |
| A whole run (`timeouts.finish`) | no limit by default, at least 1 s |
| One step's result | 4 MB |
| A run's output (what the function returns) | 4 MB |
| Everything a run holds (events + step results + output) | 32 MB |
| Your app's answer to one call | 5 MB |
| One event | 1 MB |
| Events per request / per `sendEvent` | 100 |
| `step.invoke` data | 1 MB |
| `cancelOn` entries | 5 |
| Concurrency limits per function | 2 |
| Batch size | 100 events, 4 MB |
| Expressions | 2048 characters |
| Sync manifest | 1 MB |

When a run's state passes 4 MB, the engine stops sending it in each call, and the
SDK loads it from the engine instead, at `FLOW_BASE_URL` (default
`https://worker.clevixstudio.com`). If you run your own engine, set it in every app,
even ones that never send events.

## Troubleshooting

**Sync fails**

| Answer | Cause |
| --- | --- |
| `500 NoSigningKey` | The app is missing `FLOW_SIGNING_KEY`. |
| `401 invalid signing key` | The key is wrong, revoked, or from another engine. |
| `403 this signing key belongs to another app` | The app has another app's key. Each app needs its own (Add app). |
| `400 app url must be https` | The sync sent the URL of the request it got, and it is not `https`. Send the `PUT` to the public `https` URL. Behind a proxy the request may look like `http`: add the app by URL in the dashboard, and the engine keeps that URL. |
| `400 function <id>: ...` | A bad option, cron or expression in that function. The message says which. |
| `502 SyncFailed` | The app could not reach the engine. If you run your own engine, check `FLOW_BASE_URL`. |

**An event starts no run**

- The function is not synced, or was archived. Check **Apps** in the dashboard.
- The event name does not match the trigger exactly (names are case-sensitive).
- The trigger's `if` is false for this event, or fails (a failing `if` counts as
  false).
- The function is paused.
- `rateLimit` dropped it, `idempotency` or the event `id` matched an earlier run, or
  `singleton: skip` skipped it.
- `debounce` or `batchEvents` is still holding it.

**Calls to the app fail**

| Error in the run | Cause |
| --- | --- |
| `401 Unauthorized` (missing or invalid signature) | The app has a different signing key than the engine signs with for it, or its clock is more than 5 minutes off. During key rotation, set the fallback key. |
| `500 NoSigningKey` | The app has no `FLOW_SIGNING_KEY`. |
| `FunctionNotFound` | The engine called a function the app no longer has. Sync, or keep the old function until its runs end. |
| `TimeoutError` | One call took longer than `timeouts.step`. Split the work into more steps. |
| `FunctionTimeout` | The run took longer than `timeouts.finish` and was cancelled. |
| `OutputTooLarge` | A step or the function returned more than 4 MB. Save big data elsewhere (a bucket, a database) and return its ID. |
| `StateOverflowed` | The run holds more than 32 MB in all. Return less from each step. |
| `StateLoadFailed` | The SDK could not load a big run's state. If you run your own engine, check `FLOW_BASE_URL`. It is retried. |
| `RedirectNotAllowed` | The app URL answers with a redirect. Sync the final URL (watch out for `www.` and trailing `/`). |
| Express: 500 about the body | `express.json()` ran before the adapter. See [typescript.md](typescript.md#other-frameworks). |

**Runs show "Waiting for app"**

The engine could not reach the app at all (it did not answer, or its host answered
502, 503, 504, or Cloudflare's 521, 522, 523 or 530). That is not a failed attempt:
the runs wait, and go on by themselves when the app answers again. The Apps page
shows the app as **Down**, with the last error. Fix the app, or press **Resync**. A
run that waits 7 days fails with `AppUnavailable`. A cron function keeps only its
newest waiting run.

**A step ran twice.** That can happen: when the app crashes, or the answer is lost,
after the step did its work. Use the step's idempotency key with outside APIs (see
[functions.md](functions.md#run-do-some-work-once)).

## Upgrading the SDK

Read the [changelog](../CHANGELOG.md) first. Then:

- TypeScript: change the version in both places of the `.tgz` URL and install.
- Go: `go get github.com/eadwinCode/flow-sdk@vX.Y.Z` and `go mod tidy`.

Deploy and sync as usual. If the changelog says a version needs a newer engine, the
engine must be updated first.
