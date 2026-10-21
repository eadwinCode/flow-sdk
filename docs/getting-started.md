# Getting started

This guide takes you from nothing to a function that runs on the engine. It shows
TypeScript and Go side by side; use the one your app is written in.

## How it works

```
 your app                                 the engine
 ────────                                 ──────────
 /api/flow ◀─── GET  (Add app, Resync) ─── reads your functions
           ──── PUT  (sync, on deploy) ──▶ (or your app sends them)
                                           │
 sender ─────── POST /e (an event) ──────▶ starts a run for each matching function
                                           │
 /api/flow ◀─── POST (signed call) ─────── runs your code one step at a time,
           ──── step result ─────────────▶ saves each result, retries failures
```

- Your app **serves one endpoint**, for example `/api/flow`. The engine calls it to
  run your code. Every call is signed with **your app's own signing key**, and the
  SDK checks the signature.
- You **add the app** in the dashboard by that endpoint's URL. The engine asks the
  app for its functions. After a deploy, the app can also **sync** itself: it sends
  the list of its functions to the engine.
- **Events** start runs. An event has a name, like `user/signed-up`, and some data.
  Every function whose trigger matches the name gets a run.
- A function is made of **steps**. The engine saves each step's result. If a step
  fails, only that step is tried again. A run can sleep or wait for days.

## 1. Get your app's keys

You need an account on the engine's dashboard. The SDK talks to
`https://worker.clevixstudio.com` unless you set `FLOW_BASE_URL` (you run your own
engine).

In the dashboard, open **Apps** and click **Add app**:

1. Type your **app ID**: the ID you give the app in its code (`new Flow({ id: "shop" })`
   or `flow.ClientOpts{AppID: "shop"}`), for example `shop`.
2. Tick **Also create an event key** if this app sends events.
3. Click **Create key**. You get the app's **signing key** (`signkey-` and 64 hex
   characters), and the event key if you asked. The app uses the signing key to
   check that calls come from the engine, and to prove who it is when it syncs.
   Each app has its own.

Each key is shown **once**. Copy it into your secret store right away (as
`FLOW_SIGNING_KEY` and `FLOW_EVENT_KEY`, see step 4). Keys are secrets: never put
them in code or in git. Then click **I put it in the app**: the dialog asks for your
endpoint's URL. You can leave it open, or close it and come back after step 5
(**Add app**, type the same app ID, **It has a key: connect**).

Other senders (a backend, a script) get their own event key on the **Keys** page,
one per sender, so you can revoke one without cutting off the rest.

## 2. Install the SDK

TypeScript (take the newest version from the
[releases](https://github.com/eadwinCode/flow-sdk/releases)):

```bash
npm install https://github.com/eadwinCode/flow-sdk/releases/download/v0.6.0/clevix-flow-0.6.0.tgz
```

Go (needs Go 1.27+):

```bash
go get github.com/eadwinCode/flow-sdk@v0.6.0
```

## 3. Write a function

This function sends a welcome email when a user signs up, waits a day, then sends
a tip.

TypeScript, on Cloudflare Workers (`src/index.ts`):

```ts
import { Flow } from "@clevix/flow";
import { serve } from "@clevix/flow/cloudflare";

// The app ID names this app on the engine. Keep it the same forever.
const flow = new Flow({ id: "shop" });

const welcome = flow.createFunction(
  { id: "welcome-email" },
  { event: "user/signed-up" },
  async ({ event, step }) => {
    const user = await step.run("load-user", () => loadUser(event.data.userId));
    await step.run("send-welcome", () => sendEmail(user.email, "Welcome!"));
    await step.sleep("wait-a-day", "1d");
    await step.run("send-tip", () => sendEmail(user.email, "Here is a tip..."));
    return { sent: 2 };
  },
);

// One endpoint for all functions. On Workers this is the whole fetch handler;
// to serve it on one path only, use the Hono adapter (see typescript.md).
export default serve({ client: flow, functions: [welcome] });

async function loadUser(id: string): Promise<{ email: string }> {
  return { email: `${id}@example.com` }; // read your database here
}
async function sendEmail(to: string, text: string): Promise<void> {
  // call your email provider here
}
```

Go (`main.go`):

```go
package main

import (
	"context"
	"log"
	"net/http"
	"time"

	flow "github.com/eadwinCode/flow-sdk"
	"github.com/eadwinCode/flow-sdk/step"
)

type SignedUp struct {
	UserID string `json:"userId"`
}

func main() {
	// The app ID names this app on the engine. Keep it the same forever.
	client, err := flow.NewClient(flow.ClientOpts{AppID: "shop"})
	if err != nil {
		log.Fatal(err)
	}

	_, err = flow.CreateFunction(client,
		flow.FunctionOpts{ID: "welcome-email"},
		flow.EventTrigger("user/signed-up", nil),
		func(ctx context.Context, in flow.Input[SignedUp]) (any, error) {
			email, err := step.Run(ctx, "load-user", func(ctx context.Context) (string, error) {
				return loadEmail(ctx, in.Event.Data.UserID)
			})
			if err != nil {
				return nil, err
			}
			if _, err := step.Run(ctx, "send-welcome", func(ctx context.Context) (bool, error) {
				return true, sendEmail(ctx, email, "Welcome!")
			}); err != nil {
				return nil, err
			}
			if err := step.Sleep(ctx, "wait-a-day", 24*time.Hour); err != nil {
				return nil, err
			}
			if _, err := step.Run(ctx, "send-tip", func(ctx context.Context) (bool, error) {
				return true, sendEmail(ctx, email, "Here is a tip...")
			}); err != nil {
				return nil, err
			}
			return map[string]int{"sent": 2}, nil
		},
	)
	if err != nil {
		log.Fatal(err)
	}

	// One endpoint for all functions.
	http.Handle("/api/flow", client.Serve())
	log.Fatal(http.ListenAndServe(":8080", nil))
}

func loadEmail(ctx context.Context, userID string) (string, error) {
	return userID + "@example.com", nil // read your database here
}

func sendEmail(ctx context.Context, to, text string) error {
	return nil // call your email provider here
}
```

Things to notice:

- **Step IDs** (`"load-user"`, `"send-welcome"`, ...) name the steps. Keep them the
  same between deploys: the engine finds saved results by ID.
- **Code outside steps runs again** each time the engine calls your function. Put
  anything with a side effect (email, payment, database write) inside a step.
- A step's result is saved as JSON, so return plain data from it.

[functions.md](functions.md) covers all the step types and options.

## 4. Settings

The SDK reads its settings from env vars. You can also pass them in code
(`new Flow({ ... })` or `flow.ClientOpts{...}`); a value in code wins.

| Env var | Needed for | What it is |
| --- | --- | --- |
| `FLOW_SIGNING_KEY` | always | Your app's signing key from step 1. Secret. |
| `FLOW_EVENT_KEY` | sending events from this app | The event key from step 1. Secret. |
| `FLOW_SIGNING_KEY_FALLBACK` | key rotation | The app's old signing key while you switch. Secret. |
| `FLOW_BASE_URL` | only if you run your own engine | The engine's URL. Default: `https://worker.clevixstudio.com`. |

On Cloudflare Workers, put secrets in with wrangler:

```bash
wrangler secret put FLOW_SIGNING_KEY
wrangler secret put FLOW_EVENT_KEY
```

Running your own engine? Add its URL to `vars` in `wrangler.jsonc`:
`"vars": { "FLOW_BASE_URL": "https://flow.example.com" }`.

On a server, set them as env vars the usual way (your host's secret settings,
a `.env` loader, Kubernetes secrets, ...).

## 5. Deploy and connect

Deploy your app as you always do, with its `FLOW_SIGNING_KEY`. The endpoint must be
public and use `https`.

Then, in the **Add app** dialog, type the endpoint's URL with its path (for example
`https://shop.example.com/api/flow`) and click **Connect**. The engine calls it with
a `GET`, signed with your app's key, and reads your functions. Your app shows on the
**Apps** page as **Live**, with its functions.

If it fails (the app is not deployed yet, or it has another key), the app is still
added, as **Down**, with the error. Fix it and click **Retry**, or **Resync** on the
Apps page later.

After **every deploy** the engine must learn your new functions. Click **Resync** on
the Apps page, or let the app sync itself: send a `PUT` to your own endpoint, and
the SDK sends your function list to the engine, signed with your app's key.

```bash
curl -X PUT https://shop.example.com/api/flow
```

A good answer is `200` with JSON that lists what changed, like
`{"ok":true,"modified":["shop-welcome-email"],...}`. The easiest way is a last step
in your deploy script or CI job. [production.md](production.md) has an example.

## 6. Send an event

Send `user/signed-up` with your event key. With curl:

```bash
curl -X POST https://worker.clevixstudio.com/e \
  -H "Authorization: Bearer $FLOW_EVENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "user/signed-up", "data": {"userId": "u_123"}}'
```

Or from your app, TypeScript:

```ts
// On Workers, pass the handler's env so the SDK finds FLOW_EVENT_KEY there:
// await flow.send({ ... }, { env });
await flow.send({ name: "user/signed-up", data: { userId: "u_123" } });
```

Go:

```go
id, err := client.Send(ctx, flow.Event{
	Name: "user/signed-up",
	Data: map[string]any{"userId": "u_123"},
})
if err != nil {
	log.Printf("send failed: %v", err)
} else {
	log.Printf("sent event %s", id)
}
```

The answer holds the new event's ID. [events.md](events.md) has the details.

## 7. Watch it run

Open **Runs** in the dashboard. You will see a run of `welcome-email`. Open it to
see each step, its output, and the one-day sleep. The run page updates live.

If the run fails, the run page shows the error and each attempt.
[production.md](production.md#troubleshooting) lists common problems.

## Working on your laptop

Run your app on your laptop against **a local engine** (the whole engine on your
machine: no tunnel, no `https`, plain `http://127.0.0.1`), or against the **hosted
engine through a tunnel**. [local-dev.md](local-dev.md) covers both.

## Next

- [functions.md](functions.md): triggers, steps, errors and retries, cancelling
- [events.md](events.md): sending events, and what an event holds
- [scheduling.md](scheduling.md): cron, sleeps and delayed runs
- [flow-control.md](flow-control.md): concurrency, throttling, rate limits, debounce, batching
- [local-dev.md](local-dev.md): a local engine on your machine, or a tunnel
- [production.md](production.md): syncing in CI, key rotation, limits, troubleshooting
- [typescript.md](typescript.md) and [go.md](go.md): install, framework adapters, settings
