import { signingKeyBearer } from "@clevix/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Flow } from "../src/index.ts";
import { CLOSE_EXPIRED, subscribe, type RealtimeToken } from "../src/realtime.ts";
import { FakeSocket, fakeFetch, flushPromises, sockets } from "./fakes.ts";

const KEY = `signkey-${"ab".repeat(32)}`;
const OLD_KEY = `signkey-${"cd".repeat(32)}`;

describe("flow.realtime (server)", () => {
  it("publishes with the app ID and the signing key bearer", async () => {
    const { fetch, calls } = fakeFetch(() => Response.json({ ok: true }, { status: 202 }));
    const flow = new Flow({ id: "shop", signingKey: KEY, baseUrl: "https://engine.test/", fetch });
    await flow.realtime.publish({ channel: "deployment:1", topic: "progress", data: { pct: 40 } });
    expect(calls).toEqual([
      {
        url: "https://engine.test/v1/realtime/publish",
        method: "POST",
        auth: `Bearer ${await signingKeyBearer(KEY)}`,
        contentType: "application/json",
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


describe("flow.realtime (server, agentic-kit)", () => {
  afterEach(() => {
    FakeSocket.all = [];
    vi.useRealTimers();
  });

  it("publishMany sends every message in one call", async () => {
    const { fetch, calls } = fakeFetch(() => Response.json({ ok: true, count: 2 }, { status: 202 }));
    const flow = new Flow({ id: "shop", signingKey: KEY, baseUrl: "https://engine.test", fetch });
    await flow.realtime.publishMany([
      { channel: "a", topic: "t", data: 1 },
      { channel: "b", topic: "t", data: { n: 2 } },
    ]);
    expect(calls).toEqual([
      {
        url: "https://engine.test/v1/realtime/publish",
        method: "POST",
        auth: `Bearer ${await signingKeyBearer(KEY)}`,
        contentType: "application/json",
        body: {
          appId: "shop",
          messages: [
            { channel: "a", topic: "t", data: 1 },
            { channel: "b", topic: "t", data: { n: 2 } },
          ],
        },
      },
    ]);
  });

  it("publishMany checks the count and throws with the engine's error", async () => {
    const { fetch, calls } = fakeFetch(() => Response.json({ error: "messages[1]: topic is required", status: 400 }, { status: 400 }));
    const flow = new Flow({ id: "shop", signingKey: KEY, baseUrl: "https://engine.test", fetch });
    await expect(flow.realtime.publishMany([])).rejects.toThrow("1 to 100 messages, not 0");
    const many = Array.from({ length: 101 }, () => ({ channel: "c", topic: "t", data: 1 }));
    await expect(flow.realtime.publishMany(many)).rejects.toThrow("not 101");
    expect(calls).toHaveLength(0);
    await expect(flow.realtime.publishMany([{ channel: "c", topic: "", data: 1 }])).rejects.toThrow(
      "realtime publishMany failed (400): messages[1]: topic is required",
    );
  });

  it("makes a token for many channels", async () => {
    const token = { token: "tok", url: "wss://e/v1/realtime/connect", channels: ["a", "b"], topics: ["t"], expiresAt: 1 };
    const { fetch, calls } = fakeFetch(() => Response.json(token));
    const flow = new Flow({ id: "shop", signingKey: KEY, baseUrl: "https://engine.test", fetch });
    expect(await flow.realtime.token({ channels: ["a", "b"], topics: ["t"] })).toEqual(token);
    expect(calls[0]?.body).toEqual({ appId: "shop", channels: ["a", "b"], topics: ["t"] });
  });

  function serverFlow() {
    let n = 0;
    const { fetch, calls } = fakeFetch(() => {
      n += 1;
      // The engine names a host the server can not reach (a proxy, or wrangler dev).
      return Response.json({ token: `tok ${n}`, url: "wss://public.example.com/v1/realtime/connect", channel: "c", topics: ["t"], expiresAt: 0 });
    });
    const flow = new Flow({ id: "shop", signingKey: KEY, baseUrl: "http://localhost:8787/", fetch });
    return { flow, calls };
  }

  it("subscribe makes its own token and connects at baseUrl, not the token's host", async () => {
    const { flow, calls } = serverFlow();
    const messages: unknown[] = [];
    const states: string[] = [];
    flow.realtime.subscribe({
      channel: "c",
      topics: ["t"],
      onMessage: (m) => messages.push(m.data),
      onState: (s) => states.push(s),
      WebSocket: FakeSocket as unknown as typeof WebSocket,
    });
    await sockets(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "http://localhost:8787/v1/realtime/token", body: { appId: "shop", channel: "c", topics: ["t"] } });
    expect(FakeSocket.all).toHaveLength(1);
    expect(FakeSocket.all[0]!.url).toBe("ws://localhost:8787/v1/realtime/connect?token=tok%201");
    expect(FakeSocket.all.some((ws) => ws.url.includes("public.example.com"))).toBe(false);
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.receive({ channel: "c", topic: "t", data: { n: 1 }, ts: 1 });
    expect(messages).toEqual([{ n: 1 }]);
    expect(states).toEqual(["connecting", "open"]);
  });

  it("subscribe asks a fresh token before every connect", async () => {
    const { flow, calls } = serverFlow();
    const stop = flow.realtime.subscribe({
      channels: ["a", "b"],
      topics: ["t"],
      onMessage: () => {},
      WebSocket: FakeSocket as unknown as typeof WebSocket,
    });
    await sockets(1);
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.drop(CLOSE_EXPIRED);
    await sockets(2);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toEqual({ appId: "shop", channels: ["a", "b"], topics: ["t"] });
    expect(FakeSocket.all[1]!.url).toBe("ws://localhost:8787/v1/realtime/connect?token=tok%202");
    stop();
    expect(FakeSocket.all[1]!.closedWith).toBe(1000);
  });

  it("subscribe uses wss for an https baseUrl", async () => {
    const { fetch } = fakeFetch(() => Response.json({ token: "t", url: "ws://other/v1/realtime/connect", channel: "c", topics: ["t"], expiresAt: 0 }));
    const flow = new Flow({ id: "shop", signingKey: KEY, baseUrl: "https://engine.test/flow", fetch });
    flow.realtime.subscribe({ channel: "c", topics: ["t"], onMessage: () => {}, WebSocket: FakeSocket as unknown as typeof WebSocket });
    await sockets(1);
    expect(FakeSocket.all[0]!.url).toBe("wss://engine.test/flow/v1/realtime/connect?token=t");
  });

  it("subscribe throws at once for bad options", () => {
    const { flow } = serverFlow();
    const WebSocket = FakeSocket as unknown as typeof globalThis.WebSocket;
    expect(() => flow.realtime.subscribe({ channel: "", topics: ["t"], onMessage: () => {}, WebSocket })).toThrow("needs a channel");
    expect(() => flow.realtime.subscribe({ channels: [], topics: ["t"], onMessage: () => {}, WebSocket })).toThrow("1 to 100 channels");
    const many = Array.from({ length: 101 }, (_, i) => `c${i}`);
    expect(() => flow.realtime.subscribe({ channels: many, topics: ["t"], onMessage: () => {}, WebSocket })).toThrow("1 to 100 channels");
    const both = { channel: "c", channels: ["a"], topics: ["t"], onMessage: () => {}, WebSocket } as unknown as Parameters<typeof flow.realtime.subscribe>[0];
    expect(() => flow.realtime.subscribe(both)).toThrow("give channel or channels, not both");
    expect(FakeSocket.all).toHaveLength(0);
  });

  it("token checks channels before any call", async () => {
    const { flow, calls } = serverFlow();
    await expect(flow.realtime.token({ channels: [], topics: ["t"] })).rejects.toThrow("channels must list 1 to 100 channels");
    const many = Array.from({ length: 101 }, (_, i) => `c${i}`);
    await expect(flow.realtime.token({ channels: many, topics: ["t"] })).rejects.toThrow("1 to 100 channels");
    const both = { channel: "c", channels: ["a"], topics: ["t"] } as unknown as { channel: string; topics: string[] };
    await expect(flow.realtime.token(both)).rejects.toThrow("not both");
    await expect(flow.realtime.token({ channel: "", topics: ["t"] })).rejects.toThrow("needs a channel");
    // 100 names of 81 characters: 8,100 characters in all.
    const long = Array.from({ length: 100 }, (_, i) => `${i}`.padStart(81, "x"));
    await expect(flow.realtime.token({ channels: long, topics: ["t"] })).rejects.toThrow("8100 characters of names in all (at most 8000)");
    expect(() =>
      flow.realtime.subscribe({ channels: long, topics: ["t"], onMessage: () => {}, WebSocket: FakeSocket as unknown as typeof WebSocket }),
    ).toThrow("at most 8000");
    expect(calls).toHaveLength(0);
    await flow.realtime.token({ channels: long.map((c) => c.slice(1)), topics: ["t"] }); // 8,000 is fine
    await flow.realtime.token({ channels: Array.from({ length: 100 }, (_, i) => `c${i}`), topics: ["t"] });
    expect(calls).toHaveLength(2);
    expect(() => flow.realtime.subscribe({ channel: "c", topics: [], onMessage: () => {}, WebSocket })).toThrow("at least one topic");
  });
});

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

  it("passes a closing frame on as a message (only stream readers act on it)", async () => {
    const { messages, refreshToken } = start();
    await flushPromises();
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.receive({ closing: 4001 });
    expect(FakeSocket.all[0]!.closedWith).toBeNull();
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(messages).toEqual([undefined]);
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

  it("keeps trying when the token route gives back something that is not a token", async () => {
    vi.useFakeTimers();
    const states: string[] = [];
    const refreshToken = vi.fn(async () => ({ error: "forbidden" }) as unknown as RealtimeToken);
    subscribe({
      refreshToken,
      onMessage: () => {},
      onState: (s) => states.push(s),
      WebSocket: FakeSocket as unknown as typeof WebSocket,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toEqual(["connecting", "error"]);
    expect(FakeSocket.all).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(refreshToken).toHaveBeenCalledTimes(2);
  });

  it("keeps trying when the WebSocket constructor throws", async () => {
    vi.useFakeTimers();
    let calls = 0;
    class Throwing {
      constructor() {
        calls += 1;
        throw new SyntaxError("Invalid URL");
      }
    }
    const states: string[] = [];
    subscribe({
      refreshToken: async () => ({ token: "t", url: "bad url", channel: "c", topics: ["t"], expiresAt: 0 }),
      onMessage: () => {},
      onState: (s) => states.push(s),
      WebSocket: Throwing as unknown as typeof WebSocket,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toEqual(["connecting", "error"]);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(calls).toBe(2);
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
