// React hook for realtime: `@clevix/flow/react`. React is an optional peer dependency.
//
//   const { latest, messages, state, error } = useRealtime({ channel, enabled, refreshToken });

import { useEffect, useRef, useState } from "react";
import { subscribe, type RealtimeMessage, type RealtimeState, type RealtimeToken } from "./realtime.ts";

export type { RealtimeMessage, RealtimeState, RealtimeToken } from "./realtime.ts";

export interface UseRealtimeOptions {
  /** Gets a new token from your server. Called before every connect. */
  refreshToken: () => Promise<RealtimeToken>;
  /**
   * What the token is for, e.g. the channel name. When it changes, the hook drops its
   * messages and connects again with a new token. A new `refreshToken` function alone
   * does not reconnect.
   */
  channel?: string;
  /** False closes the socket. Default true. */
  enabled?: boolean;
  /** How many messages `messages` keeps (newest last). Default 100. */
  bufferSize?: number;
}

export interface UseRealtimeResult<T> {
  latest: RealtimeMessage<T> | undefined;
  messages: RealtimeMessage<T>[];
  state: RealtimeState | "idle";
  error: Error | undefined;
}

export function useRealtime<T = unknown>(options: UseRealtimeOptions): UseRealtimeResult<T> {
  const { enabled = true, bufferSize = 100, channel } = options;
  const [messages, setMessages] = useState<RealtimeMessage<T>[]>([]);
  const [state, setState] = useState<RealtimeState | "idle">("idle");
  const [error, setError] = useState<Error | undefined>(undefined);
  // The latest refreshToken, so a new function each render does not reconnect.
  const refresh = useRef(options.refreshToken);
  refresh.current = options.refreshToken;

  useEffect(() => {
    // A new session: messages from the last one (another channel, or before a pause) go.
    setMessages([]);
    setError(undefined);
    if (!enabled) {
      setState("idle");
      return;
    }
    const stop = subscribe<T>({
      refreshToken: () => refresh.current(),
      onMessage: (m) => setMessages((list) => [...list, m].slice(-bufferSize)),
      onState: (s, err) => {
        setState(s);
        if (s === "open") setError(undefined);
        if (err) setError(err);
      },
    });
    return stop;
  }, [enabled, bufferSize, channel]);

  return { latest: messages[messages.length - 1], messages, state, error };
}
