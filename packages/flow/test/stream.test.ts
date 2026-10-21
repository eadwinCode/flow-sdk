import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import {
  generateSigningKey,
  parseStreamedAnswer,
  signRequest,
  streamedAnswerTail,
  verifyAnswer,
  type FlowEvent,
  type InvokeRequest,
  type StreamedAnswer,
} from "@clevix/protocol";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Flow, NonRetriableError, RetryAfterError, serve, type FlowFunction } from "../src/index.ts";
import { serve as serveCloudflare } from "../src/cloudflare.ts";
import { serve as serveExpress } from "../src/express.ts";

// Streamed answers: see packages/protocol/src/stream.ts and docs/protocol.md.

interface Vectors {
  answers: { streamed: { cases: Array<StreamedAnswer & { text: string }> } };
}

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../testdata/vectors.json", import.meta.url)), "utf8"),
) as Vectors;

const KEY = generateSigningKey();
const URL_ = "https://app.example.com/api/flow";

function invoke(fnId: string): InvokeRequest {
  const e: FlowEvent = { id: "evt_1", name: "a/b", data: {}, ts: 1_760_000_000_000 };
  return { fnId, runId: "run_1", event: e, events: [e], memo: {}, attempt: 0, maxAttempts: 3 };
}

/** A signed POST; `stream` adds X-Flow-Stream: 1. */
async function post(body: InvokeRequest | string, stream = true): Promise<{ request: Request; signature: string }> {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const signature = await signRequest(KEY, text);
  const headers: Record<string, string> = { "X-Inngest-Signature": signature };
  if (stream) headers["X-Flow-Stream"] = "1";
  return { request: new Request(URL_, { method: "POST", headers, body: text }), signature };
}

function functions(flow: Flow): FlowFunction[] {
  return [
    flow.createFunction({ id: "done" }, { event: "a/b" }, () => ({ ok: true })),
    flow.createFunction({ id: "step" }, { event: "a/b" }, async ({ step }) => step.run("s", () => 1)),
    flow.createFunction({ id: "fail" }, { event: "a/b" }, () => {
      throw new NonRetriableError("no");
    }),
    flow.createFunction({ id: "later" }, { event: "a/b" }, () => {
      throw new RetryAfterError("later", new Date(Date.now() + 60_000));
    }),
  ];
}

describe("streamed answer vectors", () => {
  it("makes and reads the same bytes", () => {
    expect(vectors.answers.streamed.cases.length).toBeGreaterThan(0);
    for (const c of vectors.answers.streamed.cases) {
      const { text, ...parts } = c;
      expect(text.endsWith(streamedAnswerTail(parts))).toBe(true);
      expect(parseStreamedAnswer(text)).toEqual(parts);
    }
  });

  it("refuses what is not a streamed answer", () => {
    expect(() => parseStreamedAnswer("\n\n\n")).toThrow(/no meta line/);
    expect(() => parseStreamedAnswer("\n{nope\n{}")).toThrow(/not JSON/);
    expect(() => parseStreamedAnswer("[1]\n{}")).toThrow(/not an object/);
    expect(() => parseStreamedAnswer('{"status":99}\n')).toThrow(/bad status/);
    expect(() => parseStreamedAnswer('{"status":200.5}\n')).toThrow(/bad status/);
    expect(() => parseStreamedAnswer('{"status":200,"noRetry":true}\n')).toThrow(/bad noRetry/);
    // A normal 200 answer is not a streamed one.
    expect(() => parseStreamedAnswer('{"ok":true}')).toThrow();
  });

  it("keeps the body exactly, newlines and all", () => {
    const parts = { status: 200, noRetry: null, retryAfter: null, signature: null, body: '\n{"a":\n1}\n' };
    expect(parseStreamedAnswer("\n\n" + streamedAnswerTail(parts))).toEqual(parts);
  });
});

describe("streamed answers", () => {
  it("streams done, steps and errors: same status, retry headers and body as a normal answer, signed", async () => {
    const flow = new Flow({ id: "shop", signingKey: KEY });
    const handle = serve({ client: flow, functions: functions(flow) });
    for (const fnId of ["done", "step", "fail", "later", "missing"]) {
      const normal = await handle((await post(invoke(fnId), false)).request);
      const { request, signature } = await post(invoke(fnId));
      const res = await handle(request);
      expect(res.status, fnId).toBe(200);
      expect(res.headers.get("X-Flow-Stream")).toBe("1");
      expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
      expect(res.headers.get("Cache-Control")).toBe("no-store, no-transform");
      expect(res.headers.get("X-Accel-Buffering")).toBe("no");
      expect(res.headers.get("X-Flow-Answer-Signature")).toBeNull();
      const text = await res.text();
      expect(text.startsWith("\n"), fnId).toBe(true);
      const a = parseStreamedAnswer(text);
      expect(a.status, fnId).toBe(normal.status);
      expect(a.noRetry, fnId).toBe(normal.headers.get("X-Inngest-No-Retry"));
      // Retry-After counts seconds from now, so it can be one off between the two calls.
      if (fnId === "later") expect(Number(a.retryAfter)).toBeGreaterThanOrEqual(59);
      else expect(a.retryAfter, fnId).toBe(normal.headers.get("Retry-After"));
      if (fnId !== "fail" && fnId !== "later") expect(a.body, fnId).toBe(await normal.text());
      expect(
        await verifyAnswer({ ...a, header: a.signature, key: KEY, request: signature }),
        fnId,
      ).toBe(true);
    }
  });

  it("sends heartbeats while the function runs", async () => {
    const flow = new Flow({ id: "shop", signingKey: KEY });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fn = flow.createFunction({ id: "slow" }, { event: "a/b" }, async () => {
      await gate;
      return "late";
    });
    const handle = serve({ client: flow, functions: [fn], streaming: { heartbeatMs: 5 } });
    const res = await handle((await post(invoke("slow"))).request);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    while ((seen.match(/\n/g) ?? []).length < 3) {
      const { value } = await reader.read();
      seen += decoder.decode(value);
    }
    // Only heartbeats so far: the answer is not there yet.
    expect(seen).toMatch(/^\n+$/);
    release();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += decoder.decode(value);
    }
    const a = parseStreamedAnswer(seen);
    expect(a.status).toBe(200);
    expect(JSON.parse(a.body)).toBe("late");
  });

  it("stops the heartbeats when the engine goes away", async () => {
    const clear = vi.spyOn(globalThis, "clearInterval");
    const flow = new Flow({ id: "shop", signingKey: KEY });
    const fn = flow.createFunction({ id: "never" }, { event: "a/b" }, () => new Promise(() => {}));
    const handle = serve({ client: flow, functions: [fn], streaming: { heartbeatMs: 5 } });
    const res = await handle((await post(invoke("never"))).request);
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });

  it("answers the normal way without the request header, or with streaming: false", async () => {
    const flow = new Flow({ id: "shop", signingKey: KEY });
    const res = await serve({ client: flow, functions: functions(flow) })((await post(invoke("done"), false)).request);
    expect(res.headers.get("X-Flow-Stream")).toBeNull();
    expect(res.headers.get("X-Flow-Answer-Signature")).not.toBeNull();
    expect(await res.json()).toEqual({ ok: true });

    const off = serve({ client: flow, functions: functions(flow), streaming: false });
    const res2 = await off((await post(invoke("step"))).request);
    expect(res2.status).toBe(206);
    expect(res2.headers.get("X-Flow-Stream")).toBeNull();
  });

  it("never streams a 401 or a bad request", async () => {
    const flow = new Flow({ id: "shop", signingKey: KEY });
    const handle = serve({ client: flow, functions: functions(flow) });
    const unsigned = await handle(new Request(URL_, { method: "POST", headers: { "X-Flow-Stream": "1" }, body: "{}" }));
    expect(unsigned.status).toBe(401);
    expect(unsigned.headers.get("X-Flow-Stream")).toBeNull();
    const bad = await handle((await post("not json")).request);
    expect(bad.status).toBe(400);
    expect(bad.headers.get("X-Flow-Stream")).toBeNull();
    expect(bad.headers.get("X-Flow-Answer-Signature")).not.toBeNull();
  });

  it("dev mode: an unsigned call gets an unsigned streamed answer", async () => {
    const flow = new Flow({ id: "shop", isDev: true });
    const handle = serve({ client: flow, functions: functions(flow) });
    const res = await handle(
      new Request(URL_, { method: "POST", headers: { "X-Flow-Stream": "1" }, body: JSON.stringify(invoke("done")) }),
    );
    const a = parseStreamedAnswer(await res.text());
    expect(a.status).toBe(200);
    expect(a.signature).toBeNull();
  });

  it("refuses a bad heartbeat interval", () => {
    const flow = new Flow({ id: "shop", signingKey: KEY });
    expect(() => serve({ client: flow, functions: [], streaming: { heartbeatMs: 0 } })).toThrow(/heartbeatMs/);
    expect(() => serve({ client: flow, functions: [], streaming: { heartbeatMs: Number.NaN } })).toThrow(/heartbeatMs/);
    expect(() => serve({ client: flow, functions: [], streaming: { heartbeatMs: 3e9 } })).toThrow(/heartbeatMs/);
  });

  it("the Cloudflare adapter passes the stream through", async () => {
    const flow = new Flow({ id: "shop", signingKey: KEY });
    const handler = serveCloudflare({ client: flow, functions: functions(flow) });
    const res = await handler.fetch((await post(invoke("done"))).request, { FLOW_SIGNING_KEY: KEY });
    expect(res.headers.get("X-Flow-Stream")).toBe("1");
    expect(parseStreamedAnswer(await res.text()).status).toBe(200);
  });
});

describe("express: streamed answers", () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  it("sends heartbeats as they come, then the answer", async () => {
    const flow = new Flow({ id: "shop", signingKey: KEY });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fn = flow.createFunction({ id: "slow" }, { event: "a/b" }, async () => {
      await gate;
      return "late";
    });
    const e = express();
    e.use("/api/flow", serveExpress({ client: flow, functions: [fn], streaming: { heartbeatMs: 5 } }));
    const server = e.listen(0);
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/flow`;
    const { request } = await post(invoke("slow"));
    const res = await fetch(url, { method: "POST", headers: request.headers, body: await request.text() });
    expect(res.headers.get("X-Flow-Stream")).toBe("1");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    while ((seen.match(/\n/g) ?? []).length < 2) seen += decoder.decode((await reader.read()).value);
    expect(seen).toMatch(/^\n+$/);
    release();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += decoder.decode(value);
    }
    expect(JSON.parse(parseStreamedAnswer(seen).body)).toBe("late");
  });
});
