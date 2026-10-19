// Browser side of realtime: `@clevix/flow/realtime`. No server code in here.
//
//   const stop = subscribe({
//     refreshToken: () => fetch("/api/realtime-token").then((r) => r.json()),
//     onMessage: (m) => console.log(m.topic, m.data),
//   });
//
// It asks your server for a token (your server calls flow.realtime.token after its own
// user check), connects, and connects again after a drop (backoff 1 s up to 30 s) or
// when the engine ends the socket at the end of its life (close code 4001).

/** What `flow.realtime.token()` returns, and what `refreshToken` must give back. */
export interface RealtimeToken {
  token: string;
  /** The engine's WebSocket URL, e.g. "wss://worker.clevixstudio.com/v1/realtime/connect". */
  url: string;
  channel: string;
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

/** Close code the engine uses when a socket reaches the end of its life. */
export const CLOSE_EXPIRED = 4001;
const PING_MS = 30_000;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/** Subscribes until the returned function is called. */
export function subscribe<T = unknown>(options: SubscribeOptions<T>): () => void {
  const Socket = options.WebSocket ?? globalThis.WebSocket;
  if (!Socket) throw new Error("subscribe needs a WebSocket (pass options.WebSocket outside a browser)");
  let stopped = false;
  let ws: WebSocket | null = null;
  let ping: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;

  const setState = (state: RealtimeState, error?: Error) => {
    if (!stopped) options.onState?.(state, error);
  };

  const later = (now: boolean) => {
    if (stopped) return;
    if (now) {
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
    let token: RealtimeToken;
    try {
      token = await options.refreshToken();
    } catch (err) {
      setState("error", err instanceof Error ? err : new Error(String(err)));
      later(false);
      return;
    }
    if (stopped) return;
    const socket = new Socket(`${token.url}?token=${encodeURIComponent(token.token)}`);
    ws = socket;
    socket.onopen = () => {
      failures = 0;
      setState("open");
      ping = setInterval(() => {
        if (socket.readyState === socket.OPEN) socket.send("ping");
      }, PING_MS);
    };
    socket.onmessage = (event) => {
      if (event.data === "pong" || typeof event.data !== "string") return;
      let message: RealtimeMessage<T>;
      try {
        message = JSON.parse(event.data) as RealtimeMessage<T>;
      } catch {
        return;
      }
      if (!stopped) options.onMessage(message);
    };
    socket.onclose = (event) => {
      clearInterval(ping);
      if (ws === socket) ws = null;
      if (stopped) return;
      setState("closed");
      // The socket's life ended: a new token, right away. Anything else: back off.
      later(event.code === CLOSE_EXPIRED);
    };
    socket.onerror = () => setState("error", new Error("realtime socket error"));
  };

  void open();
  return () => {
    stopped = true;
    clearTimeout(retry);
    clearInterval(ping);
    ws?.close(1000, "unsubscribed");
    ws = null;
  };
}
