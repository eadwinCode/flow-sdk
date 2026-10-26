# Clevix Flow docs

These pages are the docs website at
[eadwincode.github.io/flow-sdk](https://eadwincode.github.io/flow-sdk/). Read them
there: code examples are pulled in from [`examples/`](../examples), and GitHub does
not show those.

Start here:

1. [What is Clevix Flow](what-is-clevix-flow.md): the moving parts, and how a run happens
2. [Core ideas](core-ideas.md): events, functions, steps, runs, retries, replay, and the rest
3. [Quick start](getting-started.md): from nothing to a finished run
4. [Local development](local-dev.md): a local engine, or the hosted one through a tunnel

Use cases:

- [Background jobs](background-jobs.md): slow work out of a request, with retries
- [Webhooks and events](webhooks.md): webhooks from other services, handled once
- [Crons and scheduled jobs](crons.md): timetables, set times, sleeps

Guides:

- [Functions and steps](functions.md): every kind of step, triggers, expressions, options
- [Events](events.md): sending events, once only, for later
- [Errors and retries](errors.md): retries, giving up, undoing, failure handlers, timeouts
- [Flow control](flow-control.md): concurrency, throttle, rate limit, debounce, batching, priority, idempotency, singleton
- [Realtime](realtime.md): live messages from a function to the browser
- [Going to production](production.md): sync, keys, the dashboard, troubleshooting

Reference:

- [TypeScript API](typescript.md) and [Go API](go.md)
- [Settings](settings.md): every env var
- [HTTP API](http-api.md): the engine's routes and your endpoint
- [Limits](limits.md)
- [Protocol](protocol.md): how an SDK talks to the engine, for SDK authors
- [Coming from Inngest](coming-from-inngest.md)

Work on the site: `bun run docs:dev` in the repo root. `bun run docs:build` fails on
a dead link or a missing code snippet.
