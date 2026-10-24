# Docs

Start here:

1. [Getting started](getting-started.md): add your app, install, first function, deploy, connect, first event
2. [Local development](local-dev.md): a local engine on your machine, or the hosted engine through a tunnel

Guides:

- [Functions and steps](functions.md): triggers, steps, parallel steps, errors and retries, cancelling, failure handlers, expressions
- [Events](events.md): sending events, sending once, delayed runs, limits
- [Scheduling](scheduling.md): cron, time zones, sleeps, runs at a set time
- [Flow control](flow-control.md): concurrency, throttle, rate limit, debounce, batching, priority, idempotency, singleton
- [Realtime](realtime.md): live messages from a function to the browser
- [Production](production.md): syncing in CI, keys, the dashboard, limits, troubleshooting

Reference:

- [TypeScript](typescript.md): install, framework adapters, settings
- [Go](go.md): install, setup, settings
- [Protocol](protocol.md): how an SDK talks to the engine, for SDK authors

These pages are also built as a website with VitePress: `bun run docs:dev` in the
repo root.
