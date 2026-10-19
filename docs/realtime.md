# Realtime

Send small live messages from your functions to the browser, while the run goes on.
A typical use is progress for a long job: the page shows each step as it happens.

- [How it works](#how-it-works)
- [Publish from a function](#publish-from-a-function)
- [Give the browser a token](#give-the-browser-a-token)
- [Subscribe in the browser](#subscribe-in-the-browser)
- [What to expect](#what-to-expect)
- [Limits](#limits)

## How it works

```
your function ──publish──► engine ──WebSocket──► browser
your server   ──token────► engine
browser       ──connect with the token──► engine
```

- A **channel** is a name you pick, like `deployment:dep_123`. Channels belong to
  your app; another app's channel with the same name is a different one.
- A **topic** is a name inside a channel, like `progress` or `logs`.
- A **token** lets one browser read some topics of one channel. Your server asks the
  engine for it, after **your own** check that the user may see that channel. The
  engine does not know your users.

## Publish from a function

TypeScript:

```ts
flow.createFunction({ id: "build-site" }, { event: "site/build" }, async ({ event, step }) => {
  const channel = `deployment:${event.data.id}`;
  // A failed publish must not fail the step or the run: log it and go on.
  const progress = (data: { pct: number; label: string }) =>
    flow.realtime.publish({ channel, topic: "progress", data }).catch((err) => console.warn("realtime", err));
  await step.run("render", async () => {
    await progress({ pct: 10, label: "Rendering" });
    return render();
  });
  await progress({ pct: 100, label: "Done" }); // after the last step: sent once
});
```

Go:

```go
err := client.Realtime().Publish(ctx, "deployment:"+id, "progress", Progress{Pct: 10, Label: "Rendering"})
if err != nil {
	log.Printf("realtime: %v", err) // log and go on
}
```

Publishing uses the app's signing key (`FLOW_SIGNING_KEY`, then
`FLOW_SIGNING_KEY_FALLBACK` while you rotate). On Workers, pass the handler's `env`:
`flow.realtime.publish(message, { env })`.

## Give the browser a token

Add a route to your own server. Check the user first, then ask the engine:

```ts
// e.g. GET /api/deployments/:id/realtime-token
if (!(await userMaySee(user, deploymentId))) return new Response("forbidden", { status: 403 });
const token = await flow.realtime.token({ channel: `deployment:${deploymentId}`, topics: ["progress"] });
return Response.json(token);
```

```go
tok, err := client.Realtime().Token(ctx, "deployment:"+id, "progress")
// write tok as JSON
```

A token must be used within a minute. A browser stays connected for up to an hour,
then the client gets a new token from your route and connects again, so a user who
lost access stops getting messages within the hour.

## Subscribe in the browser

```ts
import { subscribe } from "@clevix/flow/realtime";

const stop = subscribe({
  refreshToken: () => fetch(`/api/deployments/${id}/realtime-token`).then((r) => r.json()),
  onMessage: (m) => showProgress(m.data), // m.channel, m.topic, m.data, m.ts
  onState: (s) => console.log(s), // "connecting" | "open" | "closed" | "error"
});
// later: stop();
```

React:

```tsx
import { useRealtime } from "@clevix/flow/react";

const { latest, messages, state, error } = useRealtime<Progress>({
  channel: `deployment:${id}`, // a new id: drop the old messages and connect again
  enabled: isBuilding,
  refreshToken: () => fetch(`/api/deployments/${id}/realtime-token`).then((r) => r.json()),
});
```

`@clevix/flow/realtime` has no server code in it and no imports, so it is small. The
client connects again after a dropped connection (waiting 1 s, then longer, up to
30 s) and sends a ping every 30 s. `useRealtime` keeps the last 100 messages
(`bufferSize`), and closes the socket when `enabled` is false or the component goes
away. Pass `channel`: when it changes, the hook drops its messages and connects again
with a new token. Turning `enabled` off and on also starts with no messages.

Your token route must answer 200 with the token. Check `r.ok` in `refreshToken` if
you want a clear error; if it gives back something that is not a token, the client
reports an `error` state and tries again later.

## What to expect

- **Messages are hints.** A message goes only to browsers connected right now.
  Nothing is stored, and a browser that connects later does not get older messages.
  Keep the real state in your app, and let the page read it (for example on load, or
  every few seconds as a fallback).
- **A publish can be sent more than once.** `publish` is a plain call, not a step.
  Your function runs from the top on every call from the engine (finished steps come
  back from memory), so:
  - inside a step, it is sent again only when that step is retried;
  - **outside** a step, it is sent again on every later call. A publish before three
    steps goes out four times. Put it inside a step, or after the last step.

  Fine for progress; do not use messages for things that must happen once.
- **Do not put secrets in messages.** Anyone with a token for the channel sees every
  message on its topics.
- **Publishing should not fail your run.** In Go, log the error and go on. In
  TypeScript, `publish` throws: catch it if the message is not essential.

## Limits

| What | Limit |
| --- | --- |
| One message (the whole publish body) | 64 KB |
| Channel name | 1-256 characters: letters, digits, `:` `_` `-` `.` |
| Topic name | 1-64 characters: letters, digits, `_` `-` `.` |
| Topics per token | 10 |
| Token | used to connect within 1 minute |
| A connection | up to 1 hour, then a new token |
| Browsers on one channel | 1,000 |

Needs an engine with realtime and its `REALTIME_TOKEN_SECRET` set. Without the
secret, tokens fail with `503`.
