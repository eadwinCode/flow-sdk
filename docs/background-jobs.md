# Background jobs

## The problem

A user signs up. Your app must set up their account and send a welcome email. If
your sign-up route does all of that before it answers:

- the user waits for the email provider;
- if the email provider is down, the sign-up fails, or the email is lost;
- a burst of sign-ups sends a burst of calls to the email provider, which may refuse
  them.

## The shape of the solution

1. The sign-up route saves the user, sends one **event** (`user/signed-up`), and
   answers at once.
2. A **function** whose trigger is `user/signed-up` does the slow work, in
   **steps**: set up the account, send the email, mark the user as onboarded.
3. If a step fails, the engine **retries** that step. The steps before it are not run
   again.
4. Flow control options on the function keep the pace safe for the email provider.

The code is in the repo:
[`examples/ts/background-jobs.ts`](https://github.com/eadwinCode/flow-sdk/blob/main/examples/ts/background-jobs.ts)
and [`examples/go/backgroundjobs/main.go`](https://github.com/eadwinCode/flow-sdk/blob/main/examples/go/backgroundjobs/main.go).

## Send the event from your API

The route does only the quick part. `flow.send` (Go: `client.Send`) needs the app's
event key in `FLOW_EVENT_KEY`.

::: code-group
<<< @/../examples/ts/background-jobs.ts#route [TypeScript]
<<< @/../examples/go/backgroundjobs/main.go#route [Go]
:::

The event `id` matters. A network error can make `flow.send` fail after the engine
got the event, and then the sign-up is tried again. With the same `id`, the engine
sees one event: it gives back the same event ID, and each function runs once. See
[Send an event only once](events.md#send-an-event-only-once).

So the `id` must be the same on a retry. A new random ID per request would not be:
here the `id` comes from the saved user, and `saveUser` finds the user already saved
with that email, so a retried sign-up gets the same user and sends the same `id`.

If `flow.send` fails, it throws (Go: returns an error). The user is saved by then,
but no event is queued, so the user is not onboarded. The route answers `503`, so
the caller knows to try again; the retry sends the same `id`. If the caller may
never try again, this is not enough: save the event in the same database write as
the user (an "outbox" table), and have a job send it until the send works.

## Do the work in a function

::: code-group
<<< @/../examples/ts/background-jobs.ts#function [TypeScript]
<<< @/../examples/go/backgroundjobs/main.go#function [Go]
:::

Things to notice:

- **Each piece of work with a side effect is its own step.** If `send-welcome-email`
  fails, the retry starts at that step; `create-account` is not run again.
- **Steps return plain data.** The email ID is saved as the step's result, and
  `mark-onboarded` and the return value can use it.
- The function's return value is the run's **output**, shown in the dashboard.

## A step runs at least once

The engine saves a step's result when your app answers. If your app crashes after
the email went out but before it answered, the engine runs the step again. So a step
can run **more than once**, and each step must be safe to repeat:

- **Outside APIs:** pass the step's **idempotency key** (`idempotencyKey` in
  TypeScript, `step.IdempotencyKey(ctx)` in Go) to any API that takes one. It is
  `<run ID>:<step ID hash>`, the same on every try of that step, and different for
  every other step and run. The email provider then sends the email once.
- **Your database:** write so that a second write changes nothing ("create the
  account if it is not there", "set onboarded to true"), not "add one".

## Protect the email provider

Two options on the function set the pace:

- `concurrency: { limit: 5 }` lets at most 5 **steps** of this function run at the
  same time, over all its runs. More wait their turn; none are lost. A run that is
  sleeping or waiting holds no slot.
- `throttle: { limit: 60, period: "1m" }` starts at most 60 **runs** a minute, spread
  out evenly. More runs wait to start; none are lost.

Use concurrency to limit work at the same moment, and throttle to limit how fast runs
start. To share one limit between several functions (for example, all calls to one
partner API), see [Flow control](flow-control.md#share-a-limit-between-functions).

## Run it

Start the app with its keys (see [Quick start](getting-started.md) or
[Local development](local-dev.md)), connect it, then sign up a user:

::: code-group

```bash [TypeScript]
node background-jobs.ts
curl -X POST http://127.0.0.1:3000/signup \
  -H "Content-Type: application/json" -d '{"email":"ada@example.com"}'
```

```bash [Go]
go run ./backgroundjobs
curl -X POST http://127.0.0.1:3000/signup \
  -H "Content-Type: application/json" -d '{"email":"ada@example.com"}'
```

:::

The route answers `201` at once with `{"userId":"user_..."}`. The pretend email API
in the example fails the first call, as a real one sometimes does. On a local engine,
the run's steps came out like this:

| Step | Status | Failed tries |
| --- | --- | --- |
| `create-account` | completed | none |
| `send-welcome-email` | completed | 1: `email API answered 503: try again later` |
| `mark-onboarded` | completed | none |

The run **Completed** about a second after the sign-up, with the output
`{"userId": "...", "emailId": "email_..."}`. The app's log shows
`sent welcome email to ada@example.com` once.

## See it in the dashboard

- **Runs** lists every run. Open one to see each step, its output, its failed tries
  ("Failed tries (N)") and how long it took. It updates live.
- **Events** lists the events (kept 4 days), and each event's page shows the runs it
  started.
- On a run's page: **Cancel**, **Pause** and **Resume**, **Retry** (a failed or
  cancelled run; finished steps keep their results), **Rerun** (a new run with the
  same event), and **Rerun from here** on a step.
- On the function's page, **Bulk actions** retries many failed runs at once (at most
  500 per go).

## What happens on failure

- **A step fails:** the engine retries it, waiting about 1 s, then 2 s, 4 s and so on
  (doubling, up to 1 hour, with some randomness). The default is 4 retries (5 tries
  in all); set `retries` from 0 to 20.
- **A step runs out of tries:** the step's error comes back into your function as a
  `StepError`. If you do not catch it, the run ends as **Failed**. You can catch it
  and undo earlier steps. See [Errors and retries](errors.md).
- **Retrying can not help** (bad input): throw `NonRetriableError` (Go:
  `flow.NoRetryError(err)`) to fail at once.
- **Your app is down:** the engine can not reach your endpoint. That does not use up
  tries. The runs wait (**Waiting for app**) and go on when the app answers again.
  After 7 days of waiting, a run fails with `AppUnavailable`.
- **Run failed for good:** retry it from the dashboard after you fix the cause, or
  add a failure handler ([Errors and retries](errors.md#when-a-run-fails-for-good)).

## Limits and gotchas

- **One call to your app** may take 5 minutes by default (`timeouts.step`, from 1
  second to 14 minutes). Split longer work into more steps.
- **Up to 1000 steps per run.** For a job over many items, send one event per item
  and let each item have its own run ([fan-out](crons.md#one-run-per-user-on-a-schedule)).
- **A step's result** may be up to 4 MB. Save big data elsewhere and return its ID.
- **Code outside steps runs on every call.** Do not send emails or write to your
  database there. See [replay](core-ideas.md#replay-code-outside-steps-runs-again).
- **Rename with care.** A new function ID or step ID is new to the engine. Runs that
  are in progress look for the old step IDs.
- **A send can fail.** Rate limits per workspace (`429`), a spent account (`402`) or
  a suspended workspace (`403`) make `flow.send` throw. See
  [HTTP API](http-api.md#post-e-send-events).
