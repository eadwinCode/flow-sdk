import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { generateSigningKey, signRequest, type InvokeRequest } from "@clevix/protocol";
import express from "express";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { Flow, type FlowFunction } from "../src/index.ts";
import { serve as serveExpress } from "../src/express.ts";
import { serve as serveHono } from "../src/hono.ts";
import { serve as serveNext } from "../src/next.ts";

// Each adapter must answer exactly as the fetch handler does.

const KEY = generateSigningKey();

function invoke(fnId: string): InvokeRequest {
  const e = { id: "evt_1", name: "user/signed-up", data: { userId: "u1" }, ts: 1_760_000_000_000 };
  return { fnId, runId: "run_1", event: e, events: [e], memo: {}, attempt: 0, maxAttempts: 3 };
}

/** One function that returns at once, and one with a step (206). */
function app(signingKey = KEY) {
  const flow = new Flow({ id: "shop", signingKey });
  const functions: FlowFunction[] = [
    flow.createFunction({ id: "hello" }, { event: "user/signed-up" }, ({ event }) => ({ hello: event.data.userId })),
    flow.createFunction({ id: "steps" }, { event: "user/signed-up" }, async ({ step }) => {
      await step.run("one", () => 1);
      return "done";
    }),
  ];
  return { client: flow, functions };
}

async function signedPost(url: string, body: InvokeRequest, key = KEY): Promise<RequestInit & { url: string }> {
  // Spaces in the JSON check that the bytes are passed through as they came.
  const text = JSON.stringify(body, null, 2);
  return {
    url,
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Inngest-Signature": await signRequest(key, text) },
    body: text,
  };
}

async function signedGet(url: string): Promise<RequestInit & { url: string }> {
  return { url, method: "GET", headers: { "X-Inngest-Signature": await signRequest(KEY, "") } };
}

type Call = (init: RequestInit & { url: string }) => Promise<Response>;

/** The same checks for each adapter. */
function common(name: string, call: () => Promise<{ call: Call; url: string }>) {
  describe(`${name}: common`, () => {
    it("runs a function: 200 with its output", async () => {
      const { call: c, url } = await call();
      const res = await c(await signedPost(url, invoke("hello")));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ hello: "u1" });
    });

    it("runs a step: 206 with the opcode", async () => {
      const { call: c, url } = await call();
      const res = await c(await signedPost(url, invoke("steps")));
      expect(res.status).toBe(206);
      expect(await res.json()).toMatchObject([{ op: "StepCompleted", name: "one", data: 1 }]);
    });

    it("rejects a bad signature with 401", async () => {
      const { call: c, url } = await call();
      const res = await c(await signedPost(url, invoke("hello"), generateSigningKey()));
      expect(res.status).toBe(401);
      const missing = await c({ url, method: "POST", body: JSON.stringify(invoke("hello")) });
      expect(missing.status).toBe(401);
    });

    it("GET returns the manifest with the full URL", async () => {
      const { call: c, url } = await call();
      expect((await c({ url, method: "GET" })).status).toBe(401);
      const res = await c(await signedGet(url));
      expect(res.status).toBe(200);
      const manifest = (await res.json()) as { appId: string; url: string; functions: Array<{ id: string }> };
      expect(manifest.appId).toBe("shop");
      expect(manifest.url).toBe(url);
      expect(manifest.functions.map((f) => f.id)).toEqual(["hello", "steps"]);
    });
  });
}

// Hono

function honoApp(options = app()) {
  const h = new Hono<{ Bindings: Record<string, string> }>();
  h.on(["GET", "PUT", "POST"], "/api/flow", serveHono(options));
  return h;
}

common("hono", async () => {
  const h = honoApp();
  return {
    url: "http://localhost/api/flow",
    call: async ({ url, ...init }) => h.request(url, init),
  };
});

describe("hono", () => {
  it("reads settings from c.env", async () => {
    const flow = new Flow({ id: "shop" });
    const fn = flow.createFunction({ id: "hello" }, { event: "a/b" }, () => "hi");
    const h = new Hono<{ Bindings: Record<string, string> }>();
    h.on(["GET", "PUT", "POST"], "/api/flow", serveHono({ client: flow, functions: [fn] }));
    const { url, ...init } = await signedPost("http://localhost/api/flow", invoke("hello"));
    expect((await h.request(url, init, {})).status).toBe(500);
    const res = await h.request(url, init, { FLOW_SIGNING_KEY: KEY });
    expect(res.status).toBe(200);
    expect(await res.json()).toBe("hi");
  });

  it("works when a middleware already read the body", async () => {
    const h = new Hono();
    h.use("/api/flow", async (c, next) => {
      if (c.req.method === "POST") await c.req.json();
      await next();
    });
    h.on(["GET", "PUT", "POST"], "/api/flow", serveHono(app()));
    const { url, ...init } = await signedPost("http://localhost/api/flow", invoke("hello"));
    const res = await h.request(url, init);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hello: "u1" });
  });
});

// Next.js

common("next", async () => {
  const { GET, POST, PUT } = serveNext(app());
  const routes: Record<string, (r: Request) => Promise<Response>> = { GET, POST, PUT };
  return {
    url: "https://app.example.com/api/flow",
    call: async ({ url, ...init }) => routes[init.method ?? "GET"]!(new Request(url, init)),
  };
});

// Express

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
});

async function listen(e: express.Express): Promise<string> {
  const server = e.listen(0);
  servers.push(server);
  await new Promise<void>((done) => server.once("listening", () => done()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/flow`;
}

const fetchCall: Call = ({ url, ...init }) => fetch(url, init);

common("express", async () => {
  const e = express();
  e.use("/api/flow", serveExpress(app()));
  return { url: await listen(e), call: fetchCall };
});

common("express after express.raw()", async () => {
  const e = express();
  e.use("/api/flow", express.raw({ type: "*/*" }), serveExpress(app()));
  return { url: await listen(e), call: fetchCall };
});

common("express after express.text()", async () => {
  const e = express();
  e.use("/api/flow", express.text({ type: "*/*" }), serveExpress(app()));
  return { url: await listen(e), call: fetchCall };
});

describe("express", () => {
  it("answers 500 with a clear message when express.json() already parsed the body", async () => {
    const e = express();
    e.use(express.json());
    e.use("/api/flow", serveExpress(app()));
    const url = await listen(e);
    const res = await fetchCall(await signedPost(url, invoke("hello")));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { name: string; message: string };
    expect(body.name).toBe("BodyAlreadyParsed");
    expect(body.message).toMatch(/express\.json\(\)/);
    // GET does not need a body, so it still works.
    expect((await fetchCall(await signedGet(url))).status).toBe(200);
  });

  it("works when express.json() is mounted after it", async () => {
    const e = express();
    e.use("/api/flow", serveExpress(app()));
    e.use(express.json());
    const url = await listen(e);
    const res = await fetchCall(await signedPost(url, invoke("hello")));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hello: "u1" });
  });

  it("uses X-Forwarded-Proto and Host only with trust proxy", async () => {
    const forwarded = { "X-Forwarded-Proto": "https", "X-Forwarded-Host": "shop.example.com" };
    const plain = express();
    plain.use("/api/flow", serveExpress(app()));
    const plainUrl = await listen(plain);
    const get = await signedGet(plainUrl);
    let res = await fetch(plainUrl, { ...get, headers: { ...(get.headers as Record<string, string>), ...forwarded } });
    expect(((await res.json()) as { url: string }).url).toBe(plainUrl);

    const trusted = express();
    trusted.set("trust proxy", true);
    trusted.use("/api/flow", serveExpress(app()));
    const trustedUrl = await listen(trusted);
    res = await fetch(trustedUrl, { ...get, headers: { ...(get.headers as Record<string, string>), ...forwarded } });
    expect(((await res.json()) as { url: string }).url).toBe("https://shop.example.com/api/flow");
  });

  it("copies status and headers from the handler", async () => {
    const flow = new Flow({ id: "shop", signingKey: KEY });
    const fn = flow.createFunction({ id: "hello" }, { event: "a/b" }, () => "hi");
    const e = express();
    e.use("/api/flow", serveExpress({ client: flow, functions: [fn] }));
    const url = await listen(e);
    const res = await fetchCall(await signedPost(url, invoke("missing")));
    expect(res.status).toBe(500);
    expect(res.headers.get("X-Inngest-No-Retry")).toBe("true");
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(((await res.json()) as { name: string }).name).toBe("FunctionNotFound");
  });
});
