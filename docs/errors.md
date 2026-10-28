# Errors and retries

What the engine does when your code fails, and how you change it. All the code is in
[`examples/ts/errors.ts`](https://github.com/eadwinCode/flow-sdk/blob/main/examples/ts/errors.ts)
and [`examples/go/errors/main.go`](https://github.com/eadwinCode/flow-sdk/blob/main/examples/go/errors/main.go).

## A failed step is tried again

A step **fails** when its callback throws (Go: returns an error, or panics). The
engine then **retries** that step: it waits, then calls your app again. Steps that are
done keep their results and do not run again.

- Each step gets `retries + 1` tries. `retries` is a function option: default **4**,
  from 0 to 20. It counts per step: every step gets its own tries.
- The wait between tries doubles: about 1 s, 2 s, 4 s, 8 s and so on, up to 1 hour.
  Each wait is cut by a random part (to between half and all of it), so many failing
  runs do not all retry at the same moment. On a local engine, the waits between the
  four tries of a failing step were 0.8 s, 1.9 s and 3.4 s.
- An error **outside** a step (in the function body) fails that call, and the engine
  retries the call the same way.

The dashboard shows each failed try of a step, with its error, under **Failed tries**
on the step.

## When a step runs out of tries

The step's error comes back into your function: the step call throws a `StepError`
(Go: returns a `*step.StepError`). It has the step's error name and message. If you
do not catch it, the run ends as **Failed**.

Catch it to undo earlier work. Put the undo in a step of its own:

::: code-group
<<< @/../examples/ts/errors.ts#compensate [TypeScript]
<<< @/../examples/go/errors/main.go#compensate [Go]
:::

On a local engine, a card set to fail every time used all 4 tries of `charge-card`;
then `release-stock` ran, and the run **Completed** with
`{"status": "payment-failed", "reason": "the payment API timed out"}`.

In TypeScript, catch only what you mean to: rethrow anything that is not a
`StepError`. In Go, if you `recover()` around step calls, call `step.Repanic(r)`
first.

## Stop retrying

When trying again can not help (bad input, a record that is gone), throw
`NonRetriableError` (Go: wrap the error with `flow.NoRetryError(err)`).

- **In a step:** the step fails at once, with no more tries. The `StepError` comes
  back into your function as above. On a local engine, a declined card failed
  `charge-card` after 1 try, and `release-stock` ran.
- **Outside a step:** the run fails at once.

```ts
import { NonRetriableError } from "@clevix/flow";

throw new NonRetriableError("no such user");
```

```go
return nil, flow.NoRetryError(errors.New("no such user"))
```

## Retry later

When an API tells you when to come back, throw `RetryAfterError` with a time (Go:
`flow.RetryAtError(err, at)`). The engine tries the step again at that time.

::: code-group
<<< @/../examples/ts/errors.ts#retry-after [TypeScript]
<<< @/../examples/go/errors/main.go#retry-after [Go]
:::

In TypeScript the time is a `Date`, ms since 1970, or a duration from now like
`"30s"`. It still counts as a try.

## When a run fails for good

TypeScript: the `onFailure` option runs after a run fails for good (all tries used,
or a `NonRetriableError`).

::: code-group
<<< @/../examples/ts/errors.ts#on-failure [TypeScript]
<<< @/../examples/go/errors/main.go#on-failure [Go]
:::

How it works: when a run fails, the engine sends the event `inngest/function.failed`.
`onFailure` is a second function, with the ID `<id>-failure` (here
`import-users-failure`), whose trigger is that event, for this function only. Its
event's `data` has:

| Field | What |
| --- | --- |
| `function_id` | The failed function, as `<appId>-<functionId>` |
| `run_id` | The failed run |
| `error` | `name`, `message` and `stack` |
| `event` | The event that started the failed run |
| `attempts` | How many times the call that failed the run was tried. A `NonRetriableError` in a step gives `1`. `0` when the run failed with no failed try, for example when its state grew too large. In TypeScript, `onFailure` also gets it as `attempts`. |

Go has no `onFailure` option: make that second function yourself, as above. On a local
engine, the empty file failed `import-users` at once, and the handler posted
`import of empty-users.csv failed: empty-users.csv is empty`.

- It runs only when a run ends **Failed**, never when it is **Cancelled**. Runs
  started by `step.invoke` count too.
- To act on a cancelled run, trigger a function on `inngest/function.cancelled`, the
  same way. Its `data` has the same fields but `attempts`; `error` is there when the
  cancel had a reason. A run that passes `timeouts.finish` is cancelled, so it sends
  this event, not the failed one.
- A run started by one of these two events sends neither, so a handler that fails
  can not start itself again.

## Timeouts

::: code-group
<<< @/../examples/ts/errors.ts#timeouts [TypeScript]
<<< @/../examples/go/errors/main.go#timeouts [Go]
:::

- **`timeouts.step`** limits how long one call to your app may take. Default 5
  minutes; any value is kept between 1 second and 14 minutes. A call that takes
  longer fails with `TimeoutError`, and is retried like any other failure. For longer
  work, split it into more steps.
- **`timeouts.finish`** limits how long the whole run may take, counted from its
  first call to your app. Time spent queued before that does not count; every sleep
  and wait after it does. A run still going then is **cancelled** with
  `FunctionTimeout`, and the engine sends `inngest/function.cancelled`. There is no
  limit by default.

## Error names

The error's `name` tells you where it came from:

| Name | Where it comes from |
| --- | --- |
| `Error` (or your error's own name in TypeScript) | Your code threw or returned an error |
| `NonRetriableError` | `NonRetriableError` / `flow.NoRetryError` |
| `RetryAfterError` | `RetryAfterError` / `flow.RetryAtError` |
| `Panic` | Go: a panic in a `step.Run` callback (it counts as a failed try) |
| `TimeoutError` | A call took longer than `timeouts.step` |
| `FunctionTimeout` | The run took longer than `timeouts.finish` |
| `InvokeTimeout` | `step.invoke` waited longer than its `timeout` |
| `FunctionNotFound` | The engine called, or invoked, a function that is not there |
| `OutputTooLarge` | A step or the function returned more than 4 MB |
| `StateOverflowed` | The run holds more than 32 MB in all |
| `AppUnavailable` | The app could not be reached for 7 days |

[Going to production](production.md#troubleshooting) has more, with what to do.
