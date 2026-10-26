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
| A completed or cancelled run | 3 days after it ends, unless kept |
| A failed run | 4 days after it ends, unless kept |
| Events (dashboard, event pages) | 4 days |
| An event `id` or `idempotency` value is caught | while the first run is kept |
| A pending signing key from **Add app** that no app connects with | 7 days |

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
