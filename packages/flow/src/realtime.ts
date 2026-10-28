// Browser side of realtime and streams: `@clevix/flow/realtime`. No server code in here.
//
//   const stop = subscribe({
//     refreshToken: () => fetch("/api/realtime-token").then((r) => r.json()),
//     onMessage: (m) => console.log(m.topic, m.data),
//   });
//
// It asks your server for a token (your server calls flow.realtime.token after its own
// user check), connects, and connects again after a drop (backoff 1 s up to 30 s) or
// when the engine ends the socket at the end of its life (close code 4001).
//
// `readStream` reads a stream the same way (your server calls flow.streams.token), and
// connects again from the last offset it gave you.

import type { StreamGoneError } from "./errors.ts";
import { readStreamWith, subscribeWith, tokenUrl } from "./socket.ts";

export { CLOSE_ENDED, CLOSE_EXPIRED, CLOSE_GONE } from "./socket.ts";
export { StreamGoneError } from "./errors.ts";

/** What `flow.realtime.token()` returns, and what `refreshToken` must give back. */
export interface RealtimeToken {
  token: string;
  /** The engine's WebSocket URL, e.g. "wss://worker.flow.clevixstudio.com/v1/realtime/connect". */
  url: string;
  /** The channel of a one-channel token. A token for many channels has `channels` instead. */
  channel?: string;
  /** The channels of a token for many channels, instead of `channel`. */
  channels?: string[];
  topics: string[];
  /** Connect deadline, ms since epoch (about a minute after it was made). */
  expiresAt: number;
}

export interface RealtimeMessage<T = unknown> {
  channel: string;
  topic: string;
  data: T;
  /** When the engine got the publish, ms since epoch. */
  ts: number;
}

export type RealtimeState = "connecting" | "open" | "closed" | "error";

export interface SubscribeOptions<T = unknown> {
  /** Gets a new token from your server. Called before every connect. */
  refreshToken: () => Promise<RealtimeToken>;
  onMessage: (message: RealtimeMessage<T>) => void;
  onState?: (state: RealtimeState, error?: Error) => void;
  /** For tests or other runtimes. Default: the global WebSocket. */
  WebSocket?: typeof WebSocket;
}

/** Subscribes until the returned function is called. */
export function subscribe<T = unknown>(options: SubscribeOptions<T>): () => void {
  return subscribeWith(options, tokenUrl);
}

/** What `flow.streams.token()` returns, and what `readStream`'s `refreshToken` must give back. */
export interface StreamToken {
  token: string;
  /** The engine's WebSocket URL, e.g. "wss://worker.flow.clevixstudio.com/v1/streams/connect". */
  url: string;
  stream: string;
  /** Connect deadline, ms since epoch (about a minute after it was made). */
  expiresAt: number;
}

/** One item of a stream. */
export interface StreamItem<T = unknown> {
  /** Its place in the stream, as text ("1", "2", ...). Pass it back as `after`. */
  offset: string;
  item: T;
  /** Set on the end item, the last one, that `close` wrote. */
  end?: true;
}

export interface ReadStreamOptions<T = unknown> {
  /** Gets a new token from your server. Called before every connect. */
  refreshToken: () => Promise<StreamToken>;
  /** Start after this offset. Default: from the start. */
  after?: string;
  /** Gets every item, the end item too. */
  onItem: (item: StreamItem<T>) => void;
  /**
   * The stream has ended. Reading stops. Called with nothing: after `onItem` got the end
   * item, or at once when the stream was closed and had nothing after `after` (the
   * reader already had the end item).
   */
  onEnd?: () => void;
  /** The stream is gone (never opened, or deleted). Reading stops. */
  onGone?: (error: StreamGoneError) => void;
  onState?: (state: RealtimeState, error?: Error) => void;
  /** For tests or other runtimes. Default: the global WebSocket. */
  WebSocket?: typeof WebSocket;
}

/**
 * Reads a stream until the end item, until it is gone, or until the returned function
 * is called. After a drop it connects again from the last offset it gave `onItem`.
 */
export function readStream<T = unknown>(options: ReadStreamOptions<T>): () => void {
  return readStreamWith(options, tokenUrl);
}
