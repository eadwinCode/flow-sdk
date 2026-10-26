# Crons and scheduled jobs

## The problem

Some work runs on a timetable: a report every night, a digest every Monday. Other
work runs at a set time: a reminder before a meeting, an email 3 days before a trial
ends. A plain cron job on a server is easy to start, but:

- if the server is down at that minute, the job does not run;
- if the job fails half way, nobody tries again;
- one job for all users is one big job: one bad user stops the rest.

## The shape of the solution

Clevix Flow has four tools for time:

| You want | Use |
| --- | --- |
| Run on a timetable (every night, each Monday at 07:00) | a [cron trigger](#cron-triggers) |
| One run at a set time, started from your code | an event with a [future `ts`](#run-once-at-a-set-time) |
| Wait in the middle of a run ("3 days before the trial ends") | [`step.sleep` / `step.sleepUntil`](#wait-inside-a-run) |
| Try a step again later, at a time you pick | [`RetryAfterError`](#retry-later) |

The code is in the repo:
[`examples/ts/crons.ts`](https://github.com/eadwinCode/flow-sdk/blob/main/examples/ts/crons.ts)
and [`examples/go/crons/main.go`](https://github.com/eadwinCode/flow-sdk/blob/main/examples/go/crons/main.go).

## Cron triggers

A cron trigger starts a run on a schedule. The engine keeps the schedule; your app
does not need to be awake at that minute, only to answer when the engine calls.

::: code-group
<<< @/../examples/ts/crons.ts#nightly [TypeScript]
<<< @/../examples/go/crons/main.go#nightly [Go]
:::

The run's event is named `inngest/scheduled.timer`. Its `data` has `cron` (the
schedule as you wrote it) and `scheduledAt` (the planned time, in ms). Use
`scheduledAt` for "which day is this run for": a run can start a little late, or be
retried later, and then the clock says another time.

A function can have a cron trigger and event triggers together, for example to run
each night and also when someone asks:
`[{ cron: "0 2 * * *" }, { event: "report/requested" }]` (Go:
`flow.MultipleTriggers{flow.CronTrigger("0 2 * * *"), flow.EventTrigger("report/requested", nil)}`).

### The cron format

Five fields: minute, hour, day of month, month, day of week.

```
┌───────── minute (0-59)
│ ┌─────── hour (0-23)
│ │ ┌───── day of month (1-31)
│ │ │ ┌─── month (1-12 or JAN-DEC)
│ │ │ │ ┌─ day of week (0-7 or SUN-SAT; 0 and 7 are Sunday)
│ │ │ │ │
* * * * *
```

| Schedule | Means |
| --- | --- |
| `*/15 * * * *` | every 15 minutes |
| `0 * * * *` | every hour, on the hour |
| `30 8 * * *` | every day at 08:30 |
| `0 9 * * MON-FRI` | weekdays at 09:00 |
| `0 0 1 * *` | the 1st of each month at midnight |
| `0 0 L * *` | the last day of each month at midnight |
| `0 12 * * 5#1` | the first Friday of each month at 12:00 |
| `@daily` | every day at midnight (also `@hourly`, `@weekly`, `@monthly`, `@yearly`) |

- `*` is any value, `,` a list (`1,15`), `-` a range (`9-17`), `/` a step (`*/10`).
- A sixth field at the front adds seconds: `*/30 * * * * *` is every 30 seconds.
  Each one is a full run, with its own calls to your app.

### Time zones

Without a zone, the schedule is in **UTC**. Put `TZ=<zone>` (or `CRON_TZ=<zone>`) in
front, with a name from the
[time zone list](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones):

```
TZ=Europe/Paris 0 2 * * *
CRON_TZ=Asia/Tokyo 0 9 * * MON-FRI
```

Set the zone for schedules people care about ("9 AM for our users"): the engine then
follows daylight saving time. For example, `TZ=Europe/Paris 0 2 * * *` synced on
26 October 2026 had its next run at 01:00 UTC, which is 02:00 in Paris after the
clocks went back.

### Check your schedule

The engine checks every cron when you sync. A bad one is refused, and the sync
answer names the function:

```
function f: invalid cron "0 25 * * *": CronPattern: Invalid value for hour: 25
```

The function's page in the dashboard shows each cron with its **Next run** time, and
has **Trigger now**: one extra run, now, outside the schedule. Its `scheduledAt` is
the time you clicked.

## One run per user, on a schedule

One cron run that works through every user is one big run. If it fails half way,
the retry is about everything, and it hits the limit of 1000 steps per run. Better:
the cron run only sends one event per user, and a second function does the work, one
run per user.

::: code-group
<<< @/../examples/ts/crons.ts#fan-out [TypeScript]
<<< @/../examples/go/crons/main.go#fan-out [Go]
:::

- `step.sendEvent` (Go: `step.Send`) sends up to 100 events per call, and sends them
  once, even though the function runs from the top on each call. Use one step per
  chunk, each with its own ID.
- `concurrency: { limit: 10 }` on `send-digest` keeps 10 emails going at a time.

With **Trigger now** on a local engine, `weekly-digest` made two `send-chunk` steps
and 120 `send-digest` runs, and each one completed.

## How schedules behave

- **Sync sets the schedule.** A new cron starts from its next time after the sync. A
  cron you did not change keeps its timetable through a deploy. A cron you removed
  stops. A function you removed (archived) stops.
- **Each time starts one run.** The run's ID comes from the function, the cron and the
  time, so the same time never starts two runs.
- **Missed times.** If the engine could not fire for a while, it runs **once**, for the
  latest missed time, then goes on. It does not run every missed time.
- **Paused function.** While a function is paused (**Pause** on its page), its times
  are skipped, not saved for later. We paused an every-minute cron for one minute:
  that minute had no run, and the next minute ran as normal.
- **Your app is down.** The run waits for the app (**Waiting for app**). A cron
  function keeps only its newest waiting run; an older one ends with "A newer cron
  run replaced this one while the app was down".
- **Runs can overlap.** If a run is still going when the next time comes, a second run
  starts. To skip the new one, add `singleton: { mode: "skip" }`
  ([Flow control](flow-control.md#singleton)).
- **Flow control:** `singleton`, `throttle`, `concurrency` and `priority` apply to cron
  runs. `rateLimit`, `debounce`, `batchEvents` and `idempotency` do not.
- **No `if` on a cron trigger.** The sync refuses it with
  `function <id>: if is not supported on cron triggers`. Check the condition in the
  function instead.
- **A spent or suspended workspace** skips its cron times until it is active again.

## Run once at a set time

Send the event now, with `ts` (Go: `Timestamp`) set to the time in ms. The engine
makes the run at once, as **Queued**, and starts it at that time.

::: code-group
<<< @/../examples/ts/crons.ts#at-a-time [TypeScript]
<<< @/../examples/go/crons/main.go#at-a-time [Go]
:::

The route answers `400` when `at` is missing or is not a date. Check it yourself: a
missing `at` would give a `ts` that is not a number (TypeScript), or the zero time,
which is long past, so the run would start at once (Go).

On a local engine, a reminder sent for 20 seconds later was **Queued** at first, then
**Completed** at that time.

This does not work for a function with `debounce` or `batchEvents`: they start when
their own timer says. A `cancelOn` on the function already works while the run
waits.

## Wait inside a run

`step.sleep` pauses a run for a time; `step.sleepUntil` until a moment. Nothing runs
while it sleeps, and no concurrency slot is held, so long sleeps are fine. Here a run
sends an email 3 days before a trial ends, then ends the trial:

::: code-group
<<< @/../examples/ts/crons.ts#trial [TypeScript]
<<< @/../examples/go/crons/main.go#trial [Go]
:::

- `cancelOn` ends the run when `trial/converted` comes for the same user. On a local
  engine, a run that was sleeping in `wait-until-the-end` ended as **Cancelled** with
  `cancelled by event trial/converted (evt_...)`, and its sleep step was cancelled
  with it.
- `sleepUntil` takes a `Date`, ms since 1970, or ISO date text (Go: a `time.Time`).
  `sleep` takes text like `"30s"`, `"15m"`, `"2h"`, `"1h30m"`, `"3d"`, `"2w"` or ms as
  a number (Go: a `time.Duration`).
- A time in the past does not wait.

Which one to use:

| | Event with a future `ts` | `step.sleep` in a run |
| --- | --- | --- |
| The run exists from | now (**Queued**) | now (**Sleeping**) |
| Can do work first | no | yes, the steps before the sleep |
| Cancel it | `cancelOn`, or in the dashboard | the same |
| Works with debounce and batching | no | yes |

## Retry later

When an API says "come back in 20 seconds", throw `RetryAfterError` from the step
(Go: return `flow.RetryAtError(err, at)`). The engine tries that step again at that
time, not on its normal schedule.

::: code-group
<<< @/../examples/ts/errors.ts#retry-after [TypeScript]
<<< @/../examples/go/errors/main.go#retry-after [Go]
:::

On a local engine, the first try of `push-to-crm` got the pretend `429`, and the next
try ran 20 seconds later and completed. It still counts as a try: a step out of tries
fails as usual.

## Limits and gotchas

- **Cron on Workers with no traffic.** An app syncs its functions when it starts. On
  Cloudflare Workers, that is on the first request after a deploy. An app with only
  cron functions may get no request, so add a `PUT` sync to your deploy. See
  [Going to production](production.md#a-backup-in-ci).
- **A paused function skips its times.** They do not run later.
- **Sleeps are as long as you like**, but a run is deleted 3 days after it ends (4
  days if it failed), unless you **Keep** it.
- **Each cron run is a full run.** A cron every second is a run every second, with
  calls to your app.
