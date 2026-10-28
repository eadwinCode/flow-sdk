// The socket loop that realtime and stream readers share. Internal: apps use
// `subscribe` and `readStream` from `@clevix/flow/realtime`, or `flow.realtime.subscribe`
// and `flow.streams.read` on a server. No server code in here.

import { StreamGoneError } from "./errors.ts";
import type { RealtimeMessage, RealtimeState, RealtimeToken, ReadStreamOptions, StreamItem, StreamToken, SubscribeOptions } from "./realtime.ts";

/** Close code the engine uses when a socket reaches the end of its life. */
export const CLOSE_EXPIRED = 4001;
/** Close code the engine uses when a stream is gone (never opened, or deleted). */
export const CLOSE_GONE = 4404;
/** Close code the engine uses when a stream is closed and has nothing after `after`. */
export const CLOSE_ENDED = 4100;
const PING_MS = 30_000;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
/** A socket open this long when it closes counts as a good one: the backoff starts again. */
const MIN_STABLE_MS = 10_000;

/** What to do after a socket closed: connect again at once, after a backoff, or stop. */
type Next = "now" | "later" | "stop";

/** WebSocket.OPEN. */
const OPEN = 1;

/**
 * The part of a WebSocket the loop uses. Its own type, so the SDK type-checks with the
 * DOM's WebSocket and with the Workers one. Events go through addEventListener: Workers
 * fire them only that way, and browsers and Node do too.
 */
interface LoopSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number }) => void): void;
}

interface LoopOptions {
  /** "realtime" or "stream", for error messages. */
  label: string;
  /** The URL to connect to. Called before every connect. */
  connectUrl: () => Promise<string>;
  /**
   * Gets each text frame. A close code back means the engine said it is closing the
   * socket with that code: the loop closes it now and acts on the code at once.
   */
  onText: (text: string) => number | void;
  /** Default: at once on 4001, else after a backoff. */
  afterClose?: (code: number) => Next;
  /** An error from `connectUrl`. Default: try again after a backoff. */
  afterError?: (error: Error) => Next;
  onState?: (state: RealtimeState, error?: Error) => void;
  WebSocket?: typeof WebSocket;
}

/**
 * Connects, and connects again after a drop (backoff 1 s up to 30 s, times a random
 * 0.5 to 1.0) or at once when the engine ends the socket at the end of its life
 * (close code 4001). Sends "ping" every 30 s. Runs until the returned function is called.
 */
export function socketLoop(options: LoopOptions): () => void {
  const Socket = (options.WebSocket ?? globalThis.WebSocket) as unknown as (new (url: string) => LoopSocket) | undefined;
  if (!Socket) throw new Error(`${options.label} needs a WebSocket (pass options.WebSocket outside a browser)`);
  let stopped = false;
  let ws: LoopSocket | null = null;
  let ping: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;

  const setState = (state: RealtimeState, error?: Error) => {
    if (!stopped) options.onState?.(state, error);
  };

  const stop = () => {
    stopped = true;
    if (retry !== undefined) clearTimeout(retry);
    if (ping !== undefined) clearInterval(ping);
    ws?.close(1000, "unsubscribed");
    ws = null;
  };

  const later = (next: Next) => {
    if (stopped) return;
    if (next === "stop") {
      stop();
      return;
    }
    if (next === "now") {
      void open();
      return;
    }
    const base = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** failures);
    failures += 1;
    retry = setTimeout(() => void open(), base * (0.5 + Math.random() / 2));
  };

  const open = async () => {
    if (stopped) return;
    setState("connecting");
    let socket: LoopSocket;
    try {
      const url = await options.connectUrl();
      if (stopped) return;
      // The constructor throws on a bad URL; that must not end the reconnect loop.
      socket = new Socket(url);
    } catch (err) {
      // Stopped while the token call ran: nothing more to report.
      if (stopped) return;
      const error = err instanceof Error ? err : new Error(String(err));
      setState("error", error);
      later(options.afterError?.(error) ?? "later");
      return;
    }
    ws = socket;
    // Acts on this socket's close once: on a `closing` frame, or on the close event,
    // which some clients (Node's) report seconds late.
    let closedDone = false;
    let openedAt: number | undefined;
    const closed = (code: number) => {
      if (closedDone) return;
      closedDone = true;
      // Only a socket that stayed open a while resets the backoff. One the engine
      // takes and then closes at once counts as a failure, so the waits still grow.
      if (openedAt !== undefined && Date.now() - openedAt >= MIN_STABLE_MS) failures = 0;
      if (ping !== undefined) clearInterval(ping);
      if (ws === socket) ws = null;
      if (stopped) return;
      setState("closed");
      // The socket's life ended: a new token, right away. Anything else: back off.
      later(options.afterClose?.(code) ?? (code === CLOSE_EXPIRED ? "now" : "later"));
    };
    socket.addEventListener("open", () => {
      openedAt = Date.now();
      setState("open");
      ping = setInterval(() => {
        if (socket.readyState === OPEN) socket.send("ping");
      }, PING_MS);
    });
    socket.addEventListener("message", (event) => {
      if (stopped || closedDone || event.data === "pong" || typeof event.data !== "string") return;
      const closing = options.onText(event.data);
      if (typeof closing === "number") {
        socket.close(1000, "closing");
        closed(closing);
      }
    });
    socket.addEventListener("close", (event) => closed(event.code));
    socket.addEventListener("error", () => {
      // A late error from a socket already handled says nothing new.
      if (!closedDone) setState("error", new Error(`${options.label} socket error`));
    });
  };

  void open();
  return stop;
}

/** Builds the URL to connect to from a token. */
export type SocketUrl = (token: { url: string; token: string }) => string;

/** The browser way: the URL in the token, as the engine gave it. */
export const tokenUrl: SocketUrl = (token) => `${token.url}?token=${encodeURIComponent(token.token)}`;

/**
 * The server way: the client's `baseUrl` (http to ws, https to wss) and the path of the
 * token's URL. The engine builds `token.url` from the host it thinks it has, which is
 * wrong behind a proxy and in `wrangler dev`; a server already reaches it at `baseUrl`.
 */
export function baseSocketUrl(baseUrl: string): SocketUrl {
  const base = baseUrl.replace(/\/+$/, "").replace(/^http/, "ws");
  return (token) => `${base}${new URL(token.url).pathname}?token=${encodeURIComponent(token.token)}`;
}

function checkToken(token: { url?: unknown; token?: unknown } | null | undefined): void {
  if (!token || typeof token.url !== "string" || typeof token.token !== "string") {
    throw new Error("refreshToken did not return a token (check that your token route answered 200)");
  }
}

/** `subscribe`, with the way to build the URL. */
export function subscribeWith<T>(options: SubscribeOptions<T>, urlOf: SocketUrl): () => void {
  return socketLoop({
    label: "realtime",
    connectUrl: async () => {
      const token: RealtimeToken = await options.refreshToken();
      checkToken(token);
      return urlOf(token);
    },
    onText: (text) => {
      let message: RealtimeMessage<T>;
      try {
        message = JSON.parse(text) as RealtimeMessage<T>;
      } catch {
        return;
      }
      options.onMessage(message);
    },
    onState: options.onState,
    WebSocket: options.WebSocket,
  });
}

/**
 * Throws for an `after` the engine would refuse: digits only, up to 15. The engine
 * answers 400 on the upgrade, so connecting again would never help.
 */
export function checkAfter(after: string | undefined): void {
  if (after !== undefined && !/^\d{0,15}$/.test(after)) {
    throw new Error(`invalid stream offset "${after}": use an offset the stream gave you`);
  }
}

/** Internal options of the stream reader, for `flow.streams.read`. */
export interface StreamReaderOptions<T> extends ReadStreamOptions<T> {
  /** True for a token call error that will not go away: reading stops, and `onFail` gets it. */
  stopOn?: (error: Error) => boolean;
  onFail?: (error: Error) => void;
}

/** `readStream`, with the way to build the URL. */
export function readStreamWith<T>(options: StreamReaderOptions<T>, urlOf: SocketUrl): () => void {
  checkAfter(options.after);
  // The last offset given to onItem: a new connect starts after it.
  let after = options.after ?? "";
  let streamId = "";
  const gone = (error: StreamGoneError): Next => {
    options.onGone?.(error);
    return "stop";
  };
  const stop = socketLoop({
    label: "stream",
    connectUrl: async () => {
      const token: StreamToken = await options.refreshToken();
      checkToken(token);
      streamId = token.stream;
      const url = urlOf(token);
      return after ? `${url}&after=${encodeURIComponent(after)}` : url;
    },
    onText: (text) => {
      let item: StreamItem<T> & { closing?: unknown };
      try {
        item = JSON.parse(text) as StreamItem<T> & { closing?: unknown };
      } catch {
        return;
      }
      if (!item || typeof item !== "object") return;
      // `{ "closing": 4100 }`: the engine closes the socket next. Never an item.
      if ("closing" in item) return typeof item.closing === "number" ? item.closing : undefined;
      if (typeof item.offset !== "string") return;
      after = item.offset;
      options.onItem(item);
      if (item.end) {
        // The end item is the last: the engine closes the socket after it.
        stop();
        options.onEnd?.();
      }
    },
    afterClose: (code) => {
      if (code === CLOSE_GONE) return gone(new StreamGoneError(streamId));
      if (code === CLOSE_ENDED) {
        // The reader already had the end item: end quietly, with no item.
        options.onEnd?.();
        return "stop";
      }
      return code === CLOSE_EXPIRED ? "now" : "later";
    },
    // The token call may already know the stream is gone (flow.streams.token throws it).
    afterError: (error) => {
      if (error instanceof StreamGoneError) return gone(error);
      if (options.stopOn?.(error)) {
        options.onFail?.(error);
        return "stop";
      }
      return "later";
    },
    onState: options.onState,
    WebSocket: options.WebSocket,
  });
  return stop;
}
