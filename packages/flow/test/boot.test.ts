import { generateSigningKey, signingKeyBearer, signRequest } from "@clevix/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Flow, manifestHash, SDK_VERSION, serve, type FlowFunction } from "../src/index.ts";
import { serve as serveCloudflare } from "../src/cloudflare.ts";
import { serve as serveExpress } from "../src/express.ts";
import { serve as serveNext } from "../src/next.ts";
import { buildManifest, checkSync, retryDelay } from "../src/serve.ts";

// Sync at boot: GET /apps/:id/sync?hash=, and a PUT when the engine's hash is not the
// app's and its guard is off. Then again every checkEveryMs, or at retryAt.

const KEY = generateSigningKey();
const ENGINE = "https://engine.test";
const APP_URL = "https://shop.example.com/api/flow";

interface Call {
  method: string;
  url: string;
  auth: string | undefined;
  body: unknown;
}

/** A fake engine. `check` answers the GET, `put` the PUT. */
function engine(
  options: { check?: () => Response | Promise<Response>; put?: () => Response | Promise<Response> } = {},
) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ method, url, auth: headers.Authorization, body: init.body ? JSON.parse(init.body as string) : undefined });
    if (method === "GET") return (options.check ?? (() => Response.json({ appId: "shop", manifestHash: null, syncedAt: null })))();
    return (options.put ?? (() => Response.json({ ok: true })))();
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

function app(fetch: typeof globalThis.fetch, signingKey: string | undefined = KEY) {
  const flow = new Flow({ id: "shop", signingKey, baseUrl: ENGINE, fetch });
  const functions: FlowFunction[] = [flow.createFunction({ id: "hello" }, { event: "user/signed-up" }, () => "hi")];
  return { client: flow, functions };
}

/** A Workers ctx that keeps what was passed to waitUntil. */
function workersCtx() {
  const waiting: Promise<unknown>[] = [];
  return { waiting, ctx: { waitUntil: (p: Promise<unknown>) => void waiting.push(p) } };
}

async function signedGet(): Promise<Request> {
  return new Request(APP_URL, { headers: { "X-Inngest-Signature": await signRequest(KEY, "") } });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/**
 * Lets the background check run until `done()` is true (crypto.subtle and fetch are
 * not on a fake timer, so this waits on real turns of the event loop). A fixed number
 * of turns is not enough on a slow CI machine.
 */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 20_000 && !done(); i++) await new Promise((r) => setImmediate(r));
  if (!done()) throw new Error("the background check did not get there");
}

/** A few turns of the event loop, for checking that nothing happened. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
}

describe("manifestHash", () => {
  const sdk = { language: "typescript", version: "1.0.0" };
  it("is the same for the same manifest, whatever the key order or URL", async () => {
    const a = await manifestHash({ sdk, functions: [{ id: "a", triggers: [{ event: "x/y" }], retries: 2 }] });
    const b = await manifestHash({ functions: [{ retries: 2, triggers: [{ event: "x/y" }], id: "a" }], sdk });
    expect(a).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(b).toBe(a);
    // The URL is not part of it: every copy of the app has the same hash.
    expect(await manifestHash({ ...buildManifestFor("https://other.example.com") })).toBe(await manifestHash(buildManifestFor(APP_URL)));
  });

  it("changes with anything a sync saves except the URL: function config, SDK language or version", async () => {
    const fn = { id: "a", triggers: [{ event: "x/y" }], retries: 2, concurrency: { limit: 5 } };
    const base = await manifestHash({ sdk, functions: [fn] });
    const changed = [
      { sdk, functions: [{ ...fn, triggers: [{ event: "x/z" }] }] },
      { sdk, functions: [{ ...fn, retries: 3 }] },
      { sdk, functions: [{ ...fn, concurrency: { limit: 6 } }] },
      { sdk, functions: [{ ...fn, name: "A" }] },
      { sdk, functions: [fn, { id: "b", triggers: [{ cron: "0 * * * *" }] }] },
      { sdk: { ...sdk, version: "1.0.1" }, functions: [fn] },
      { sdk: { ...sdk, language: "go" }, functions: [fn] },
    ];
    const hashes = await Promise.all(changed.map((m) => manifestHash(m)));
    for (const h of hashes) expect(h).not.toBe(base);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  function buildManifestFor(url: string) {
    const { client, functions } = app(engine().fetch);
    return buildManifest(client.id, url, functions);
  }
});

describe("sync at boot on Workers", () => {
  it("checks on the first request in waitUntil, then PUTs the manifest without a URL", async () => {
    const e = engine();
    const worker = serveCloudflare(app(e.fetch));
    const { waiting, ctx } = workersCtx();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    const res = await worker.fetch(await signedGet(), {}, ctx);
    expect(res.status).toBe(200);
    const served = (await res.json()) as { manifestHash: string };
    expect(waiting).toHaveLength(1);
    await Promise.all(waiting);

    const bearer = `Bearer ${await signingKeyBearer(KEY)}`;
    expect(e.calls.map((c) => [c.method, c.url, c.auth])).toEqual([
      ["GET", `${ENGINE}/apps/shop/sync?hash=${encodeURIComponent(served.manifestHash)}`, bearer],
      ["PUT", `${ENGINE}/apps/shop/sync`, bearer],
    ]);
    expect(e.calls[1]!.body).toEqual({
      appId: "shop",
      sdk: { language: "typescript", version: SDK_VERSION },
      functions: [{ id: "hello", triggers: [{ event: "user/signed-up" }] }],
      // The same hash the GET answer gives the engine's Resync.
      manifestHash: served.manifestHash,
    });
    expect(info).toHaveBeenCalledWith(expect.stringContaining("synced"));

    // Once per isolate: the next request does not check again.
    await worker.fetch(await signedGet(), {}, workersCtx().ctx);
    expect(e.calls).toHaveLength(2);
  });

  it("does not PUT when the engine has the same hash", async () => {
    const { client, functions } = app(engine().fetch);
    const hash = await manifestHash(buildManifest(client.id, "", functions));
    const e = engine({ check: () => Response.json({ appId: "shop", manifestHash: hash, syncedAt: 1 }) });
    const { waiting, ctx } = workersCtx();
    await serveCloudflare(app(e.fetch)).fetch(await signedGet(), {}, ctx);
    await Promise.all(waiting);
    expect(e.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("never slows the request: it answers while the check still waits", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const e = engine({
      check: async () => {
        await held;
        return Response.json({ appId: "shop", manifestHash: null, syncedAt: null });
      },
    });
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { waiting, ctx } = workersCtx();
    const res = await serveCloudflare(app(e.fetch)).fetch(await signedGet(), {}, ctx);
    expect(res.status).toBe(200);
    expect(e.calls.map((c) => c.method)).toEqual(["GET"]);
    release();
    await Promise.all(waiting);
    expect(e.calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
  });

  it("a failed check never fails the request", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = (async () => {
      throw new Error("engine down");
    }) as unknown as typeof globalThis.fetch;
    const { waiting, ctx } = workersCtx();
    const res = await serveCloudflare(app(fetch)).fetch(await signedGet(), {}, ctx);
    expect(res.status).toBe(200);
    await Promise.all(waiting);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("engine down"));
  });

  it("reads the signing key from the Worker's env", async () => {
    const e = engine();
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { waiting, ctx } = workersCtx();
    await serveCloudflare(app(e.fetch, undefined)).fetch(await signedGet(), { FLOW_SIGNING_KEY: KEY }, ctx);
    await Promise.all(waiting);
    expect(e.calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
  });

  it("syncOnBoot: false turns it off", async () => {
    const e = engine();
    const { waiting, ctx } = workersCtx();
    await serveCloudflare({ ...app(e.fetch), syncOnBoot: false }).fetch(await signedGet(), {}, ctx);
    expect(waiting).toHaveLength(0);
    expect(e.calls).toHaveLength(0);
  });
});

describe("sync at boot on Node", () => {
  it("Express starts it at once, before any request", async () => {
    const e = engine();
    vi.spyOn(console, "info").mockImplementation(() => {});
    serveExpress(app(e.fetch));
    await vi.waitFor(() => expect(e.calls.map((c) => c.method)).toEqual(["GET", "PUT"]));
  });

  it("Next waits for the first request (next build loads route modules too)", async () => {
    const e = engine();
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { GET } = serveNext(app(e.fetch));
    await new Promise((r) => setTimeout(r, 10));
    expect(e.calls).toHaveLength(0);
    await GET(await signedGet());
    await vi.waitFor(() => expect(e.calls.map((c) => c.method)).toEqual(["GET", "PUT"]));
  });

  it("Next on Vercel: the check runs in the request context's waitUntil", async () => {
    const e = engine();
    vi.spyOn(console, "info").mockImplementation(() => {});
    const waiting: Promise<unknown>[] = [];
    const key = Symbol.for("@vercel/request-context");
    const g = globalThis as Record<symbol, unknown>;
    g[key] = { get: () => ({ waitUntil: (p: Promise<unknown>) => void waiting.push(p) }) };
    try {
      const { GET } = serveNext(app(e.fetch));
      await GET(await signedGet());
      expect(waiting).toHaveLength(1);
      await Promise.all(waiting);
      expect(e.calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
    } finally {
      delete g[key];
    }
  });

  it("does nothing without a signing key (dev mode)", async () => {
    const e = engine();
    const flow = new Flow({ id: "shop", isDev: true, baseUrl: ENGINE, fetch: e.fetch });
    await serve({ client: flow, functions: [] })(new Request(APP_URL));
    await new Promise((r) => setTimeout(r, 10));
    expect(e.calls).toHaveLength(0);
  });
});

describe("checkSync", () => {
  async function run(e: ReturnType<typeof engine>) {
    const { client, functions } = app(e.fetch);
    return checkSync(client.settings({}), functions, "v1:abc");
  }

  it("a 409 ManifestReplaced (an old copy during a deploy) is a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const e = engine({
      check: () => Response.json({ appId: "shop", manifestHash: "v1:new", syncedAt: 1 }),
      put: () => Response.json({ error: "this manifest was replaced", status: 409, code: "ManifestReplaced" }, { status: 409 }),
    });
    expect(await run(e)).toEqual({ result: "replaced" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("this manifest was replaced"));
  });

  it("a new app the engine has no URL for: says how to sync it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const e = engine({ put: () => Response.json({ error: "url must be http(s)", status: 400 }, { status: 400 }) });
    expect((await run(e)).result).toBe("failed");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("curl -X PUT <app-url>"));
  });

  it("a failed check does not PUT", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const e = engine({ check: () => Response.json({ error: "invalid signing key", status: 401 }, { status: 401 }) });
    expect((await run(e)).result).toBe("failed");
    expect(e.calls.map((c) => c.method)).toEqual(["GET"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("invalid signing key"));
  });

  it("an answer that is not JSON does not PUT", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const e = engine({ check: () => new Response("<html>", { status: 200 }) });
    expect((await run(e)).result).toBe("failed");
    expect(e.calls).toHaveLength(1);
  });

  it("a failed check tries again in 5 minutes; a 404 (an older engine) in 1 hour", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await run(engine({ check: () => new Response("oops", { status: 503 }) }))).toEqual({ result: "failed", nextInMs: 300_000 });
    expect(await run(engine({ check: () => new Response("not found", { status: 404 }) }))).toEqual({ result: "failed", nextInMs: 3_600_000 });
  });

  it("tries the fallback key on a 401, for the check and the PUT (key rotation)", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const OLD = generateSigningKey();
    const oldBearer = `Bearer ${await signingKeyBearer(OLD)}`;
    const e = engine();
    const onlyOldKey = (async (url: string, init: RequestInit = {}) => {
      const auth = ((init.headers ?? {}) as Record<string, string>).Authorization;
      if (auth !== oldBearer) {
        e.calls.push({ method: init.method ?? "GET", url, auth, body: undefined });
        return Response.json({ error: "invalid signing key", status: 401 }, { status: 401 });
      }
      return (e.fetch as unknown as (u: string, i: RequestInit) => Promise<Response>)(url, init);
    }) as unknown as typeof globalThis.fetch;
    const flow = new Flow({ id: "shop", signingKey: KEY, signingKeyFallback: OLD, baseUrl: ENGINE, fetch: onlyOldKey });
    const done = await checkSync(flow.settings({}), [], "v1:abc");
    expect(done.result).toBe("synced");
    expect(e.calls.map((c) => [c.method, c.auth === oldBearer ? "old" : "new"])).toEqual([
      ["GET", "new"],
      ["GET", "old"],
      ["PUT", "new"],
      ["PUT", "old"],
    ]);
  });

  it("while the engine's guard is on (retryAt), it does not PUT and waits for retryAt", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const now = Date.now();
    const e = engine({
      check: () =>
        Response.json(
          { appId: "shop", manifestHash: "v1:new", syncedAt: 1, retryAt: now + 120_000, checkEveryMs: 300_000 },
          { headers: { Date: new Date(now).toUTCString() } },
        ),
    });
    const done = await run(e);
    expect(done.result).toBe("waiting");
    // Date has whole seconds: 120 s + 1 s slack, give or take the lost ms.
    expect(done.nextInMs).toBeGreaterThan(120_000);
    expect(done.nextInMs).toBeLessThanOrEqual(122_000);
    expect(e.calls.map((c) => c.method)).toEqual(["GET"]);
    expect(info).toHaveBeenCalledWith(expect.stringContaining("checking again"));
  });

  it("the same hash is in sync even while the guard is on; the heartbeat is checkEveryMs", async () => {
    const e = engine({
      check: () => Response.json({ appId: "shop", manifestHash: "v1:abc", syncedAt: 1, retryAt: Date.now() + 60_000, checkEveryMs: 300_000 }),
    });
    expect(await run(e)).toEqual({ result: "in-sync", nextInMs: 300_000 });
    vi.spyOn(console, "info").mockImplementation(() => {});
    const synced = engine({ check: () => Response.json({ appId: "shop", manifestHash: null, syncedAt: null, retryAt: null, checkEveryMs: 300_000 }) });
    expect(await run(synced)).toEqual({ result: "synced", nextInMs: 300_000 });
    expect(synced.calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
  });
});

describe("checking again", () => {

  const T0 = Date.UTC(2026, 9, 23, 12, 0, 0);

  /** An engine whose first PUT gets a 409 with retryAt one minute later, then 200s. */
  function replacedOnce() {
    let puts = 0;
    return engine({
      check: () => Response.json({ appId: "shop", manifestHash: "v1:new", syncedAt: 1 }),
      put: () =>
        ++puts === 1
          ? Response.json(
              { error: "replaced", status: 409, code: "ManifestReplaced", retryAt: T0 + 60_000 },
              { status: 409, headers: { Date: new Date(T0).toUTCString() } },
            )
          : Response.json({ ok: true }),
    });
  }

  it("retryDelay measures from the engine's clock, with a floor", () => {
    // The app's clock is 10 minutes ahead: the engine's Date header wins.
    expect(retryDelay(T0 + 60_000, new Date(T0).toUTCString(), T0 + 600_000)).toBe(61_000);
    expect(retryDelay(T0 + 60_000, null, T0)).toBe(61_000);
    expect(retryDelay(T0 - 60_000, null, T0)).toBe(5_000);
    expect(retryDelay(undefined, null, T0)).toBeUndefined();
    expect(retryDelay("soon", null, T0)).toBeUndefined();
  });

  it("returns the delay with the 409", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, functions } = app(replacedOnce().fetch);
    expect(await checkSync(client.settings({}), functions, "v1:old")).toEqual({ result: "replaced", nextInMs: 61_000 });
  });

  it("Workers: the first request after that time checks again, in waitUntil", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    const e = replacedOnce();
    const worker = serveCloudflare(app(e.fetch));

    const first = workersCtx();
    await worker.fetch(await signedGet(), {}, first.ctx);
    await Promise.all(first.waiting);
    expect(e.calls.map((c) => c.method)).toEqual(["GET", "PUT"]);

    // Too early: nothing.
    vi.setSystemTime(T0 + 30_000);
    const early = workersCtx();
    await worker.fetch(await signedGet(), {}, early.ctx);
    expect(early.waiting).toHaveLength(0);

    vi.setSystemTime(T0 + 61_000);
    const late = workersCtx();
    await worker.fetch(await signedGet(), {}, late.ctx);
    expect(late.waiting).toHaveLength(1);
    await Promise.all(late.waiting);
    expect(e.calls.map((c) => c.method)).toEqual(["GET", "PUT", "GET", "PUT"]);

    // Once per 409: later requests do not check again.
    vi.setSystemTime(T0 + 200_000);
    await worker.fetch(await signedGet(), {}, workersCtx().ctx);
    expect(e.calls).toHaveLength(4);
  });

  it("a long-running server checks again with a timer", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(T0);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    const e = replacedOnce();
    serveExpress(app(e.fetch));
    // The 409 came back and the timer is set.
    await until(() => vi.getTimerCount() === 1);
    expect(e.calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
    vi.advanceTimersByTime(60_000);
    await settle();
    expect(e.calls).toHaveLength(2);
    vi.advanceTimersByTime(1_000);
    await until(() => e.calls.length === 4);
    expect(e.calls.map((c) => c.method)).toEqual(["GET", "PUT", "GET", "PUT"]);
  });

  it("a second 409 gives a new time to check again", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(T0);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const e = engine({
      check: () => Response.json({ appId: "shop", manifestHash: "v1:new", syncedAt: 1 }),
      put: () =>
        Response.json(
          { error: "replaced", status: 409, code: "ManifestReplaced", retryAt: Date.now() + 10_000 },
          { status: 409 },
        ),
    });
    serveExpress(app(e.fetch));
    await until(() => vi.getTimerCount() === 1);
    vi.advanceTimersByTime(11_000);
    // The second 409 came back and set a new timer.
    await until(() => e.calls.length === 4 && vi.getTimerCount() === 1);
    vi.advanceTimersByTime(11_000);
    await until(() => e.calls.length === 6);
    expect(e.calls.map((c) => c.method)).toEqual(["GET", "PUT", "GET", "PUT", "GET", "PUT"]);
  });
});

describe("the heartbeat (checkEveryMs)", () => {
  const T0 = Date.UTC(2026, 9, 23, 12, 0, 0);

  /** In sync on every check, with a 5 minute heartbeat. */
  async function inSyncEngine() {
    const { client, functions } = app(engine().fetch);
    const hash = await manifestHash(buildManifest(client.id, "", functions));
    return engine({ check: () => Response.json({ appId: "shop", manifestHash: hash, syncedAt: 1, retryAt: null, checkEveryMs: 300_000 }) });
  }

  it("a long-running server checks every checkEveryMs with a timer", async () => {
    const e = await inSyncEngine();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(T0);
    serveExpress(app(e.fetch));
    await until(() => vi.getTimerCount() === 1);
    expect(e.calls).toHaveLength(1);
    vi.advanceTimersByTime(299_000);
    await settle();
    expect(e.calls).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    await until(() => e.calls.length === 2 && vi.getTimerCount() === 1);
    vi.advanceTimersByTime(300_000);
    await until(() => e.calls.length === 3);
    expect(e.calls.map((c) => c.method)).toEqual(["GET", "GET", "GET"]);
  });

  it("Workers: the first request after checkEveryMs checks again, in waitUntil", async () => {
    const e = await inSyncEngine();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const worker = serveCloudflare(app(e.fetch));
    const first = workersCtx();
    await worker.fetch(await signedGet(), {}, first.ctx);
    await Promise.all(first.waiting);

    vi.setSystemTime(T0 + 200_000);
    const early = workersCtx();
    await worker.fetch(await signedGet(), {}, early.ctx);
    expect(early.waiting).toHaveLength(0);

    vi.setSystemTime(T0 + 300_000);
    const late = workersCtx();
    await worker.fetch(await signedGet(), {}, late.ctx);
    expect(late.waiting).toHaveLength(1);
    await Promise.all(late.waiting);
    expect(e.calls.map((c) => c.method)).toEqual(["GET", "GET"]);
  });

  it("a canary left on the new version syncs on a later check, once the guard is off", async () => {
    // Check 1: the engine has the old manifest, but its guard is on. Check 2: off.
    let checks = 0;
    const e = engine({
      check: () =>
        Response.json(
          { appId: "shop", manifestHash: "v1:old", syncedAt: 1, retryAt: ++checks === 1 ? T0 + 60_000 : null, checkEveryMs: 300_000 },
          { headers: { Date: new Date(Date.now()).toUTCString() } },
        ),
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    vi.spyOn(console, "info").mockImplementation(() => {});
    const worker = serveCloudflare(app(e.fetch));
    const first = workersCtx();
    await worker.fetch(await signedGet(), {}, first.ctx);
    await Promise.all(first.waiting);
    expect(e.calls.map((c) => c.method)).toEqual(["GET"]);

    vi.setSystemTime(T0 + 61_000);
    const late = workersCtx();
    await worker.fetch(await signedGet(), {}, late.ctx);
    await Promise.all(late.waiting);
    expect(e.calls.map((c) => c.method)).toEqual(["GET", "GET", "PUT"]);
  });
});
