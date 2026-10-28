import { signingKeyBearer } from "@clevix/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Flow, StreamClosedError, StreamGoneError, type StreamItem } from "../src/index.ts";
import { CLOSE_ENDED, CLOSE_EXPIRED, CLOSE_GONE, readStream, type StreamToken } from "../src/realtime.ts";
import { FakeSocket, fakeFetch, flushPromises, sockets } from "./fakes.ts";

const KEY = `signkey-${"ab".repeat(32)}`;
const OLD_KEY = `signkey-${"cd".repeat(32)}`;
const BASE = "https://engine.test";
const WebSocket = FakeSocket as unknown as typeof globalThis.WebSocket;

function client(answer: (url: string, init: RequestInit) => Response) {
  const { fetch, calls } = fakeFetch(answer);
  return { flow: new Flow({ id: "shop", signingKey: KEY, baseUrl: BASE, fetch }), calls };
}

const gone = () => Response.json({ error: "stream s1 is gone", status: 404, code: "StreamGone" }, { status: 404 });

describe("flow.streams (HTTP)", () => {
  it("open sends meta and the ttl in ms", async () => {
    const { flow, calls } = client(() => Response.json({ created: true }));
    expect(await flow.streams.open("run:1.seg_2", { meta: { threadId: "t" }, ttl: "1m" })).toEqual({ created: true });
    expect(calls).toEqual([
      {
        url: `${BASE}/v1/streams/run%3A1.seg_2/open`,
        method: "POST",
        auth: `Bearer ${await signingKeyBearer(KEY)}`,
        contentType: "application/json",
        body: { appId: "shop", meta: { threadId: "t" }, ttlMs: 60_000 },
      },
    ]);
  });

  it("open with a number ttl and no meta", async () => {
    const { flow, calls } = client(() => Response.json({ created: false }));
    expect(await flow.streams.open("s1", { ttl: 5000 })).toEqual({ created: false });
    expect(calls[0]!.body).toEqual({ appId: "shop", ttlMs: 5000 });
  });

  it("append gives back the offsets", async () => {
    const { flow, calls } = client(() => Response.json({ offsets: ["1", "2"] }));
    expect(await flow.streams.append("s1", [{ t: "a" }, "b"])).toEqual(["1", "2"]);
    expect(calls[0]).toMatchObject({ url: `${BASE}/v1/streams/s1/append`, method: "POST", body: { appId: "shop", items: [{ t: "a" }, "b"] } });
  });

  it("append throws StreamGoneError and StreamClosedError for the engine's codes", async () => {
    let answer = gone();
    const { flow } = client(() => answer);
    const err = await flow.streams.append("s1", [1]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StreamGoneError);
    expect(err).toMatchObject({ name: "StreamGoneError", streamId: "s1" });

    answer = Response.json({ error: "closed", status: 409, code: "StreamClosed" }, { status: 409 });
    const closed = await flow.streams.append("s1", [1]).catch((e: unknown) => e);
    expect(closed).toBeInstanceOf(StreamClosedError);
    expect(closed).toMatchObject({ name: "StreamClosedError", streamId: "s1" });

    answer = Response.json({ error: "stream s1 is full", status: 413, code: "StreamFull" }, { status: 413 });
    await expect(flow.streams.append("s1", [1])).rejects.toThrow("stream append failed (413): stream s1 is full");
  });

  it("a 404 with no StreamGone code is a plain error (an engine with no streams)", async () => {
    const { flow } = client(() => new Response("not found", { status: 404 }));
    const err = await flow.streams.append("s1", [1]).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(StreamGoneError);
    expect(err).toMatchObject({ message: "stream append failed (404): not found" });
  });

  it("snapshot reads every page from the last offset", async () => {
    const pages = [
      { meta: { m: 1 }, items: [{ offset: "3", item: "a" }, { offset: "4", item: "b" }], ended: false, more: true },
      { meta: { m: 1 }, items: [{ offset: "5", item: "end", end: true }], ended: true, more: false },
    ];
    let i = 0;
    const { flow, calls } = client(() => Response.json(pages[i++]));
    expect(await flow.streams.snapshot("s1", { after: "2" })).toEqual({
      meta: { m: 1 },
      items: [
        { offset: "3", item: "a" },
        { offset: "4", item: "b" },
        { offset: "5", item: "end", end: true },
      ],
      ended: true,
    });
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ["GET", `${BASE}/v1/streams/s1?after=2&appId=shop`, undefined],
      ["GET", `${BASE}/v1/streams/s1?after=4&appId=shop`, undefined],
    ]);
  });

  it("snapshot from the start sends no after, and is null when the stream is gone", async () => {
    const { flow, calls } = client(gone);
    expect(await flow.streams.snapshot("s1")).toBeNull();
    expect(calls[0]!.url).toBe(`${BASE}/v1/streams/s1?appId=shop`);
  });

  it("close sends the end item and the grace in ms", async () => {
    const { flow, calls } = client(() => Response.json({ closed: true }));
    expect(await flow.streams.close("s1", { end: { done: true }, grace: "30s" })).toEqual({ closed: true });
    expect(calls[0]).toMatchObject({ url: `${BASE}/v1/streams/s1/close`, method: "POST", body: { appId: "shop", end: { done: true }, graceMs: 30_000 } });
  });

  it("close throws StreamGoneError", async () => {
    const { flow } = client(gone);
    await expect(flow.streams.close("s1", { end: null, grace: 0 })).rejects.toBeInstanceOf(StreamGoneError);
  });

  it("delete uses DELETE with the app ID in the query, and tries the fallback key", async () => {
    const good = `Bearer ${await signingKeyBearer(OLD_KEY)}`;
    const { fetch, calls } = fakeFetch((_url, init) =>
      (init.headers as Record<string, string>).Authorization === good
        ? Response.json({ deleted: true })
        : Response.json({ error: "invalid signing key", status: 401 }, { status: 401 }),
    );
    const flow = new Flow({ id: "shop", signingKey: KEY, signingKeyFallback: OLD_KEY, baseUrl: BASE, fetch });
    expect(await flow.streams.delete("s1")).toEqual({ deleted: true });
    expect(calls.map((c) => [c.method, c.url, c.body, c.auth])).toEqual([
      ["DELETE", `${BASE}/v1/streams/s1?appId=shop`, undefined, `Bearer ${await signingKeyBearer(KEY)}`],
      ["DELETE", `${BASE}/v1/streams/s1?appId=shop`, undefined, good],
    ]);
  });

  it("token posts the stream ID", async () => {
    const token: StreamToken = { token: "tok", url: "wss://e/v1/streams/connect", stream: "s1", expiresAt: 1 };
    const { flow, calls } = client(() => Response.json(token));
    expect(await flow.streams.token("s1")).toEqual(token);
    expect(calls[0]).toMatchObject({ url: `${BASE}/v1/streams/token`, method: "POST", body: { appId: "shop", stream: "s1" } });
  });

  it("refuses a bad stream ID before any call", async () => {
    const { flow, calls } = client(() => Response.json({}));
    await expect(flow.streams.append("a/b", [1])).rejects.toThrow('invalid stream id "a/b"');
    await expect(flow.streams.open("x".repeat(257), { ttl: "1m" })).rejects.toThrow("invalid stream id");
    expect(() => flow.streams.read("")).toThrow("invalid stream id");
    await expect(flow.streams.delete("..")).rejects.toThrow('invalid stream id ".."');
    await expect(flow.streams.snapshot(".")).rejects.toThrow("invalid stream id");
    await expect(flow.streams.open("token", { ttl: "1m" })).rejects.toThrow('invalid stream id "token"');
    await expect(flow.streams.append("connect", [1])).rejects.toThrow('invalid stream id "connect"');
    expect(() => flow.streams.read("token")).toThrow("invalid stream id");
    expect(calls).toHaveLength(0);
    // Close to a reserved name is fine.
    expect(() => flow.streams.read("tokens")).not.toThrow();
  });
});

describe("flow.streams.read (server)", () => {
  afterEach(() => {
    FakeSocket.all = [];
    vi.useRealTimers();
  });

  function reader(after?: string, signal?: AbortSignal) {
    let n = 0;
    const { flow, calls } = client(() => {
      n += 1;
      // The engine names a host the server can not reach.
      return Response.json({ token: `tok ${n}`, url: "wss://public.example.com/v1/streams/connect", stream: "s1", expiresAt: 0 });
    });
    const items = flow.streams.read("s1", { WebSocket, ...(after ? { after } : {}), ...(signal ? { signal } : {}) });
    const got: StreamItem[] = [];
    const done = (async () => {
      for await (const item of items) got.push(item);
    })();
    return { calls, got, done };
  }

  it("reads the backlog and stops after the end item", async () => {
    const { calls, got, done } = reader("2");
    await sockets(1);
    expect(calls[0]).toMatchObject({ url: `${BASE}/v1/streams/token`, body: { appId: "shop", stream: "s1" } });
    const ws = FakeSocket.all[0]!;
    // baseUrl, not the token's host.
    expect(ws.url).toBe("wss://engine.test/v1/streams/connect?token=tok%201&after=2");
    ws.open();
    ws.receive({ offset: "3", item: "a" });
    ws.receive("pong");
    ws.receive({ offset: "4", item: { b: 1 } });
    ws.receive({ offset: "5", item: "bye", end: true });
    await done;
    expect(got).toEqual([
      { offset: "3", item: "a" },
      { offset: "4", item: { b: 1 } },
      { offset: "5", item: "bye", end: true },
    ]);
    expect(ws.closedWith).toBe(1000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("connects again from the last offset after a drop, with backoff", async () => {
    vi.useFakeTimers();
    const { calls, got, done } = reader();
    await sockets(1);
    expect(FakeSocket.all[0]!.url).toBe("wss://engine.test/v1/streams/connect?token=tok%201");
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.receive({ offset: "1", item: "a" });
    FakeSocket.all[0]!.receive({ offset: "2", item: "b" });
    FakeSocket.all[0]!.drop(1006);
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(700);
    await sockets(2);
    expect(calls).toHaveLength(2);
    expect(FakeSocket.all[1]!.url).toBe("wss://engine.test/v1/streams/connect?token=tok%202&after=2");
    FakeSocket.all[1]!.open();
    FakeSocket.all[1]!.receive({ offset: "3", item: "end", end: true });
    await done;
    expect(got.map((i) => i.offset)).toEqual(["1", "2", "3"]);
  });

  it("connects again at once with a new token on 4001", async () => {
    const { calls, done } = reader();
    await sockets(1);
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.receive({ offset: "7", item: 1 });
    FakeSocket.all[0]!.drop(CLOSE_EXPIRED);
    await sockets(2);
    expect(calls).toHaveLength(2);
    expect(FakeSocket.all[1]!.url).toBe("wss://engine.test/v1/streams/connect?token=tok%202&after=7");
    FakeSocket.all[1]!.receive({ offset: "8", item: 2, end: true });
    await done;
  });

  it("throws StreamGoneError on close code 4404, after the items it had", async () => {
    const { got, done } = reader();
    await sockets(1);
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.receive({ offset: "1", item: "a" });
    FakeSocket.all[0]!.drop(CLOSE_GONE);
    const err = await done.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StreamGoneError);
    expect(err).toMatchObject({ streamId: "s1" });
    expect(got).toEqual([{ offset: "1", item: "a" }]);
    await flushPromises();
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("ends quietly on 4100 (closed, nothing after `after`), with no item and no reconnect", async () => {
    const { calls, got, done } = reader("9");
    const ws = await sockets(1);
    expect(ws.url).toBe("wss://engine.test/v1/streams/connect?token=tok%201&after=9");
    ws.drop(CLOSE_ENDED);
    // `done` ends only when the reader stopped, so nothing can connect after it.
    await done;
    expect(got).toEqual([]);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(1);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("ends quietly on a closing 4100 frame, and the late close event does nothing", async () => {
    const { calls, got, done } = reader("9");
    const ws = await sockets(1);
    ws.open();
    ws.receive({ closing: CLOSE_ENDED });
    await done;
    expect(got).toEqual([]);
    expect(ws.closedWith).toBe(1000);
    ws.drop(CLOSE_ENDED);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(1);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("throws StreamGoneError on a closing 4404 frame, once", async () => {
    const { got, done } = reader();
    const ws = await sockets(1);
    ws.open();
    ws.receive({ offset: "1", item: "a" });
    ws.receive({ closing: CLOSE_GONE });
    const err = await done.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StreamGoneError);
    expect(got).toEqual([{ offset: "1", item: "a" }]);
    ws.drop(CLOSE_GONE);
    await new Promise((r) => setTimeout(r, 20));
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("connects again at once on a closing 4001 frame, and only once", async () => {
    const { calls, got, done } = reader();
    const first = await sockets(1);
    first.open();
    first.receive({ offset: "7", item: 1 });
    first.receive({ closing: CLOSE_EXPIRED });
    expect(first.closedWith).toBe(1000);
    const second = await sockets(2);
    expect(second.url).toBe("wss://engine.test/v1/streams/connect?token=tok%202&after=7");
    // The late close event of the first socket: no second reconnect.
    first.drop(CLOSE_EXPIRED);
    // Frames the first socket still gets are not items.
    first.receive({ offset: "99", item: "late" });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(2);
    expect(FakeSocket.all).toHaveLength(2);
    second.open();
    second.receive({ offset: "8", item: 2, end: true });
    await done;
    expect(got.map((i) => i.offset)).toEqual(["7", "8"]);
  });

  it("throws StreamGoneError when the token call says the stream is gone", async () => {
    const { flow } = client(gone);
    const err = await (async () => {
      for await (const _ of flow.streams.read("s1", { WebSocket })) {
        // nothing
      }
    })().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StreamGoneError);
    expect(FakeSocket.all).toHaveLength(0);
  });

  for (const status of [400, 401, 402, 403]) {
    it(`stops and throws when the token call answers ${status}`, async () => {
      const { flow, calls } = client(() => Response.json({ error: "no", status }, { status }));
      const err = await (async () => {
        for await (const _ of flow.streams.read("s1", { WebSocket })) {
          // nothing
        }
      })().catch((e: unknown) => e);
      expect(err).toMatchObject({ message: `stream token failed (${status}): no`, status });
      expect(err).not.toBeInstanceOf(StreamGoneError);
      expect(calls).toHaveLength(1);
      expect(FakeSocket.all).toHaveLength(0);
    });
  }

  for (const status of [408, 429, 500, 503]) {
    it(`keeps trying when the token call answers ${status}`, async () => {
      vi.useFakeTimers();
      let n = 0;
      const { flow, calls } = client(() => {
        n += 1;
        return n === 1
          ? Response.json({ error: "later", status }, { status })
          : Response.json({ token: "t", url: "wss://e/v1/streams/connect", stream: "s1", expiresAt: 0 });
      });
      const got: StreamItem[] = [];
      const done = (async () => {
        for await (const item of flow.streams.read("s1", { WebSocket })) got.push(item);
      })();
      await vi.waitFor(() => expect(calls).toHaveLength(1), { interval: 1 });
      await vi.advanceTimersByTimeAsync(1_100);
      const ws = await sockets(1);
      expect(calls).toHaveLength(2);
      ws.receive({ offset: "1", item: "end", end: true });
      await done;
      expect(got).toHaveLength(1);
    });
  }

  it("keeps trying after a network error", async () => {
    vi.useFakeTimers();
    let n = 0;
    const { flow } = client(() => {
      n += 1;
      if (n === 1) throw new TypeError("fetch failed");
      return Response.json({ token: "t", url: "wss://e/v1/streams/connect", stream: "s1", expiresAt: 0 });
    });
    const done = (async () => {
      for await (const _ of flow.streams.read("s1", { WebSocket })) {
        // nothing
      }
    })();
    await vi.advanceTimersByTimeAsync(1_100);
    const ws = await sockets(1);
    ws.drop(CLOSE_ENDED);
    await done;
  });

  it("throws at once for a bad after", () => {
    const { flow } = client(() => Response.json({}));
    expect(() => flow.streams.read("s1", { after: "abc", WebSocket })).toThrow('invalid stream offset "abc"');
    expect(() => flow.streams.read("s1", { after: "-1", WebSocket })).toThrow("invalid stream offset");
    expect(() => flow.streams.read("s1", { after: "1".repeat(16), WebSocket })).toThrow("invalid stream offset");
    expect(() => flow.streams.read("s1", { after: "9".repeat(15), WebSocket })).not.toThrow();
  });

  it("ends when the signal aborts, and closes the socket", async () => {
    const abort = new AbortController();
    const { got, done } = reader(undefined, abort.signal);
    await sockets(1);
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.receive({ offset: "1", item: "a" });
    await flushPromises();
    abort.abort();
    await done;
    expect(got).toEqual([{ offset: "1", item: "a" }]);
    expect(FakeSocket.all[0]!.closedWith).toBe(1000);
  });

  it("closes the socket when the reader breaks out", async () => {
    const { flow } = client(() => Response.json({ token: "t", url: "wss://e/v1/streams/connect", stream: "s1", expiresAt: 0 }));
    const done = (async () => {
      for await (const _ of flow.streams.read("s1", { WebSocket })) break;
    })();
    await sockets(1);
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.receive({ offset: "1", item: "a" });
    await done;
    expect(FakeSocket.all[0]!.closedWith).toBe(1000);
  });
});

describe("readStream (browser)", () => {
  afterEach(() => {
    FakeSocket.all = [];
    vi.useRealTimers();
  });

  function start(after?: string) {
    let n = 0;
    const refreshToken = vi.fn(async (): Promise<StreamToken> => {
      n += 1;
      return { token: `tok ${n}`, url: "wss://public.example.com/v1/streams/connect", stream: "s1", expiresAt: 0 };
    });
    const items: StreamItem[] = [];
    const states: string[] = [];
    const onEnd = vi.fn();
    const onGone = vi.fn();
    const stop = readStream({
      refreshToken,
      ...(after ? { after } : {}),
      onItem: (i) => items.push(i),
      onEnd,
      onGone,
      onState: (s) => states.push(s),
      WebSocket,
    });
    return { refreshToken, items, states, onEnd, onGone, stop };
  }

  it("connects at the token's URL with after, and stops after the end item", async () => {
    const { items, onEnd, states } = start("4");
    await flushPromises();
    const ws = FakeSocket.all[0]!;
    expect(ws.url).toBe("wss://public.example.com/v1/streams/connect?token=tok%201&after=4");
    ws.open();
    ws.receive({ offset: "5", item: "a" });
    ws.receive("not json");
    ws.receive({ offset: "6", item: "end", end: true });
    expect(items).toEqual([
      { offset: "5", item: "a" },
      { offset: "6", item: "end", end: true },
    ]);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(ws.closedWith).toBe(1000);
    ws.drop(1000);
    await flushPromises();
    expect(FakeSocket.all).toHaveLength(1);
    expect(states).toEqual(["connecting", "open"]);
  });

  it("connects again from the last offset it gave", async () => {
    const { refreshToken } = start();
    await flushPromises();
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.receive({ offset: "9", item: "a" });
    FakeSocket.all[0]!.drop(CLOSE_EXPIRED);
    await flushPromises();
    expect(refreshToken).toHaveBeenCalledTimes(2);
    expect(FakeSocket.all[1]!.url).toBe("wss://public.example.com/v1/streams/connect?token=tok%202&after=9");
  });

  it("calls onEnd with nothing on 4100, and does not connect again", async () => {
    vi.useFakeTimers();
    const { items, onEnd, onGone, refreshToken } = start("6");
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.all[0]!.url).toBe("wss://public.example.com/v1/streams/connect?token=tok%201&after=6");
    FakeSocket.all[0]!.drop(CLOSE_ENDED);
    expect(vi.getTimerCount()).toBe(0);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd.mock.calls[0]).toEqual([]);
    expect(items).toEqual([]);
    expect(onGone).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("throws from the call for a bad after", () => {
    const refreshToken = vi.fn(async (): Promise<StreamToken> => ({ token: "t", url: "wss://e/v1/streams/connect", stream: "s1", expiresAt: 0 }));
    expect(() => readStream({ refreshToken, after: "1.5", onItem: () => {}, WebSocket })).toThrow('invalid stream offset "1.5"');
    expect(refreshToken).not.toHaveBeenCalled();
  });

  it("does not call onGone when stopped while the token call runs", async () => {
    let reject: (e: Error) => void = () => {};
    const onGone = vi.fn();
    const states: string[] = [];
    const stop = readStream({
      refreshToken: () => new Promise<StreamToken>((_, r) => (reject = r)),
      onItem: () => {},
      onGone,
      onState: (s) => states.push(s),
      WebSocket,
    });
    stop();
    reject(new StreamGoneError("s1"));
    await flushPromises();
    expect(onGone).not.toHaveBeenCalled();
    expect(states).toEqual(["connecting"]);
  });

  it("acts on closing frames at once, and once", async () => {
    vi.useFakeTimers();
    const a = start();
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.receive({ closing: CLOSE_ENDED });
    expect(a.onEnd).toHaveBeenCalledTimes(1);
    expect(a.items).toEqual([]);
    FakeSocket.all[0]!.drop(CLOSE_ENDED);
    expect(a.onEnd).toHaveBeenCalledTimes(1);

    const b = start();
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.all[1]!.receive({ closing: CLOSE_GONE });
    expect(b.onGone).toHaveBeenCalledTimes(1);
    FakeSocket.all[1]!.drop(CLOSE_GONE);
    expect(b.onGone).toHaveBeenCalledTimes(1);
    expect(b.items).toEqual([]);

    const c = start();
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.all[2]!.receive({ offset: "3", item: "x" });
    FakeSocket.all[2]!.receive({ closing: CLOSE_EXPIRED });
    await vi.advanceTimersByTimeAsync(0);
    expect(c.refreshToken).toHaveBeenCalledTimes(2);
    expect(FakeSocket.all[3]!.url).toContain("after=3");
    FakeSocket.all[2]!.drop(CLOSE_EXPIRED);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(c.refreshToken).toHaveBeenCalledTimes(2);
    expect(FakeSocket.all).toHaveLength(4);
    expect(c.items).toEqual([{ offset: "3", item: "x" }]);
    expect(a.refreshToken).toHaveBeenCalledTimes(1);
    expect(b.refreshToken).toHaveBeenCalledTimes(1);
  });

  it("a late error event after a closing frame changes no state", async () => {
    const { states, onEnd } = start();
    await flushPromises();
    const ws = FakeSocket.all[0]!;
    ws.open();
    ws.receive({ closing: CLOSE_ENDED });
    ws.error();
    ws.drop(1006);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(states).toEqual(["connecting", "open", "closed"]);
  });

  it("calls onGone on 4404 and does not connect again", async () => {
    const { onGone, refreshToken } = start();
    await flushPromises();
    FakeSocket.all[0]!.drop(CLOSE_GONE);
    await flushPromises();
    expect(onGone).toHaveBeenCalledTimes(1);
    expect(onGone.mock.calls[0]![0]).toBeInstanceOf(StreamGoneError);
    expect(onGone.mock.calls[0]![0]).toMatchObject({ streamId: "s1" });
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });

  it("pings every 30 s while open, and stop closes the socket", async () => {
    vi.useFakeTimers();
    const { stop, refreshToken } = start();
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.all[0]!.open();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeSocket.all[0]!.sent).toEqual(["ping"]);
    stop();
    expect(FakeSocket.all[0]!.closedWith).toBe(1000);
    FakeSocket.all[0]!.drop(1000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });
});
