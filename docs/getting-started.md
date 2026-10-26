# Quick start

This page takes you from nothing to a finished run on the hosted engine. You will
make a workspace, write one function, connect your app, send an event, and watch the
run. Pick TypeScript or Go in each code box.

You need:

- **TypeScript:** Node 24 (it runs `.ts` files as they are), and npm.
- **Go:** Go 1.27 or later.
- A way for the engine to reach your app over `https`: a deploy, or a tunnel to your
  laptop (step 5 shows one). To run everything on your own machine instead, see
  [Local development](local-dev.md).

## 1. Sign up and get a workspace

Open the dashboard: [dashboard.flow.clevixstudio.com](https://dashboard.flow.clevixstudio.com).

1. Click **Sign up**. Fill in your name, email, a password of at least 12
   characters, and a **Team name**. The team name makes your account and its first
   workspace.
2. Open the link in the email you get, and click **This is my email**.
3. You land on the account's **Billing** page. Pick a plan (**Choose ...**). A
   workspace can not add apps until its account has a plan.

Were you invited? Sign up from the link in the invite. You join that team's account
and its workspaces, and skip the plan step.

To add apps and make keys, your role must be **Owner**, **Admin** or **Developer**.

## 2. Install the SDK

The TypeScript package is not on the npm registry. Each release puts it on the
[GitHub releases page](https://github.com/eadwinCode/flow-sdk/releases) as a
`.tgz` file, and you install it by its URL. No login is needed. This example also
uses Express.

::: code-group

```bash [TypeScript]
mkdir hello-flow && cd hello-flow
npm init -y && npm pkg set type=module
npm install https://github.com/eadwinCode/flow-sdk/releases/download/v0.6.5/clevix-flow-0.6.5.tgz express
```

```bash [Go]
mkdir hello-flow && cd hello-flow
go mod init hello-flow
go get github.com/eadwinCode/flow-sdk@v0.6.5
```

:::

v0.6.5 is the newest release. It talks to the engine at
`https://worker.clevixstudio.com` by default. The next release changes the default
to `https://worker.flow.clevixstudio.com`. Both addresses reach the same engine
today, so you do not need to set anything.

## 3. Write a function

Make `index.ts` (TypeScript) or `main.go` (Go). First the client, named after your
app:

::: code-group
<<< @/../examples/ts/quickstart.ts#client [TypeScript]
<<< @/../examples/go/quickstart/main.go#client [Go]
:::

Then a function. It runs when a `demo/hello` event comes in. It has three steps: it
makes a greeting, sleeps 10 seconds, and prints the greeting.

::: code-group
<<< @/../examples/ts/quickstart.ts#function [TypeScript]
<<< @/../examples/go/quickstart/main.go#function [Go]
:::

Last, serve the endpoint. The engine calls this one URL for every function in the
app.

::: code-group
<<< @/../examples/ts/quickstart.ts#serve [TypeScript]
<<< @/../examples/go/quickstart/main.go#serve [Go]
:::

The whole file is in the repo:
[`examples/ts/quickstart.ts`](https://github.com/eadwinCode/flow-sdk/blob/main/examples/ts/quickstart.ts)
and [`examples/go/quickstart/main.go`](https://github.com/eadwinCode/flow-sdk/blob/main/examples/go/quickstart/main.go).
(In Go, call `addHelloWorld(client)` before `Serve`, as the file does.)

## 4. Make the keys

In your workspace, open **Apps** and click **Add app**. The form has four fields:

1. **Endpoint URL**: where the engine reaches your endpoint, with its path, for
   example `https://hello.example.com/api/flow`. If you do not know it yet, fill it
   in at step 5.
2. **App ID (optional)**: leave it empty. The engine reads the ID from your app.
3. **Signing key**: click **Generate**. This is your app's own signing key.
4. **Event key (optional)**: click **Generate**. Your app does not send events in
   this example, but you will use this key with curl in step 6.

Copy both keys now: the form says "Copy these now; they can not be shown again."
Keep them in your secret store, never in code or in git. Leave the form open.

## 5. Run the app, then connect

Start the app with the signing key in its environment:

::: code-group

```bash [TypeScript]
FLOW_SIGNING_KEY=signkey-... node index.ts
```

```bash [Go]
FLOW_SIGNING_KEY=signkey-... go run .
```

:::

Until you connect it, the app logs a line like this when it starts. It is fine, and
it stops once the app is connected:

```
flow: sync check of app quickstart: the sync failed (400): invalid url. The engine may not know this app's URL yet: add the app by URL in the dashboard, or sync once with curl -X PUT <app-url>
```

The hosted engine calls your app over `https`, so it can not reach `localhost`.
Deploy the app, or open a tunnel to your laptop. For example, with Cloudflare's
`cloudflared`:

```bash
cloudflared tunnel --url http://localhost:3000
```

It prints a public URL like `https://random-words.trycloudflare.com`. Your Endpoint
URL is that, plus `/api/flow`.

Back in the **Add app** form, check the Endpoint URL and click **Connect**. The
engine calls your endpoint with a signed `GET`, reads the app ID (`quickstart`) and
its functions, and ties the signing key to this app. You see "quickstart is
connected: 1 function synced." The app shows on the Apps page as **Live**.

When it does not work, the form says why and the button turns into **Retry**. The
usual causes: the app is not running, the URL is wrong, or the app has another
signing key.

## 6. Send an event

Send `demo/hello` with your event key. Any HTTP client works:

```bash
curl -X POST https://worker.flow.clevixstudio.com/e \
  -H "Authorization: Bearer $FLOW_EVENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "demo/hello", "data": {"name": "Ada"}}'
```

The engine answers with the new event's ID:

```json
{"ids":["evt_01M5WS6FXPGCD6EXT4ETV9W2C6"],"status":200}
```

You can also send it from the dashboard: **Events**, then **Send test event**.

## 7. Watch the run

Open **Runs** in the dashboard and open the newest run of `hello-world`. The run page
updates live. You see:

1. `make-greeting` done, with its output `"Hello, Ada!"`.
2. The run **Sleeping** in `wait-a-moment` for 10 seconds.
3. `print-greeting` done, and your app's log shows `Hello, Ada!`.
4. The run **Completed**, with the output `{"greeting": "Hello, Ada!"}`.

## What just happened

- The engine called your endpoint three times, once per step. Each time, the
  function ran from the top and the steps that were done gave back their saved
  results. This is [replay](core-ideas.md#replay-code-outside-steps-runs-again).
- During the sleep, nothing ran and your app was not called.
- When you deploy a new version, the app syncs its functions with the engine by
  itself when it starts. See [Going to production](production.md).

## Next

- [Background jobs](background-jobs.md), [Webhooks and events](webhooks.md) and
  [Crons and scheduled jobs](crons.md): full guides for the three main uses.
- [Functions and steps](functions.md): every kind of step.
- [Local development](local-dev.md): work without a tunnel.
