# TypeScript SDK (`@clevix/flow`)

> This page is the TypeScript reference: install, setup and settings. For how to
> use the features (steps, events, cron, flow control), read the
> [guides](README.md), starting with [getting started](getting-started.md).

The TypeScript SDK for clevix-worker. Your app defines functions made of steps. The
engine runs them, saves each step's result, and retries steps that fail. The API
follows Inngest's `inngest` package.

## Install

Each release has the package as a `.tgz` file on its
[GitHub release](https://github.com/eadwinCode/flow-sdk/releases). Install it
by URL. No npm account or login is needed.

```bash
npm install https://github.com/eadwinCode/flow-sdk/releases/download/v0.6.0/clevix-flow-0.6.0.tgz
```

pnpm, yarn and bun take the same URL (`pnpm add <url>`, `yarn add <url>`,
`bun add <url>`). Your `package.json` then has:

```json
"dependencies": {
  "@clevix/flow": "https://github.com/eadwinCode/flow-sdk/releases/download/v0.6.0/clevix-flow-0.6.0.tgz"
}
```

and you import from `@clevix/flow` as usual. The lockfile saves a hash of the
file, so installs stay the same until you change the URL.

To upgrade, put the new version in both places in the URL (`v0.6.0` and
`clevix-flow-0.6.0.tgz`) and install again. `npm update` does not see new
versions of a URL install, and neither do Dependabot or Renovate, so watch the
releases page (Watch → Custom → Releases on GitHub).

It is ESM only and ships its own types. It runs on Cloudflare Workers and Node 20+.
For Hono or Express, install that framework too.

## Example (Cloudflare Workers)

```ts
import { Flow, NonRetriableError } from "@clevix/flow";
import { serve } from "@clevix/flow/cloudflare";

const flow = new Flow({ id: "shop" });

const onboarding = flow.createFunction(
  { id: "user-onboarding", retries: 5 },
  { event: "user/signed-up" },
  async ({ event, step }) => {
    const user = await step.run("load-user", () => loadUser(event.data.userId));
    if (!user) throw new NonRetriableError("no such user");
    await step.run("send-welcome", () => sendEmail(user, "welcome"));
    await step.sleep("wait-3-days", "3d");
    const done = await step.waitForEvent("wait-onboarded", {
      event: "user/onboarded",
      match: "data.userId",
      timeout: "7d",
    });
    if (!done) await step.run("nudge", () => sendEmail(user, "nudge"));
  },
);

export default serve({ client: flow, functions: [onboarding] });
```

## Other frameworks

Each adapter is a thin wrapper around the same handler. Install the framework
yourself; `@clevix/flow` does not depend on it.

Hono (on Workers, `c.env` is passed through, so settings can live there):

```ts
import { serve } from "@clevix/flow/hono";

app.on(["GET", "PUT", "POST"], "/api/flow", serve({ client: flow, functions: [onboarding] }));
```

Next.js App Router, in `app/api/flow/route.ts`:

```ts
import { serve } from "@clevix/flow/next";

export const { GET, POST, PUT } = serve({ client: flow, functions: [onboarding] });
```

Express 5:

```ts
import { serve } from "@clevix/flow/express";

app.use("/api/flow", serve({ client: flow, functions: [onboarding] }));
app.use(express.json()); // after it, or not on this path
```

The signature is checked over the raw body, so the Express adapter must see the
body as it came. It reads the body itself, or takes it from `express.raw()` or
`express.text()`. If `express.json()` ran first, calls fail with a 500 that says so:
mount the adapter before `express.json()`, or put `express.raw({ type: "*/*" })` on
its path. The URL a `PUT` sync sends uses `req.protocol` and the host, so behind a
proxy set `app.set("trust proxy", ...)`. An app added by URL in the dashboard keeps
that URL, whatever a sync says.

## Settings

Each setting can go in `new Flow({ ... })` or in an env var. A value in code wins.

| Option | Env var | What it is for |
| --- | --- | --- |
| `signingKey` | `FLOW_SIGNING_KEY` | Your app's own signing key. Checks that calls really come from the engine, and proves who you are when you sync. Required unless dev mode. Secret. |
| `signingKeyFallback` | `FLOW_SIGNING_KEY_FALLBACK` | The app's old signing key while you swap keys. Secret. |
| `eventKey` | `FLOW_EVENT_KEY` | Lets `flow.send` send events. Only needed if this app sends events. Secret. |
| `baseUrl` | `FLOW_BASE_URL` | The engine's URL, for sync, `flow.send`, and big runs (over 4 MiB the SDK loads the state from the engine). Default: `https://worker.clevixstudio.com` (`DEFAULT_BASE_URL`). Set it only if you run your own engine. |
| `isDev` | `FLOW_DEV=1` | Turns off signature checks. For local work only, never on a public app. |

`serve` takes these options too:

| Option | What it is for |
| --- | --- |
| `syncOnBoot` | Default `true`. The app checks the engine's copy of its functions and syncs when they changed, so a deploy needs no Resync. Express: when `serve` is called. Next.js, Hono and Workers: on the first request, in the background (on Workers in `ctx.waitUntil`). Then it checks again every 5 minutes: a timer that does not keep Node alive, or on Workers the first request after that time. `false` turns it all off. See [production.md](production.md#sync-on-every-deploy). |
| `streaming` | Default on. `false`, or `{ heartbeatMs }`. See "Streamed answers" in [protocol.md](protocol.md). |

If you call the plain fetch handler from `@clevix/flow` in your own Worker, pass
`ctx` as the third argument (`handler(request, env, ctx)`), so the sync at boot can
finish after the answer.

Both keys come from the dashboard's **Add app** dialog (the event key also from the
Keys page). Each is shown once, when you make it.

In code:

```ts
const flow = new Flow({
  id: "shop",
  signingKey: "signkey-...",   // better: read it from a secret, not a string in code
  eventKey: "...",
  baseUrl: "https://flow.example.com", // only for your own engine
});
```

Or leave them out and set env vars. On Workers, `serve` reads them from the
Worker's `env`:

```bash
wrangler secret put FLOW_SIGNING_KEY
wrangler secret put FLOW_EVENT_KEY
```

Running your own engine? Put its URL in `vars` in `wrangler.jsonc`:
`"vars": { "FLOW_BASE_URL": "https://flow.example.com" }`.

Where each key is used:

- The **signing key** is used by `serve` only. You never pass it anywhere else.
- The **event key** is used by `flow.send`. On Workers, pass the handler's `env` so it
  can find `FLOW_EVENT_KEY`: `await flow.send({ name: "user/signed-up", data }, { env })`.
  Any other service that sends events needs its own event key: it posts to
  `POST {FLOW_BASE_URL}/e` with `Authorization: Bearer <event key>`.

## The endpoint

- `POST` runs a function. The engine signs it.
- `PUT` syncs: it sends your functions to the engine. The SDK also syncs by itself
  when it starts (see below), so this is a backup: `curl -X PUT https://your-app/api/flow`.
- `GET` returns the manifest (signed calls only, unless dev mode).

## Good to know

- Code outside `step.run` runs again on every call. Put side effects in steps.
- Steps can run more than once. `step.run` passes `{ idempotencyKey }` to its
  callback: send it to outside APIs.
- Run steps in parallel with `Promise.all`.
- A step that runs out of retries throws a `StepError` into your function. Catch it
  to undo earlier work.

Both SDKs speak the same wire protocol and pass the same conformance suite, so
a TypeScript app can `step.invoke` a Go function and the other way round.
