# Local development

While you work on your functions, your app runs on your laptop. The engine must be
able to call it. There are two ways:

- **[A local engine](#a-local-engine-on-your-machine)**: the whole engine and its
  dashboard on your machine. No internet, no `https`, and you can reset it at any
  time. This needs access to the engine's code or its private Docker image, so it is
  for team members.
- **[The hosted engine through a tunnel](#the-hosted-engine-through-a-tunnel)**: your
  app on your laptop, the real engine calling it through a public `https` URL.

## A local engine on your machine

The engine is not open source. Team members run it one of two ways.

**From the engine's repo** (needs Node 22+, Bun 1.4+ and the repo's dependencies,
`pnpm install`):

```bash
bun run dev
```

**From the Docker image** (private, `ghcr.io/eadwincode/flow-dev`). Log in once with
a GitHub token that has `read:packages`:

```bash
echo "$TOKEN" | docker login ghcr.io -u <your github user> --password-stdin
docker run --rm -p 127.0.0.1:8787:8787 -p 127.0.0.1:5173:5173 \
  --add-host=host.docker.internal:host-gateway \
  -v flow-dev-data:/data ghcr.io/eadwincode/flow-dev
```

Either way you get:

| What | Where |
| --- | --- |
| The engine (your app's `FLOW_BASE_URL`) | `http://127.0.0.1:8787` |
| The dashboard | `http://localhost:5173` |

Keep the ports on `127.0.0.1` as above, so others on your network can not reach
them.

### The first start

The first start makes the engine's secrets and prints a **setup code**. Open the
dashboard: it sends you to `/setup`. Type the code and make a **staff user**. A
staff user is in no workspace yet, so make one:

1. Sign up as a normal user, as in the [Quick start](getting-started.md#1-sign-up-and-get-a-workspace).
   With `bun run dev`, sign-up is off until you add `SIGNUP_OPEN=1` to
   `workers/dashboard/.dev.vars`. Emails are not sent: each one is written to a file
   under `workers/dashboard/.wrangler/tmp/email/`, and the log prints its path, so
   open it for the link.
2. Give the new account a plan without paying: as the staff user, open the staff
   console (`/staff`), open the account, and click **Comp the plan**.

Runs, apps, keys and users are kept between starts. To start over, run
`bun run dev --reset`, or delete the Docker volume (`docker volume rm flow-dev-data`).

## Point your app at it

1. In the local dashboard, **Apps**, then **Add app**. **Generate** a signing key
   and an event key, and copy them.
2. Start your app with:

   ```bash
   FLOW_BASE_URL=http://127.0.0.1:8787
   FLOW_SIGNING_KEY=<the signing key from Add app>
   FLOW_EVENT_KEY=<the event key>
   ```

   Keep the signature check on: do **not** set `FLOW_DEV=1`. The local engine signs
   its calls like the real one, so your app runs as it will in production.
3. In **Add app**, type your endpoint's URL **as the engine reaches it**, and click
   **Connect**:

   | The engine runs... | Your app runs... | URL to type |
   | --- | --- | --- |
   | with `bun run dev` | on your machine | `http://127.0.0.1:<port>/api/flow` |
   | in Docker | on your machine | `http://host.docker.internal:<port>/api/flow` |
   | in Docker | in the same compose file | `http://<service>:<port>/api/flow` |

   Plain `http` is fine here. The local engine allows it; the hosted one only takes
   public `https` URLs.
4. Send an event to `http://127.0.0.1:8787/e` (with curl, `flow.send()` or
   `client.Send()`), and watch the run in the dashboard.

Use `127.0.0.1` rather than `localhost` for the engine: it listens on IPv4, and some
runtimes (Node among them) try `localhost` as IPv6 first. Open the dashboard as
`http://localhost:5173`: its login cookie is `Secure`, and browsers allow that on
`http://localhost`.

### Syncing while you work

Each time your app starts, it syncs its functions by itself (the SDK compares a hash
of its functions with the engine's copy). So after you change a function, restart
the app. You can also click **Resync** on the Apps page.

A `PUT` to your own endpoint syncs too, and **saves the URL the request used as the
app's URL**. So send it with the address the engine uses:

```bash
# bun run dev, app on your machine: the engine uses the same address as you
curl -X PUT http://127.0.0.1:<port>/api/flow

# engine in Docker: give the engine's address in the Host header
curl -X PUT http://127.0.0.1:<port>/api/flow -H "Host: host.docker.internal:<port>"
```

The answer lists what changed, for example:

```json
{"ok":true,"created":false,"urlChanged":null,"modified":[],"archived":[]}
```

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
    ports: ["127.0.0.1:3000:3000"]
    environment:
      FLOW_BASE_URL: http://flow-dev:8787
      FLOW_SIGNING_KEY: ${FLOW_SIGNING_KEY}
      FLOW_EVENT_KEY: ${FLOW_EVENT_KEY}

volumes:
  flow-dev-data:
```

In **Add app**, the URL is `http://shop:3000/api/flow`. Your browser still uses
`http://localhost:5173` for the dashboard.

If the engine runs with `bun run dev` and only your app is in Docker, use
`FLOW_BASE_URL=http://host.docker.internal:8787` in the app, the URL
`http://host.docker.internal:<port>/api/flow` in Add app, and allow that host:
`FLOW_ALLOW_HTTP_HOSTS=host.docker.internal bun run dev`.

## What works locally

Everything the engine does: steps and retries, sleeps, waiting for events, sending
events from steps, invoking other functions, flow control, cron triggers, failure
handlers, the run timeline, and [realtime](realtime.md). Cron triggers fire on time.

Old runs go away as in production: 3 days after a run ends (4 days if it failed).
**Keep** on a run's page keeps it. The engine's daily cleanup runs at 03:17 UTC;
`bun run dev --no-cron` turns it off.

## The hosted engine through a tunnel

Without a local engine, use the hosted one. It calls your app over `https`, so it
can not reach `localhost` on your laptop. Use a tunnel, for example Cloudflare's:

```bash
cloudflared tunnel --url http://localhost:3000
```

It prints a public URL like `https://random-words.trycloudflare.com`. Then:

1. Use an app ID of your own for your laptop, for example `shop-dev-ada`, so your
   local functions never replace the real app's functions. Add it as a separate app
   in the dashboard.
2. Start your app with that app's signing key.
3. Connect it with the tunnel URL and the path:
   `https://random-words.trycloudflare.com/api/flow`.

Each time the tunnel gives you a new URL, sync through the new URL
(`curl -X PUT https://<new tunnel URL>/api/flow`), or use **Change URL** on the Apps
page.

A tunnel like this goes through Cloudflare's proxy, which ends a call that sends
nothing for about 100 seconds. The SDK sends a small heartbeat every 20 seconds while
a step runs, so steps can still run up to their step timeout.

`FLOW_DEV=1` turns off the signature check in the SDK. Use it only for a quick test
that nothing but you can reach. Never set it on a public app: anyone could then call
your functions.

## Troubleshooting

| Problem | Cause and fix |
| --- | --- |
| `docker run` says `denied` or `unauthorized` | You are not logged in to `ghcr.io`, or your token has no `read:packages`, or no access to the package. |
| Add app says `app url must be https` | The host is not allowed over plain `http`. `bun run dev` allows `localhost` and `127.0.0.1`; add others with `FLOW_ALLOW_HTTP_HOSTS`. The Docker image allows any host. |
| Add app says the app did not answer | The engine can not reach the URL you typed. From inside Docker, `localhost` is the container itself: use `host.docker.internal` or the compose service name. |
| Steps fail after a `curl -X PUT` sync, and the app shows **Down** | Under Docker, a `PUT` saved `127.0.0.1` as the app's URL. Send it again with the engine's address in the `Host` header, or use **Resync**. |
| Every call to your app gets `401` | `FLOW_SIGNING_KEY` is not the key from the **local** dashboard. Each engine has its own keys. |
| Sending an event gives `401 invalid event key` | Use an event key from the local dashboard, and send it to `http://127.0.0.1:8787/e`. |
| The app logs `the sync failed (400): invalid url` at start | The engine does not know the app's URL yet. Add the app (Connect), or sync once with `curl -X PUT <app-url>`. |
