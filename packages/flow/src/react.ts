// React hook for realtime: `@clevix/flow/react`. React is an optional peer dependency.
//
//   const { latest, messages, state, error } = useRealtime({ enabled, refreshToken });

import { useEffect, useRef, useState } from "react";
import { subscribe, type RealtimeMessage, type RealtimeState, type RealtimeToken } from "./realtime.ts";

export type { RealtimeMessage, RealtimeState, RealtimeToken } from "./realtime.ts";

export interface UseRealtimeOptions {
  /** Gets a new token from your server. Called before every connect. */
  refreshToken: () => Promise<RealtimeToken>;
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
  const { enabled = true, bufferSize = 100 } = options;
  const [messages, setMessages] = useState<RealtimeMessage<T>[]>([]);
  const [state, setState] = useState<RealtimeState | "idle">("idle");
  const [error, setError] = useState<Error | undefined>(undefined);
  // The latest refreshToken, so a new function each render does not reconnect.
  const refresh = useRef(options.refreshToken);
  refresh.current = options.refreshToken;

  useEffect(() => {
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
  }, [enabled, bufferSize]);

  return { latest: messages[messages.length - 1], messages, state, error };
}
