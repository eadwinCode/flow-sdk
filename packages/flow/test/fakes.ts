// Stand-ins for fetch and WebSocket that the tests drive by hand.

import { vi } from "vitest";

export interface FakeCall {
  url: string;
  method: string;
  auth: string | undefined;
  contentType: string | undefined;
  /** The JSON body, or undefined when there was none. */
  body: unknown;
}

/** A fetch that records each call and answers with `answer`. */
export function fakeFetch(answer: (url: string, init: RequestInit) => Response) {
  const calls: FakeCall[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: init.method ?? "GET",
      auth: headers.Authorization,
      contentType: headers["Content-Type"],
      body: init.body === undefined ? undefined : JSON.parse(init.body as string),
    });
    return answer(url, init);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

/** A WebSocket stand-in the test drives by hand. */
export class FakeSocket {
  static all: FakeSocket[] = [];
  readonly OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  closedWith: number | null = null;
  private listeners: Record<string, Array<(e: unknown) => void>> = {};
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  addEventListener(type: string, listener: (e: unknown) => void) {
    (this.listeners[type] ??= []).push(listener);
  }
  private fire(type: string, event: unknown = {}) {
    for (const listener of this.listeners[type] ?? []) listener(event);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code = 1000) {
    this.closedWith = code;
  }
  // driven by the test
  open() {
    this.readyState = 1;
    this.fire("open");
  }
  receive(data: unknown) {
    this.fire("message", { data: typeof data === "string" ? data : JSON.stringify(data) });
  }
  drop(code: number) {
    this.readyState = 3;
    this.fire("close", { code });
  }
  error() {
    this.fire("error");
  }
}

export const flushPromises = () => new Promise((r) => setTimeout(r, 0));

/**
 * Waits until `n` sockets were made. A server helper's token call signs with
 * crypto.subtle first, which can take more than one tick. With fake timers, each check
 * moves the clock 1 ms.
 */
export async function sockets(n: number): Promise<FakeSocket> {
  await vi.waitFor(
    () => {
      if (FakeSocket.all.length < n) throw new Error(`waiting for socket ${n}`);
    },
    { timeout: 2000, interval: 1 },
  );
  return FakeSocket.all[n - 1]!;
}
