# Streams

A stream is a list of items that the engine keeps for a while. One writer adds items
to the end. A reader starts from any place in the list (an **offset**), gets every
item after it, then new items as they come. When the writer is done, it closes the
stream with an **end item**, and readers stop there.

The usual use is the output of a long run, such as the text an AI agent writes. A
page that loads late, or reloads, still sees everything from where it left off.
[Realtime](realtime.md) is different: it keeps nothing, so a reader that connects
later misses what came before.

The code is in
[`examples/ts/streams/`](https://github.com/eadwinCode/flow-sdk/tree/main/examples/ts/streams).

## How it works

```
your function ──open, append, close──────► engine (keeps the items)
your server   ──"a token for this user"──► engine
browser       ──connect with token, after─► engine ──items, then live──► browser
```

- A **stream ID** is a name you pick, like `report:r_123`: letters, digits and
  `:_.-`, up to 256. Not `.`, `..`, `token` or `connect`: those would clash with the
  URL. Streams belong to your app.
- An **offset** is an item's place in the stream (`"1"`, `"2"`, ...), as text. Treat
  it as opaque: keep the last one you saw and pass it back as `after`.
- **open** sets a time to live (`ttl`). A stream nobody closes is deleted then.
- **close** writes the end item, and deletes the stream `grace` later. A reader that
  comes in that time still gets every item, the end item last.
- **One writer per stream.** Two writers would mix their items.

## Write from a function

<<< @/../examples/ts/streams/server.ts#write

- `open` gives back `{ created }`: `false` when the stream was there already. Opening
  it again changes nothing, so it is safe in a step that is retried.
- `append` takes 1 to 100 items and gives back their offsets. It throws
  `StreamClosedError` after `close`, and `StreamGoneError` when the stream does not
  exist (never opened, or deleted).
- `close` gives back `{ closed }`: `false` when it was closed already. It throws
  `StreamGoneError` when the stream does not exist.
- `delete` deletes a stream now. It gives back `{ deleted }`: `false` when there was
  none.
- `append` is a plain call. In a step that is retried, it appends again. If a repeat
  matters, put an ID in each item so the reader can skip it.

## Read on a server

<<< @/../examples/ts/streams/server.ts#read

`flow.streams.read` gives every item after `after` (or from the start), then each new
item, and ends after the end item. The end item has `end: true`. If the stream is
closed and you already had its end item (your `after` is the end item's offset), the
loop ends at once, with no item and no error.

- After a dropped connection it connects again from the last offset it gave you
  (waiting 1 s, then longer, up to 30 s). When the socket reaches its 1-hour life, it
  connects again at once.
- It throws `StreamGoneError` when the stream does not exist, or is deleted while you
  read. It also stops and throws when the token call fails in a way that asking again
  will not fix (a `4xx` other than `408` and `429`, like a bad key).
- Pass an `AbortSignal` as `signal` to stop early. A `break` out of the loop stops it
  too.
- It connects at `baseUrl` (`FLOW_BASE_URL`), and needs a `WebSocket`: Node 22 and
  later have one. Elsewhere, pass one as `WebSocket`.

To see what is there now, without following:

<<< @/../examples/ts/streams/server.ts#snapshot

## Read in the browser

Give the browser a token from your own route, after your own check that the user may
see that stream:

<<< @/../examples/ts/streams/server.ts#token

Then read it with `readStream` from `@clevix/flow/realtime`:

<<< @/../examples/ts/streams/browser.ts#read-stream

- `refreshToken` is called before every connect.
- `onItem` gets every item, the end item too. Then `onEnd` is called, and reading
  stops. If the reader already had the end item, `onEnd` is called at once, with no
  item before it.
- `onGone` is called when the stream does not exist. Reading stops.
- It reconnects the same way as `flow.streams.read`, from the last offset it gave
  `onItem`. Call the function it gave back to stop.

## What to expect

- **Streams are short-lived.** They are for delivery, not storage: keep what must
  last in your own database.
- **Readers can come late.** Until the stream is deleted, a reader gets every item
  from its `after`.
- **No secrets in items** you would not show every reader with a token.
- The engine needs `REALTIME_TOKEN_SECRET` for tokens; without it, `token` fails with
  `503`.
- Streams are not counted on the plan yet.

See [Limits](limits.md#streams) for every limit, and the
[HTTP API](http-api.md#streams) for the routes.
