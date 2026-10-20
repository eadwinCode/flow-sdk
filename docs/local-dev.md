# Local development

Two ways to run your functions while you work on them:

- **[A local engine](#a-local-engine-on-your-machine)** on your machine: the whole
  engine and its dashboard, no account and no internet needed. Your app runs on
  `http://localhost`, steps can run for the full 14 minutes, and you can reset
  everything at any time. This needs access to the engine (see below).
- **[The hosted engine through a tunnel](#the-hosted-engine-through-a-tunnel)**: your
  app on your laptop, the real engine calling it through a public `https` URL.

- [A local engine on your machine](#a-local-engine-on-your-machine)
- [Point your app at it](#point-your-app-at-it)
- [Your app in Docker](#your-app-in-docker)
- [What works locally](#what-works-locally)
- [The hosted engine through a tunnel](#the-hosted-engine-through-a-tunnel)
- [Troubleshooting](#troubleshooting)

## A local engine on your machine

The engine is not open source. Team members can run it in one of two ways:

**Docker image** (private, `ghcr.io/eadwincode/flow-dev`). Log in once with a GitHub
token that has `read:packages` (for example `gh auth refresh -s read:packages`, then
`gh auth token`):

```bash
echo "$TOKEN" | docker login ghcr.io -u <your github user> --password-stdin
docker run --rm -p 127.0.0.1:8787:8787 -p 127.0.0.1:5173:5173 \
  -v flow-dev-data:/data ghcr.io/eadwincode/flow-dev
```

**From the engine's repo**, with Bun 1.4+:

```bash
bun run dev
```

Either way you get:

| What | Where |
| --- | --- |
| The engine (your app's `FLOW_BASE_URL`) | `http://127.0.0.1:8787` |
| The dashboard | `http://localhost:5173` |

The first start makes the engine's secrets and prints a **setup token**. Open the
dashboard: it goes to `/setup`. Type the token and make your admin user. Runs, apps,
keys and users are kept between starts (in the `flow-dev-data` volume, or in the
repo's `.wrangler/` folders). To start over, delete the volume
(`docker volume rm flow-dev-data`) or run `bun run dev --reset`.

Keep the ports on `127.0.0.1` as above: the local engine and dashboard are not meant
to be reached by others on your network.

Use `127.0.0.1` rather than `localhost` for the engine in your app: the engine listens
on IPv4, and some runtimes (Node among them) try `localhost` as IPv6 (`::1`) first.
Open the dashboard as `http://localhost:5173`: its login cookie is `Secure`, and
browsers allow that on `http://localhost`.

## Point your app at it

1. In the local dashboard, **Apps → Add app**. Press **Generate** for a signing key
   (and an event key, if your app sends events), and copy them.
2. Start your app with:

   ```bash
   FLOW_BASE_URL=http://127.0.0.1:8787
   FLOW_SIGNING_KEY=<the signing key from Add app>
   FLOW_EVENT_KEY=<the event key, if your app sends events>
   ```

   Keep the signature check on: do **not** set `FLOW_DEV=1`. The local engine signs
   its calls like the real one, so your app runs as it will in production.
3. Back in Add app, type your endpoint's URL **as the engine reaches it**, and press
   **Connect**:

   | The engine runs... | Your app runs... | URL to type |
   | --- | --- | --- |
   | with `bun run dev` | on your machine | `http://127.0.0.1:<port>/api/flow` |
   | in Docker | on your machine | `http://host.docker.internal:<port>/api/flow` |
   | in Docker | in the same compose file | `http://<service>:<port>/api/flow` |

   Plain `http` is fine here: the local engine allows it (the real one only takes
   `https`).
4. Send an event to `http://127.0.0.1:8787/e` (or with `flow.send()` /
   `client.Send()`), and watch the run in the dashboard.

After you add or change functions, sync again: **Resync** on the Apps page. A `PUT`
to your endpoint (`curl -X PUT http://127.0.0.1:<port>/api/flow`) also works when the
engine reaches your app at that same URL (`bun run dev`). Under Docker, use Resync:
a `PUT` sync sends the URL your request used, and the engine can not reach
`localhost` from inside its container.

## Your app in Docker

Run your app next to the engine in one compose file:

```yaml
services:
  flow-dev:
    image: ghcr.io/eadwincode/flow-dev:latest
    ports: ["127.0.0.1:8787:8787", "127.0.0.1:5173:5173"]
    volumes: [flow-dev-data:/data]

  shop:
    build: .
    ports: ["127.0.0.1:8080:8080"]
    environment:
      FLOW_BASE_URL: http://flow-dev:8787
      FLOW_SIGNING_KEY: ${FLOW_SIGNING_KEY}
      FLOW_EVENT_KEY: ${FLOW_EVENT_KEY}

volumes:
  flow-dev-data:
```

In Add app, the URL is `http://shop:8080/api/flow`. Your app calls the engine at
`http://flow-dev:8787`; your browser still uses `http://localhost:5173` for the
dashboard.

If the engine runs with `bun run dev` and only your app is in Docker, use
`FLOW_BASE_URL=http://host.docker.internal:8787` in the app, the URL
`http://host.docker.internal:<port>/api/flow` in Add app, and start the engine with
that host allowed: `FLOW_ALLOW_HTTP_HOSTS=host.docker.internal bun run dev`.

## What works locally

Everything the engine does: steps and retries, sleeps, `waitForEvent`, `sendEvent`,
`step.invoke` (also between your local apps), flow control, cron triggers, failure
and cancel handlers, the run timeline, and [realtime](realtime.md). The realtime
token's `url` points at the local engine (`ws://127.0.0.1:8787/...` with `bun run dev`,
`ws://localhost:8787/...` with the image), so the browser connects there with no
change in your code.

Old runs go away as in production: a run deletes itself 3 days after it ends (4 if
it failed). To keep one longer, press **Keep** on its run page. The engine's daily
cleanup (03:17 UTC) also runs, as in production; it only clears what is left over
(old events and alerts, expired keys and sessions, dashboard audit rows after 90
days). `bun run dev --no-cron` turns the cleanup off.

Your app does not need a public URL, a tunnel or `https`.

## The hosted engine through a tunnel

Without access to a local engine, use the hosted one. It must reach your endpoint
over `https`, so it can not call `http://localhost` directly. Use a tunnel, for
example Cloudflare's:

```bash
cloudflared tunnel --url http://localhost:8080
```

It prints a public URL like `https://random-words.trycloudflare.com`. Then:

1. Add a **separate app** in the dashboard for your laptop, so your local functions
   do not replace the real app's functions on the engine. Your app's ID comes from
   your code (`new Flow({ id })` / `flow.ClientOpts{AppID}`): use one of your own,
   for example `shop-dev-ada`.
2. Set `FLOW_SIGNING_KEY` to that app's key and start your app.
3. Connect it with the tunnel URL and the path:
   `https://random-words.trycloudflare.com/api/flow`.
4. Send an event as in [Getting started](getting-started.md#6-send-an-event).

Each time the tunnel gives you a new URL, connect the app again with the new URL. A
`PUT` sync sends the URL of the request it gets, so to sync with `curl` use the
tunnel URL, not `localhost`.

`FLOW_DEV=1` turns off signature checks in the SDK. Use it only for quick tests where
nothing but your own engine can reach your app. Never set it on a public app: anyone
could then call your functions.

## Troubleshooting

| Problem | Cause and fix |
| --- | --- |
| `docker run` says `denied` or `unauthorized` | You are not logged in to `ghcr.io`, or your token has no `read:packages`, or no access to the package. |
| Add app says `app url must be https` | The engine was not started with `bun run dev` or the image (only those allow plain `http`), or the host is not allowed: `bun run dev` allows only `localhost`; add others with `FLOW_ALLOW_HTTP_HOSTS`. |
| Add app says the app does not answer | The engine can not reach the URL you typed. From inside Docker, `localhost` is the container itself: use `host.docker.internal` or the compose service name. |
| `401` from your app on every call | `FLOW_SIGNING_KEY` in your app is not the key you generated in the **local** dashboard (each engine has its own keys). |
| Sending an event gives `401 invalid event key` | Use an event key from the local dashboard, and send it to `http://127.0.0.1:8787/e`, not the hosted engine. |
| Runs stay **Queued** | The engine is not fully up yet, or it was started some other way than `bun run dev` or the image. They start the engine and its step worker together; started apart, steps are never sent. |
