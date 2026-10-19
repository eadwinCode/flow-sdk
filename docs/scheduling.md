# Scheduling: cron, sleeps and delayed runs

There are four ways to make something happen later:

| You want | Use |
| --- | --- |
| Run a function on a timetable (every hour, each Monday at 9:00) | a [cron trigger](#cron-triggers) |
| Pause in the middle of a run (send a reminder in 3 days) | [`step.sleep` / `step.sleepUntil`](#sleep-in-a-run) |
| Start a run at a set time, from an event | an event with a [future `ts`](#start-a-run-at-a-set-time) |
| Wait until something happens, or give up | [`step.waitForEvent`](functions.md#waitforevent-wait-for-something-to-happen) |

## Cron triggers

A cron trigger starts a run on a schedule.

```ts
const nightlyReport = flow.createFunction(
  { id: "nightly-report" },
  { cron: "TZ=Africa/Lagos 0 2 * * *" }, // 02:00 every day, Lagos time
  async ({ event, step }) => {
    // event.data.scheduledAt: the planned time of this run, in ms
    const day = new Date(event.data.scheduledAt).toISOString().slice(0, 10);
    await step.run("build", () => reports.build(day));
  },
);
```

```go
type Timer struct {
	Cron        string `json:"cron"`
	ScheduledAt int64  `json:"scheduledAt"`
}

_, err := flow.CreateFunction(client,
	flow.FunctionOpts{ID: "nightly-report"},
	flow.CronTrigger("TZ=Africa/Lagos 0 2 * * *"), // 02:00 every day, Lagos time
	func(ctx context.Context, in flow.Input[Timer]) (any, error) {
		day := time.UnixMilli(in.Event.Data.ScheduledAt).UTC().Format("2006-01-02")
		return step.Run(ctx, "build", func(ctx context.Context) (string, error) {
			return reports.Build(ctx, day)
		})
	},
)
if err != nil {
	log.Fatal(err)
}
```

A function can have a cron trigger and event triggers together, for example to run
nightly and also when someone asks for it:
`[{ cron: "0 2 * * *" }, { event: "report/requested" }]`.

### Cron syntax

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
| `0 9 * * 1` | Mondays at 09:00 |
| `0 0 1 * *` | the 1st of each month at midnight |
| `0 0 L * *` | the last day of each month at midnight |
| `0 12 * * 5#1` | the first Friday of each month at 12:00 |
| `@daily` | every day at midnight (also `@hourly`, `@weekly`, `@monthly`, `@yearly`) |

- `*` any value, `,` a list (`1,15`), `-` a range (`9-17`), `/` a step (`*/10`).
- `L` means "last" (last day of the month; `5L` = last Friday). `#` picks the nth
  weekday (`1#2` = second Monday).
- If you set both day of month and day of week, the run happens when **either**
  matches (the usual cron rule).
- A sixth field at the front adds seconds (`*/30 * * * * *` = every 30 seconds).
  Use it with care: each run is a full run with its own calls to your app.

### Time zones

Start the schedule with `TZ=<zone>` (or `CRON_TZ=<zone>`), using a name from the
[time zone list](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones):

```
TZ=Europe/Berlin 0 9 * * MON-FRI
TZ=America/New_York 30 17 * * *
```

Without a zone, the schedule is read in **UTC**. Always set the zone for schedules
that people care about ("9 AM for our users"), so daylight saving time is handled:
a time that does not exist that day (clocks jump forward) is skipped, and a time that
happens twice (clocks go back) runs once.

### What a cron run gets

The event is named `inngest/scheduled.timer`. Its `data` has `cron` (the schedule as
you wrote it, with the `TZ=` part) and `scheduledAt` (the planned time, ms). Use
`scheduledAt`, not the clock, when the run needs "which day is this for": a run can
start a little late, or be retried later.

### How schedules behave

- **Sync sets the schedule.** A new cron starts from its next time after the sync.
  A cron you did not change keeps its timetable. A cron you removed stops. A removed
  or archived function stops too.
- **Each time is one run.** The engine makes sure the same time never starts two
  runs.
- **Runs can overlap.** If a run is still going when the next time comes, a second
  run starts. If that is a problem, add
  [`singleton: { mode: "skip" }`](flow-control.md#singleton) (skip the new run) or
  [`concurrency: 1`](flow-control.md#concurrency) (one step at a time).
- **Missed times.** If the schedule could not fire for a while (for example the
  engine was down), it runs **once** for the latest missed time, then carries on. It
  does not run every missed time.
- **Paused function.** While the function is paused in the dashboard, its times are
  skipped, not saved for later.
- **Flow control.** `singleton`, `throttle`, `concurrency` and `priority` apply to
  cron runs. `rateLimit`, `debounce`, `batchEvents` and `idempotency` do not.
- **`if` does nothing on a cron trigger.** It is accepted, but not checked. Check the
  condition in the function instead.
- **Run it now.** The function's page in the dashboard has **Trigger cron now**. It
  starts one extra run, with `scheduledAt` set to now.
- A bad schedule or zone is rejected when you sync, with the message
  `function <id>: invalid cron ...`.

### Pattern: one run per user, on a schedule

A cron run that does work for every user is one big run: if it fails half way, the
retry is about everything. Better: let the cron run only send one event per user,
and let a second function do the work, one run per user.

```ts
flow.createFunction(
  { id: "digest-schedule" },
  { cron: "TZ=UTC 0 7 * * *" },
  async ({ step }) => {
    const ids = await step.run("list-users", () => db.listDigestUserIds());
    for (let i = 0; i < ids.length; i += 100) {
      await step.sendEvent(
        `fan-out-${i / 100}`,
        ids.slice(i, i + 100).map((userId: string) => ({ name: "digest/send", data: { userId } })),
      );
    }
  },
);

flow.createFunction(
  { id: "digest-send", concurrency: 10 },
  { event: "digest/send" },
  async ({ event, step }) => {
    await step.run("send", () => mailer.sendDigest(event.data.userId));
  },
);
```

Mind the 1000 steps per run: one `sendEvent` per 100 users gives room for 100,000
users.

## Sleep in a run

`step.sleep` pauses a run for a time, `step.sleepUntil` until a moment. Nothing runs
and nothing is held while it sleeps (not even a [concurrency](flow-control.md#concurrency)
slot), so long sleeps are fine.

```ts
await step.sleep("wait-3-days", "3d");
await step.sleepUntil("wait-for-trial-end", event.data.trialEndsAt); // Date, ms, or ISO text
```

```go
if err := step.Sleep(ctx, "wait-3-days", 72*time.Hour); err != nil {
	return nil, err
}
```

Durations in TypeScript are text like `"30s"`, `"15m"`, `"2h"`, `"1h30m"`, `"3d"`,
`"2w"` (units `ms`, `s`, `m`, `h`, `d`, `w`; no spaces), or a number of ms. In Go
they are `time.Duration`.

### Pattern: reminders until something happens

Combine sleeping and waiting: wait up to 3 days for the user to finish setup; if
they do not, remind them and wait again.

```ts
flow.createFunction(
  { id: "setup-reminders", cancelOn: [{ event: "user/deleted", match: "data.userId" }] },
  { event: "user/signed-up" },
  async ({ event, step }) => {
    for (let i = 0; i < 3; i++) {
      const done = await step.waitForEvent(`wait-setup-${i}`, {
        event: "user/setup-done",
        match: "data.userId",
        timeout: "3d",
      });
      if (done) return { reminders: i };
      await step.run(`remind-${i}`, () => mailer.remind(event.data.userId));
    }
    return { reminders: 3 };
  },
);
```

## Start a run at a set time

Send the event with `ts` in the future: the run is created now and starts then. It
shows as `queued` in the dashboard until it starts, and a `cancelOn` already works.

```ts
await flow.send({ name: "trial/ending", data: { userId }, ts: Date.parse("2026-11-01T09:00:00Z") });
```

See [events.md](events.md#start-a-run-later) for Go and the details.

| | Event with future `ts` | `step.sleep` in a run |
| --- | --- | --- |
| The run exists from | now (`queued`) | now (`sleeping`) |
| Can do work first | no | yes, steps before the sleep |
| Cancel it | `cancelOn`, or in the dashboard | the same |
| Works with debounce and batching | no | yes |

## Retry later

To try a step again at a set time (for example when an API says "come back in 30
seconds"), throw `RetryAfterError` (Go: `flow.RetryAtError`). See
[functions.md](functions.md#errors-and-retries).
