# flow-sdk

SDKs for **clevix-worker**, a durable workflow engine on Cloudflare. You write
functions made of steps. The engine runs them, saves each step's result, and
retries steps that fail. Sleeps and waits can last days.

There are two SDKs. They speak the same protocol, so one app can call a function
in the other language.

| Language | Install | Guide |
| --- | --- | --- |
| Go | `go get github.com/eadwinCode/flow-sdk@v0.6.5` | [Go API](docs/go.md) |
| TypeScript | `npm install https://github.com/eadwinCode/flow-sdk/releases/download/v0.6.5/clevix-flow-0.6.5.tgz` | [TypeScript API](docs/typescript.md) |

The TypeScript package is not on the npm registry: install it by the `.tgz` URL of
a [release](https://github.com/eadwinCode/flow-sdk/releases).

## Docs

The docs are a website: **[eadwincode.github.io/flow-sdk](https://eadwincode.github.io/flow-sdk/)**.
New here? Start with [What is Clevix Flow](docs/what-is-clevix-flow.md), then the
[Quick start](docs/getting-started.md).

| Page | What is in it |
| --- | --- |
| [What is Clevix Flow](docs/what-is-clevix-flow.md) | Your app, the engine, the dashboard, and how a run happens |
| [Core ideas](docs/core-ideas.md) | Events, functions, steps, runs, retries, replay, sleeps, waits, sync, keys |
| [Quick start](docs/getting-started.md) | From nothing to a finished run |
| [Local development](docs/local-dev.md) | A local engine, or the hosted engine through a tunnel |
| [Background jobs](docs/background-jobs.md) | Slow work out of a request, with retries and a safe pace |
| [Webhooks and events](docs/webhooks.md) | Webhooks from other services, checked and handled once |
| [Crons and scheduled jobs](docs/crons.md) | Timetables, set times, sleeps, retrying later |
| [Functions and steps](docs/functions.md) | Every kind of step, triggers, expressions, options |
| [Events](docs/events.md) | Sending events, once only, for later |
| [Errors and retries](docs/errors.md) | Retries, giving up, undoing, failure handlers, timeouts |
| [Flow control](docs/flow-control.md) | Concurrency, throttle, rate limit, debounce, batching, priority, idempotency, singleton |
| [Realtime](docs/realtime.md) | Live messages from functions to the browser |
| [Going to production](docs/production.md) | Sync, keys, the dashboard, troubleshooting |
| [Settings](docs/settings.md), [HTTP API](docs/http-api.md), [Limits](docs/limits.md) | Reference |
| [Protocol](docs/protocol.md) | How SDKs talk to the engine (for SDK authors) |

Every code example in the docs is a file in [`examples/`](examples). CI type-checks
and builds them against the SDK in this repo.

## How it fits together

1. Your app defines functions with the SDK.
2. It serves one HTTP endpoint (for example `/api/flow`). The engine calls it to
   run your steps. Every call is signed, and the SDK checks the signature.
3. After each deploy, the app syncs by itself when it starts, so the engine knows
   your functions. A backup for CI: `curl -X PUT https://your-app/api/flow`.
4. Send events to the engine. Functions whose trigger matches start a run.

## Settings

Both SDKs read the same env vars. Values passed in code win.

| Variable | Use |
| --- | --- |
| `FLOW_SIGNING_KEY` | Your app's own signing key, from **Add app** in the dashboard. Checks calls from the engine and signs sync. Required unless dev mode. |
| `FLOW_SIGNING_KEY_FALLBACK` | The app's old key while you rotate it. |
| `FLOW_EVENT_KEY` | For sending events from your app. |
| `FLOW_BASE_URL` | The engine's URL. Default: `https://worker.flow.clevixstudio.com` (`https://worker.clevixstudio.com` in v0.6.5). Set it only if you run your own engine. |
| `FLOW_DEV` | `1` turns off signature checks. For local work only. |

## Versions

Both SDKs share one version number. Each release has a git tag `vX.Y.Z` (used by
Go) and a GitHub release with the TypeScript `.tgz`. To hear about new versions,
use Watch → Custom → Releases on this repo.

## What is in this repo

| Path | What |
| --- | --- |
| `*.go`, `step/`, `group/`, `internal/` | The Go SDK (module `github.com/eadwinCode/flow-sdk`) |
| `packages/flow` | The TypeScript SDK, `@clevix/flow` |
| `packages/protocol` | `@clevix/protocol`: wire types, signing, IDs and durations. Shared with the engine; `@clevix/flow` bundles it |
| `testdata/vectors.json` | Test vectors both SDKs must match |
| `docs/` | The docs website (VitePress) |
| `examples/` | The code the docs show: `examples/ts` (a workspace) and `examples/go` (a module of its own) |

## Develop

Needs Go 1.27+, Node 22+ and Bun 1.4+.

```bash
bun install
bun run typecheck
bun run test
go test ./...
```

Use `bun run test`, not `bun test`: `bun test` is Bun's own test runner, and the
tests here run on vitest.

The docs in `docs/` are a website, built with VitePress. `bun run docs:dev` serves
it on your machine. `bun run docs:build` checks that every link, heading link and
code snippet works. `bun run examples:check` type-checks the TypeScript examples
and vets and builds the Go ones (`bun run typecheck` covers the TypeScript ones
too).

The engine pins a release of this repo. When a change needs the engine too (for
example a protocol change), see "Working with the engine" in
[RELEASING.md](RELEASING.md).
