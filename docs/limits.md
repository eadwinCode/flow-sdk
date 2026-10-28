# Limits

The engine's and the SDKs' limits, from their code. The engine checks most of them
when you sync, or when an event comes in.

## IDs and names

| What | Limit |
| --- | --- |
| App ID, function ID | 1-64 characters: letters, digits, `-`, `_`, starting with a letter or digit |
| Failure handler ID (`<id>-failure`) | also 64 characters, so `onFailure` needs a function ID of at most 56 |
| Event name | 1-256 characters; not starting with `inngest/` |
| Event `id` | up to 256 characters |
| Realtime channel | 1-256 characters: letters, digits, `:` `_` `-` `.` |
| Realtime topic | 1-64 characters: letters, digits, `_` `-` `.` |

## Events

| What | Limit |
| --- | --- |
| Events per request (`flow.send`, `POST /e`, `step.sendEvent`) | 100 |
| One event (all its fields, as JSON) | 1 MB |
| One request body | 10 MB |
| Events a second, per workspace | set by the plan; over it, `429` |

## Functions and runs

| What | Limit |
| --- | --- |
| Steps per run | 1000 |
| Retries per step (`retries`) | 0-20, default 4 |
| One call to your app (`timeouts.step`) | default 5 minutes; kept between 1 second and 14 minutes |
| A whole run (`timeouts.finish`) | no limit by default; at least 1 second |
| One step's result | 4 MB |
| The function's return value | 4 MB |
| Everything a run holds (events, step results, output) | 32 MB |
| Your app's answer to one call | 5 MB |
| `step.invoke` data | 1 MB |
| `cancelOn` entries per function | 5 |
| A `cancelOn` with no `timeout` | listens up to 366 days |
| `waitForEvent` look-back | events up to 1 hour before the wait |
| A run waiting for a down app | 7 days, then `AppUnavailable` |
| `step.sleep`, `step.sleepUntil` | no limit; a time in the past ends at once. A `cancelOn` with no `timeout` still stops listening after 366 days, and time asleep counts toward `timeouts.finish`. |
| An event `ts` in the future | no limit |
| Tags per function | 3; names up to 32 characters; a value over 256 characters is left out |
| Sync manifest | 1 MB |
| Expressions | 2048 characters, no regular expressions |

## Flow control

| What | Limit |
| --- | --- |
| Concurrency limits per function | 2 |
| Concurrency `limit` | 0 (no limit) to 100,000 |
| Throttle and rate limit `limit` | 1 to 100,000 |
| Throttle, rate limit and debounce periods | 1 second to 7 days |
| Batch size (`maxSize`) | 1 to 100 events |
| Batch `timeout` | 1 second to 1 hour |
| Batch total | 4 MB |
| Priority | -600 to 600 seconds |

## Keeping data

| What | How long |
| --- | --- |
| A sleeping or waiting run | while it is active: only ended runs are deleted |
| A completed or cancelled run | 3 days after it ends, unless kept |
| A failed run | 4 days after it ends, unless kept |
| Events (dashboard, event pages) | 4 days |
| An event `id` or `idempotency` value is caught | while the first run is kept |
| A pending signing key from **Add app** that no app connects with | 7 days |

## Finding runs

| What | Limit |
| --- | --- |
| `flow.runs.list` page (`limit`) | 1 to 200, default 50 |
| Tag filters in one list | 3 |
| Runs cancelled by tag in one call | 500, oldest first; `more` says there are more, and `next` goes on from there |
| How far `list` and `counts` lag the runs | a few seconds |
| Ended runs in `counts` | only since `since` (see [Keeping data](#keeping-data)) |

`flow.runs.singleton` and cancel by run ID or singleton key read the runs themselves,
with no lag.

## Realtime

| What | Limit |
| --- | --- |
| One publish (the whole body) | 64 KB |
| `publishMany` | 1 to 100 messages; the body up to 1 MB; each message's `data` up to 64 KB |
| Channels on one token or socket | 1 to 100, with up to 8,000 characters of names in all |

See also [Realtime](realtime.md#limits).

## Streams

| What | Limit |
| --- | --- |
| Stream ID | 1-256 characters: letters, digits, `:` `_` `.` `-`; not `.`, `..`, `token` or `connect` |
| One item, as JSON | 64 KB |
| Items per append | 100 |
| Request body | 1 MB |
| Items per stream | 20,000 |
| Bytes per stream | 32 MB |
| `ttl` (open) | 1 second to 7 days |
| `grace` (close) | 0 to 7 days |
| `meta`, as JSON | 4 KB |
| One snapshot page | 1000 items and about 4 MB (`snapshot` reads every page) |
| Readers (sockets) per stream | 1,000 |
| A reader token must connect within | 1 minute |
| A reader socket lasts | up to 1 hour; then the reader gets a new token and goes on |

The end item that `close` writes counts toward the limits, but is never refused for
them.

## Timing

| What | Time |
| --- | --- |
| A signed call's clock may be off by | 5 minutes |
| A revoked key stops working within | about 10 seconds |
| A sync reaches every engine machine within | about 10 seconds |
| The sync at boot checks again every | 5 minutes |
| Streamed answer heartbeat | 20 seconds |
| A concurrency slot of a crashed call is freed after | the step timeout plus 2 minutes |
| A realtime token must connect within | 1 minute |
| A realtime connection lasts | up to 1 hour |
| Browsers on one realtime channel | 1,000 |
| One realtime publish | 64 KB |

When a run's state is over 4 MB, the engine does not send it in each call: the SDK
loads it from the engine, at `FLOW_BASE_URL`. If you run your own engine, set
`FLOW_BASE_URL` in every app, even ones that never send events.
