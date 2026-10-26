# Realtime

Send small live messages from your functions to the browser while a run goes on. The
usual use is progress for a long job: the page shows each step as it happens.

The code is in
[`examples/ts/realtime/`](https://github.com/eadwinCode/flow-sdk/tree/main/examples/ts/realtime)
and [`examples/go/realtime/main.go`](https://github.com/eadwinCode/flow-sdk/blob/main/examples/go/realtime/main.go).

## How it works

```
your function ──publish──────────────────► engine ──WebSocket──► browser
your server   ──"a token for this user"──► engine
browser       ──connect with the token───► engine
```

- A **channel** is a name you pick, like `deployment:dep_123`. Channels belong to
  your app: another app's channel with the same name is another channel.
- A **topic** is a name inside a channel, like `progress` or `logs`.
- A **token** lets one browser read some topics of one channel. Your server asks the
  engine for it, **after your own check** that the user may see that channel. The
  engine does not know your users.

## Publish from a function

::: code-group
<<< @/../examples/ts/realtime/server.ts#publish [TypeScript]
<<< @/../examples/go/realtime/main.go#publish [Go]
:::

Publishing uses the app's signing key (`FLOW_SIGNING_KEY`, then
`FLOW_SIGNING_KEY_FALLBACK` while you rotate). On Workers, pass the handler's `env`:
`flow.realtime.publish(message, { env })`.

## Give the browser a token

Add a route to your own server. Check the user first, then ask the engine:

::: code-group
<<< @/../examples/ts/realtime/server.ts#token [TypeScript]
<<< @/../examples/go/realtime/main.go#token [Go]
:::

The token looks like this (shortened):

```json
{
  "token": "eyJ2IjoyLCJ3cyI6...",
  "url": "ws://127.0.0.1:8787/v1/realtime/connect",
  "channel": "deployment:dep_42",
  "topics": ["progress"],
  "expiresAt": 1793042255886
}
```

`url` is the engine's WebSocket address, so the browser connects to the right engine
with no change in your code.

## Subscribe in the browser

Without React, with `subscribe` from `@clevix/flow/realtime`. It has no server code
in it.

<<< @/../examples/ts/realtime/browser.ts#subscribe

With React, with the `useRealtime` hook from `@clevix/flow/react`:

<<< @/../examples/ts/realtime/progress.tsx#hook

We ran the server and `browser.ts` (Node has a global `WebSocket`) against a local
engine, with both the TypeScript and the Go server. Both printed:

```
state: connecting
state: open
progress: 10% Rendering
progress: 60% Uploading
progress: 100% Done
```

- The client asks your route for a new token before **every** connect.
- After a dropped connection it connects again, waiting 1 s, then longer, up to
  30 s. It sends a ping every 30 s.
- `useRealtime` keeps the last 100 messages (`bufferSize`), and closes the socket
  when `enabled` is false or the component goes away. When `channel` changes, it
  drops its messages and connects again.
- If `refreshToken` gives back something that is not a token, the client reports an
  `error` state and tries again later.

## What to expect

- **Messages are hints.** A message goes only to browsers connected right now.
  Nothing is stored; a browser that connects later does not get older messages. Keep
  the real state in your app, and let the page read it (on load, for example).
- **A publish can be sent more than once.** `publish` is a plain call, not a step.
  Inside a step, it is sent again when that step is retried. **Outside** a step, it
  is sent again on every call: a publish before three steps goes out four times. Put
  it inside a step, or after the last step. After the last step, it runs only on the
  run's last call: once, unless that call fails and the engine tries it again.
- **No secrets in messages.** Anyone with a token for the channel sees every message
  on its topics.
- **Do not let a publish fail your run.** In Go, log the error and go on. In
  TypeScript, `publish` throws: catch it, as the example does.

## Limits

| What | Limit |
| --- | --- |
| One publish (the whole body) | 64 KB |
| Channel name | 1-256 characters: letters, digits, `:` `_` `-` `.` |
| Topic name | 1-64 characters: letters, digits, `_` `-` `.` |
| Topics per token | 1 to 10 |
| Token | must be used to connect within 1 minute |
| A connection | up to 1 hour; then the client gets a new token and connects again |
| Browsers on one channel | 1,000 |
| Open sockets per token | 1 |

The engine must have realtime turned on (`REALTIME_TOKEN_SECRET`). Without it,
tokens fail with `503 realtime is not set up on this engine`.
