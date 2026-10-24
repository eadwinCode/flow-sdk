# flow-sdk

SDKs for **clevix-worker**, a durable workflow engine on Cloudflare. You write
functions made of steps. The engine runs them, saves each step's result, and
retries steps that fail. Sleeps and waits can last days.

There are two SDKs. They speak the same protocol, so one app can call a function
in the other language.

| Language | Install | Guide |
| --- | --- | --- |
| Go | `go get github.com/eadwinCode/flow-sdk@latest` | [docs/go.md](docs/go.md) |
| TypeScript | `npm install <.tgz URL from the release>` | [docs/typescript.md](docs/typescript.md) |

The API follows Inngest (`inngestgo` for Go, `inngest` for TypeScript).

## Guides

New here? Start with **[Getting started](docs/getting-started.md)**: keys, install,
add your app, your first function, deploy, connect, and your first event.

| Guide | What is in it |
| --- | --- |
| [Getting started](docs/getting-started.md) | From nothing to a running function, and working on your laptop |
| [Functions and steps](docs/functions.md) | Triggers, steps (run, sleep, waitForEvent, sendEvent, invoke), parallel steps, errors and retries, cancelling, failure handlers, expressions |
| [Events](docs/events.md) | What an event holds, sending from apps, functions and HTTP, sending once, delayed runs |
| [Scheduling](docs/scheduling.md) | Cron triggers and time zones, sleeps, runs at a set time |
| [Flow control](docs/flow-control.md) | Concurrency, throttle, rate limit, debounce, batching, priority, idempotency, singleton |
| [Realtime](docs/realtime.md) | Live messages from functions to the browser: publish, tokens, subscribe, the React hook |
| [Local development](docs/local-dev.md) | A local engine on your machine (Docker or `bun run dev`), pointing your app at it, or the hosted engine through a tunnel |
| [Production](docs/production.md) | Syncing in CI, key rotation, the dashboard, limits, troubleshooting |
| [TypeScript reference](docs/typescript.md) | Install, framework adapters (Workers, Hono, Next.js, Express), settings |
| [Go reference](docs/go.md) | Install, the API, Go-specific notes |
| [Protocol](docs/protocol.md) | How SDKs talk to the engine (for SDK authors) |

## How it fits together

1. Your app defines functions with the SDK.
2. It serves one HTTP endpoint (for example `/api/flow`). The engine calls it to
   run your steps. Every call is signed, and the SDK checks the signature.
3. After each deploy, the app syncs by itself when it starts, so the engine knows
   your functions. A backup for CI: `curl -X PUT https://your-app/api/flow`.
4. Send events to the engine. Functions whose trigger matches start a run.

## Quick start: Go

```bash
go get github.com/eadwinCode/flow-sdk@latest
```

```go
package main

import (
	"context"
	"net/http"
	"time"

	flow "github.com/eadwinCode/flow-sdk"
	"github.com/eadwinCode/flow-sdk/step"
)

type SignedUp struct {
	UserID string `json:"userId"`
}

func main() {
	client, err := flow.NewClient(flow.ClientOpts{AppID: "billing-service"})
	if err != nil {
		panic(err)
	}

	_, err = flow.CreateFunction(client,
		flow.FunctionOpts{ID: "welcome"},
		flow.EventTrigger("user/signed-up", nil),
		func(ctx context.Context, in flow.Input[SignedUp]) (any, error) {
			_, err := step.Run(ctx, "send-email", func(ctx context.Context) (string, error) {
				return "sent", nil // call your mailer here
			})
			if err != nil {
				return nil, err
			}
			step.Sleep(ctx, "wait-a-day", 24*time.Hour)
			return "done", nil
		},
	)
	if err != nil {
		panic(err)
	}

	http.Handle("/api/flow", client.Serve())
	_ = http.ListenAndServe(":8080", nil)
}
```

## Quick start: TypeScript

Take the `.tgz` link from the newest
[release](https://github.com/eadwinCode/flow-sdk/releases):

```bash
npm install https://github.com/eadwinCode/flow-sdk/releases/download/v0.6.5/clevix-flow-0.6.5.tgz
```

```ts
import { Flow } from "@clevix/flow";
import { serve } from "@clevix/flow/cloudflare";

const flow = new Flow({ id: "shop" });

const welcome = flow.createFunction(
  { id: "welcome" },
  { event: "user/signed-up" },
  async ({ event, step }) => {
    await step.run("send-email", () => sendEmail(event.data.userId));
    await step.sleep("wait-a-day", "1d");
    return "done";
  },
);

export default serve({ client: flow, functions: [welcome] });
```

There are also adapters for Hono, Next.js and Express. See
[docs/typescript.md](docs/typescript.md).

## Settings

Both SDKs read the same env vars. Values passed in code win.

| Variable | Use |
| --- | --- |
| `FLOW_SIGNING_KEY` | Your app's own signing key, from **Add app** in the dashboard. Checks calls from the engine and signs sync. Required unless dev mode. |
| `FLOW_SIGNING_KEY_FALLBACK` | The app's old key while you rotate it. |
| `FLOW_EVENT_KEY` | For sending events from your app. |
| `FLOW_BASE_URL` | The engine's URL. Default: `https://worker.clevixstudio.com`. Set it only if you run your own engine. |
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
| `docs/` | The [Go](docs/go.md), [TypeScript](docs/typescript.md) and [protocol](docs/protocol.md) guides |

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

The engine pins a release of this repo. When a change needs the engine too (for
example a protocol change), see "Working with the engine" in
[RELEASING.md](RELEASING.md).
