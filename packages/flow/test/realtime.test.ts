import { signingKeyBearer } from "@clevix/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Flow } from "../src/index.ts";
import { CLOSE_EXPIRED, subscribe, type RealtimeToken } from "../src/realtime.ts";

const KEY = `signkey-${"ab".repeat(32)}`;
const OLD_KEY = `signkey-${"cd".repeat(32)}`;

function fakeFetch(answer: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; auth: string | undefined; body: unknown }> = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    calls.push({ url, auth: headers.Authorization, body: JSON.parse(init.body as string) });
    return answer(url, init);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("flow.realtime (server)", () => {
  it("publishes with the app ID and the signing key bearer", async () => {
    const { fetch, calls } = fakeFetch(() => Response.json({ ok: true }, { status: 202 }));
    const flow = new Flow({ id: "shop", signingKey: KEY, baseUrl: "https://engine.test/", fetch });
    await flow.realtime.publish({ channel: "deployment:1", topic: "progress", data: { pct: 40 } });
    expect(calls).toEqual([
      {
        url: "https://engine.test/v1/realtime/publish",
        auth: `Bearer ${await signingKeyBearer(KEY)}`,
        body: { appId: "shop", channel: "deployment:1", topic: "progress", data: { pct: 40 } },
      },
    ]);
  });

  it("throws with the engine's error", async () => {
    const { fetch } = fakeFetch(() => Response.json({ error: "data is required" }, { status: 400 }));
    const flow = new Flow({ id: "shop", signingKey: KEY, baseUrl: "https://engine.test", fetch });
    await expect(flow.realtime.publish({ channel: "c", topic: "t", data: null })).rejects.toThrow(
      "realtime publish failed (400): data is required",
    );
  });

  it("makes a token", async () => {
    const token: RealtimeToken = { token: "tok", url: "wss://e/v1/realtime/connect", channel: "c", topics: ["t"], expiresAt: 1 };
    const { fetch, calls } = fakeFetch(() => Response.json(token));
    const flow = new Flow({ id: "shop", signingKey: KEY, baseUrl: "https://engine.test", fetch });
    expect(await flow.realtime.token({ channel: "c", topics: ["t"] })).toEqual(token);
    expect(calls[0]?.url).toBe("https://engine.test/v1/realtime/token");
    expect(calls[0]?.body).toEqual({ appId: "shop", channel: "c", topics: ["t"] });
    await expect(flow.realtime.token({ channel: "c", topics: [] })).rejects.toThrow("at least one topic");
  });

  it("tries the fallback key on a 401", async () => {
    const good = `Bearer ${await signingKeyBearer(OLD_KEY)}`;
    const { fetch, calls } = fakeFetch((_url, init) =>
      (init.headers as Record<string, string>).Authorization === good
        ? Response.json({ ok: true }, { status: 202 })
        : Response.json({ error: "invalid signing key" }, { status: 401 }),
    );
    const flow = new Flow({ id: "shop", signingKey: KEY, signingKeyFallback: OLD_KEY, baseUrl: "https://engine.test", fetch });
    await flow.realtime.publish({ channel: "c", topic: "t", data: 1 });
    expect(calls).toHaveLength(2);
  });
});

/** A WebSocket stand-in the test drives by hand. */
class FakeSocket {
  static all: FakeSocket[] = [];
  readonly OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  closedWith: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
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
    this.onopen?.();
  }
  receive(data: unknown) {
    this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) });
  }
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const flushPromises = () => new Promise((r) => setTimeout(r, 0));

describe("subscribe (browser)", () => {
  afterEach(() => {
    FakeSocket.all = [];
    vi.useRealTimers();
  });

  function start() {
    let n = 0;
    const refreshToken = vi.fn(async (): Promise<RealtimeToken> => {
      n += 1;
      return { token: `tok ${n}`, url: "wss://engine.test/v1/realtime/connect", channel: "c", topics: ["t"], expiresAt: 0 };
    });
    const messages: unknown[] = [];
    const states: string[] = [];
    const stop = subscribe({
      refreshToken,
      onMessage: (m) => messages.push(m.data),
      onState: (s) => states.push(s),
      WebSocket: FakeSocket as unknown as typeof WebSocket,
    });
    return { refreshToken, messages, states, stop };
  }

  it("connects with the token and passes messages on", async () => {
    const { messages, states } = start();
    await flushPromises();
    const ws = FakeSocket.all[0]!;
    expect(ws.url).toBe("wss://engine.test/v1/realtime/connect?token=tok%201");
    ws.open();
    ws.receive({ channel: "c", topic: "t", data: { n: 1 }, ts: 1 });
    ws.receive("pong");
    ws.receive("not json");
    expect(messages).toEqual([{ n: 1 }]);
    expect(states).toEqual(["connecting", "open"]);
  });

  it("gets a new token and connects again at once after 4001", async () => {
    const { refreshToken } = start();
    await flushPromises();
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.drop(CLOSE_EXPIRED);
    await flushPromises();
    expect(refreshToken).toHaveBeenCalledTimes(2);
    expect(FakeSocket.all[1]!.url).toContain("tok%202");
  });

  it("backs off after a drop", async () => {
    vi.useFakeTimers();
    const { refreshToken } = start();
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.all[0]!.drop(1006);
    await vi.advanceTimersByTimeAsync(400);
    expect(refreshToken).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(700);
    expect(refreshToken).toHaveBeenCalledTimes(2);
  });

  it("pings every 30 s while open", async () => {
    vi.useFakeTimers();
    start();
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.all[0]!.open();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeSocket.all[0]!.sent).toEqual(["ping"]);
  });

  it("stop closes the socket and does not connect again", async () => {
    const { stop, refreshToken } = start();
    await flushPromises();
    const ws = FakeSocket.all[0]!;
    ws.open();
    stop();
    expect(ws.closedWith).toBe(1000);
    ws.drop(1000);
    await flushPromises();
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });
});
