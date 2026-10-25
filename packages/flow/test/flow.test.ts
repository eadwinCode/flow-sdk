import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  generateSigningKey,
  signAnswer,
  signingKeyBearer,
  signRequest,
  verifyAnswer,
  verifySignature,
  type FlowEvent,
  type InvokeRequest,
  type MemoEntry,
  type Opcode,
  type RunStatePage,
} from "@clevix/protocol";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BASE_URL, Flow, hashStepId, NonRetriableError, RetryAfterError, SDK_VERSION, serve as serveWithBoot, StepError, type FlowFunction, type FlowOptions, type ServeOptions } from "../src/index.ts";
import { serve as serveCloudflareWithBoot } from "../src/cloudflare.ts";
// These tests do not cover the sync at boot (see boot.test.ts): it is off.
const serve = (o: ServeOptions) => serveWithBoot({ syncOnBoot: false, ...o });
const serveCloudflare = (o: ServeOptions) => serveCloudflareWithBoot({ syncOnBoot: false, ...o });
import { sha1Hex } from "../src/sha1.ts";

interface Vectors {
  stepIds: { cases: Array<{ id: string; occurrence: number; input: string; hashed: string }> };
  signatures: { cases: Array<{ signingKey: string; body: string; t: number; header: string }> };
  bearer: { signingKey: string; bearer: string };
  answers: {
    cases: Array<{
      signingKey: string;
      request: string;
      status: number;
      noRetry: string;
      retryAfter: string;
      body: string;
      header: string;
    }>;
  };
}

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../testdata/vectors.json", import.meta.url)), "utf8"),
) as Vectors;

const KEY = generateSigningKey();
const URL_ = "https://app.example.com/api/flow";
const h = (id: string, n = 0) => hashStepId(id, n);

function event(overrides: Partial<FlowEvent> = {}): FlowEvent {
  return { id: "evt_1", name: "user/signed-up", data: { userId: "u1" }, ts: 1_760_000_000_000, ...overrides };
}

function invoke(fnId: string, memo: Record<string, MemoEntry> = {}, extra: Partial<InvokeRequest> = {}): InvokeRequest {
  const e = event();
  return { fnId, runId: "run_1", event: e, events: [e], memo, attempt: 0, maxAttempts: 3, ...extra };
}

async function post(handler: (r: Request) => Promise<Response>, body: InvokeRequest | string, key = KEY): Promise<Response> {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return handler(
    new Request(URL_, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Inngest-Signature": await signRequest(key, text) },
      body: text,
    }),
  );
}

/** Makes a client, one function and its handler. */
function app(handler: FlowFunction["handler"], options: Partial<FlowFunction["options"]> = {}) {
  const flow = new Flow({ id: "shop", signingKey: KEY });
  const fn = flow.createFunction({ id: "fn", ...options }, { event: "user/signed-up" }, handler);
  return { flow, fn, handle: serve({ client: flow, functions: [fn] }) };
}

async function opsOf(res: Response): Promise<Opcode[]> {
  expect(res.status).toBe(206);
  return (await res.json()) as Opcode[];
}

describe("conformance vectors", () => {
  it("hashes step IDs", () => {
    for (const c of vectors.stepIds.cases) {
      expect(sha1Hex(c.input)).toBe(c.hashed);
      expect(hashStepId(c.id, c.occurrence)).toBe(c.hashed);
    }
  });

  it("signs requests", async () => {
    for (const c of vectors.signatures.cases) {
      expect(await signRequest(c.signingKey, c.body, c.t)).toBe(c.header);
      expect(await verifySignature({ header: c.header, body: c.body, keys: [c.signingKey], nowSec: c.t })).toBe(true);
    }
  });

  it("signs answers", async () => {
    expect(vectors.answers.cases.length).toBeGreaterThan(0);
    for (const c of vectors.answers.cases) {
      expect(await signAnswer(c.signingKey, c)).toBe(c.header);
      expect(await verifyAnswer({ ...c, header: c.header, key: c.signingKey })).toBe(true);
      expect(await verifyAnswer({ ...c, body: c.body + " ", header: c.header, key: c.signingKey })).toBe(false);
    }
  });

  it("makes the sync bearer token", async () => {
    expect(await signingKeyBearer(vectors.bearer.signingKey)).toBe(vectors.bearer.bearer);
  });

  it("the SDK refuses a vector signature: it is too old", async () => {
    const c = vectors.signatures.cases[0]!;
    const flow = new Flow({ id: "shop", signingKey: c.signingKey });
    const handle = serve({ client: flow, functions: [flow.createFunction({ id: "hello" }, { event: "a/b" }, () => 1)] });
    const res = await handle(
      new Request(URL_, { method: "POST", headers: { "X-Inngest-Signature": c.header }, body: c.body }),
    );
    expect(res.status).toBe(401);
  });

  it("hashes long and empty-looking inputs like a reference SHA-1", () => {
    expect(sha1Hex("")).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
    expect(sha1Hex("abc")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
    expect(sha1Hex("a".repeat(1000))).toBe("291e9a6c66994949b57ba5e650361e98fc36b1ba");
  });
});

describe("running a function", () => {
  it("answers 200 with the return value", async () => {
    const { handle } = app(({ event }) => ({ hello: event.data.userId }));
    const res = await post(handle, invoke("fn"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hello: "u1" });
  });

  it("answers 200 null when the function returns nothing", async () => {
    const { handle } = app(() => undefined);
    const res = await post(handle, invoke("fn"));
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  it("replays memoized steps and runs the first new one", async () => {
    const seen: unknown[] = [];
    const ran: string[] = [];
    const { handle } = app(async ({ step }) => {
      const user = await step.run("load-user", () => {
        ran.push("load-user");
        return { name: "Ada" };
      });
      seen.push(user);
      await step.run("send-welcome", () => {
        ran.push("send-welcome");
        return "sent";
      });
      ran.push("after");
    });
    const res = await post(handle, invoke("fn", { [h("load-user")]: { data: { name: "Ada" } } }));
    expect(await opsOf(res)).toEqual([{ op: "StepCompleted", id: h("send-welcome"), name: "send-welcome", data: "sent" }]);
    expect(seen).toEqual([{ name: "Ada" }]);
    expect(ran).toEqual(["send-welcome"]); // the memoized step did not run; the code after the new step did not run
  });

  it("reports a step that throws as StepFailed", async () => {
    const { handle } = app(async ({ step }) => {
      await step.run("charge", () => {
        throw new TypeError("card declined");
      });
    });
    const [op] = await opsOf(await post(handle, invoke("fn")));
    expect(op).toMatchObject({ op: "StepFailed", id: h("charge"), name: "charge", error: { name: "TypeError", message: "card declined" } });
    expect(op).not.toHaveProperty("noRetry");
  });

  it("gives each repeat of a step ID its own hash", async () => {
    const { handle } = app(async ({ step }) => {
      const out: number[] = [];
      for (let i = 0; i < 3; i++) out.push(await step.run("fetch", () => i));
      return out;
    });
    const memo = { [h("fetch")]: { data: 0 }, [h("fetch", 1)]: { data: 1 } };
    expect(await opsOf(await post(handle, invoke("fn", memo)))).toEqual([
      { op: "StepCompleted", id: h("fetch", 2), name: "fetch", data: 2 },
    ]);
    const res = await post(handle, invoke("fn", { ...memo, [h("fetch", 2)]: { data: 2 } }));
    expect(await res.json()).toEqual([0, 1, 2]);
  });

  it("plans parallel steps without running them", async () => {
    const ran: string[] = [];
    const { handle } = app(async ({ step }) => {
      const [a, b] = await Promise.all([
        step.run("a", () => ran.push("a")),
        step.run("b", () => ran.push("b")),
      ]);
      return { a, b };
    });
    expect(await opsOf(await post(handle, invoke("fn")))).toEqual([
      { op: "StepPlanned", id: h("a"), name: "a" },
      { op: "StepPlanned", id: h("b"), name: "b" },
    ]);
    expect(ran).toEqual([]);
  });

  it("finds parallel steps that come after memoized ones in the same group", async () => {
    const { handle } = app(async ({ step }) => {
      await Promise.all([
        step.run("a", () => 1).then(() => step.run("a2", () => 2)),
        step.run("b", () => 3),
      ]);
    });
    // a is done, so a2 is found in a later microtask than b: still together.
    expect(await opsOf(await post(handle, invoke("fn", { [h("a")]: { data: 1 } })))).toEqual([
      { op: "StepPlanned", id: h("b"), name: "b" },
      { op: "StepPlanned", id: h("a2"), name: "a2" },
    ]);
  });

  it("mixes planned runs with other step opcodes", async () => {
    const { handle } = app(async ({ step }) => {
      await Promise.all([step.run("a", () => 1), step.sleep("nap", "1h")]);
    });
    const ops = await opsOf(await post(handle, invoke("fn")));
    expect(ops[0]).toEqual({ op: "StepPlanned", id: h("a"), name: "a" });
    expect(ops[1]).toMatchObject({ op: "Sleep", id: h("nap"), name: "nap" });
  });

  it("with targetStepId, runs only that step", async () => {
    const ran: string[] = [];
    const { handle } = app(async ({ step }) => {
      await Promise.all([
        step.run("a", () => ran.push("a")),
        step.run("b", () => {
          ran.push("b");
          return "B";
        }),
      ]);
      ran.push("after");
    });
    const ops = await opsOf(await post(handle, invoke("fn", {}, { targetStepId: h("b") })));
    expect(ops).toEqual([{ op: "StepCompleted", id: h("b"), name: "b", data: "B" }]);
    expect(ran).toEqual(["b"]);
  });

  it("with targetStepId, reports a failure of that step", async () => {
    const { handle } = app(async ({ step }) => {
      await Promise.all([step.run("a", () => 1), step.run("b", () => Promise.reject(new Error("no")))]);
    });
    const ops = await opsOf(await post(handle, invoke("fn", { [h("a")]: { data: 1 } }, { targetStepId: h("b") })));
    expect(ops).toEqual([{ op: "StepFailed", id: h("b"), name: "b", error: expect.objectContaining({ message: "no" }) }]);
  });

  it("answers 500 when the target step is never reached", async () => {
    const { handle } = app(async ({ step }) => {
      await step.run("a", () => 1);
    });
    const res = await post(handle, invoke("fn", {}, { targetStepId: "f".repeat(40) }));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ name: "StepNotFound" });
  });

  it("sends the right opcodes for sleep, wait, send and invoke", async () => {
    const other = new Flow({ id: "billing" }).createFunction({ id: "charge" }, { event: "x/y" }, () => null);
    const until = new Date("2030-01-01T00:00:00Z");
    const cases: Array<[FlowFunction["handler"], Opcode]> = [
      [({ step }) => step.sleepUntil("later", until), { op: "Sleep", id: h("later"), name: "later", until: until.getTime() }],
      [
        ({ step }) => step.waitForEvent("wait", { event: "user/onboarded", timeout: "7d", match: "data.userId" }),
        { op: "WaitForEvent", id: h("wait"), name: "wait", event: "user/onboarded", timeout: "7d", match: "data.userId" },
      ],
      [
        ({ step }) => step.waitForEvent("wait", { event: "a/b", timeout: 1000, if: "async.data.x == event.data.x" }),
        { op: "WaitForEvent", id: h("wait"), name: "wait", event: "a/b", timeout: 1000, if: "async.data.x == event.data.x" },
      ],
      [
        ({ step }) => step.sendEvent("send", { name: "a/b", data: { x: 1 } }),
        { op: "SendEvent", id: h("send"), name: "send", events: [{ name: "a/b", data: { x: 1 } }] },
      ],
      [
        ({ step }) => step.invoke("call", { function: other, data: { amount: 5 }, timeout: "1h" }),
        { op: "InvokeFunction", id: h("call"), name: "call", function: "billing-charge", data: { amount: 5 }, timeout: "1h" },
      ],
      [
        ({ step }) => step.invoke("call", { function: "go-app-work" }),
        { op: "InvokeFunction", id: h("call"), name: "call", function: "go-app-work" },
      ],
    ];
    for (const [handler, expected] of cases) {
      const { handle } = app(handler);
      expect(await opsOf(await post(handle, invoke("fn")))).toEqual([expected]);
    }
  });

  it("computes Sleep.until from now for step.sleep", async () => {
    const { handle } = app(({ step }) => step.sleep("nap", "3d"));
    const before = Date.now();
    const [op] = await opsOf(await post(handle, invoke("fn")));
    const until = (op as { until: number }).until;
    expect(until).toBeGreaterThanOrEqual(before + 3 * 86_400_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 3 * 86_400_000);
  });

  it("gives memo values back for sleep, wait, send and invoke", async () => {
    const matched = event({ id: "evt_2", name: "user/onboarded" });
    const { handle } = app(async ({ step }) => {
      await step.sleep("nap", "1d");
      const got = await step.waitForEvent("wait", { event: "user/onboarded", timeout: "7d" });
      const missed = await step.waitForEvent("wait2", { event: "user/onboarded", timeout: "7d" });
      const sent = await step.sendEvent("send", [{ name: "a/b" }]);
      const child = await step.invoke("call", { function: "shop-other" });
      return { got: got?.id, missed, sent, child };
    });
    const memo = {
      [h("nap")]: { data: null },
      [h("wait")]: { data: matched },
      [h("wait2")]: { data: null },
      [h("send")]: { data: { ids: ["evt_9"] } },
      [h("call")]: { data: { ok: 1 } },
    };
    const res = await post(handle, invoke("fn", memo));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ got: "evt_2", missed: null, sent: { ids: ["evt_9"] }, child: { ok: 1 } });
  });

  it("throws StepError from a memoized error, which the function can catch", async () => {
    let caught: unknown;
    const { handle } = app(async ({ step }) => {
      try {
        await step.run("charge", () => 1);
      } catch (err) {
        caught = err;
        await step.run("refund", () => "refunded");
      }
    });
    const memo = { [h("charge")]: { error: { name: "CardError", message: "declined" } } };
    const ops = await opsOf(await post(handle, invoke("fn", memo)));
    expect(ops).toEqual([{ op: "StepCompleted", id: h("refund"), name: "refund", data: "refunded" }]);
    expect(caught).toBeInstanceOf(StepError);
    expect(caught).toMatchObject({ name: "CardError", message: "declined", stepId: "charge" });
  });

  it("an uncaught StepError fails the call with 500", async () => {
    const { handle } = app(async ({ step }) => {
      await step.invoke("call", { function: "shop-other" });
    });
    const res = await post(handle, invoke("fn", { [h("call")]: { error: { name: "InvokeTimeout", message: "too slow" } } }));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ name: "InvokeTimeout", message: "too slow" });
  });

  it("passes an idempotency key and the attempt to step.run", async () => {
    const { handle } = app(({ step }) => step.run("pay", (info) => info));
    const [op] = await opsOf(await post(handle, invoke("fn", {}, { attempt: 2 })));
    expect((op as { data: unknown }).data).toEqual({ stepId: h("pay"), idempotencyKey: `run_1:${h("pay")}`, attempt: 2 });
  });

  it("fails a step whose output is over 4 MB, with no retry", async () => {
    const { handle } = app(({ step }) => step.run("big", () => "x".repeat(4_100_000)));
    const [op] = await opsOf(await post(handle, invoke("fn")));
    expect(op).toMatchObject({ op: "StepFailed", noRetry: true, error: { name: "OutputTooLarge" } });
  });
});

describe("errors", () => {
  it("NonRetriableError in a step sets noRetry", async () => {
    const { handle } = app(({ step }) =>
      step.run("s", () => {
        throw new NonRetriableError("bad input");
      }),
    );
    const [op] = await opsOf(await post(handle, invoke("fn")));
    expect(op).toMatchObject({ op: "StepFailed", noRetry: true, error: { name: "NonRetriableError", message: "bad input" } });
  });

  it("RetryAfterError in a step sets retryAt", async () => {
    const at = new Date(Date.now() + 60_000);
    const { handle } = app(({ step }) =>
      step.run("s", () => {
        throw new RetryAfterError("rate limited", at);
      }),
    );
    const [op] = await opsOf(await post(handle, invoke("fn")));
    expect(op).toMatchObject({ op: "StepFailed", retryAt: at.getTime(), error: { name: "RetryAfterError" } });
  });

  it("an error outside a step answers 500 with the error", async () => {
    const { handle } = app(() => {
      throw new Error("boom");
    });
    const res = await post(handle, invoke("fn"));
    expect(res.status).toBe(500);
    expect(res.headers.get("X-Inngest-No-Retry")).toBeNull();
    expect(await res.json()).toMatchObject({ name: "Error", message: "boom", stack: expect.any(String) });
  });

  it("NonRetriableError outside a step sets X-Inngest-No-Retry", async () => {
    const { handle } = app(() => {
      throw new NonRetriableError("stop");
    });
    const res = await post(handle, invoke("fn"));
    expect(res.status).toBe(500);
    expect(res.headers.get("X-Inngest-No-Retry")).toBe("true");
  });

  it("RetryAfterError outside a step sets Retry-After in seconds", async () => {
    const { handle } = app(() => {
      throw new RetryAfterError("later", "2m");
    });
    const res = await post(handle, invoke("fn"));
    expect(res.status).toBe(500);
    const seconds = Number(res.headers.get("Retry-After"));
    expect(seconds).toBeGreaterThanOrEqual(119);
    expect(seconds).toBeLessThanOrEqual(120);
  });

  it("an unknown function answers 500 FunctionNotFound with no retry", async () => {
    const { handle } = app(() => 1);
    const res = await post(handle, invoke("nope"));
    expect(res.status).toBe(500);
    expect(res.headers.get("X-Inngest-No-Retry")).toBe("true");
    expect(await res.json()).toMatchObject({ name: "FunctionNotFound" });
  });
});

describe("signatures", () => {
  it("rejects a missing, wrong or old signature with 401 and does not run", async () => {
    const run = vi.fn(() => 1);
    const { handle } = app(run);
    const body = JSON.stringify(invoke("fn"));
    const old = await signRequest(KEY, body, Math.floor(Date.now() / 1000) - 301);
    const wrong = await signRequest(generateSigningKey(), body);
    for (const header of [null, old, wrong, "t=abc&s=def"]) {
      const headers: Record<string, string> = header ? { "X-Inngest-Signature": header } : {};
      const res = await handle(new Request(URL_, { method: "POST", headers, body }));
      expect(res.status).toBe(401);
    }
    // A changed body fails too.
    const header = await signRequest(KEY, body);
    const res = await handle(new Request(URL_, { method: "POST", headers: { "X-Inngest-Signature": header }, body: `${body} ` }));
    expect(res.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("accepts the fallback key while rotating", async () => {
    const oldKey = generateSigningKey();
    const flow = new Flow({ id: "shop", signingKey: KEY, signingKeyFallback: oldKey });
    const handle = serve({ client: flow, functions: [flow.createFunction({ id: "fn" }, { event: "a/b" }, () => "ok")] });
    const res = await post(handle, invoke("fn"), oldKey);
    expect(res.status).toBe(200);
  });

  it("refuses to serve without a signing key unless dev mode", async () => {
    const flow = new Flow({ id: "shop" });
    const fn = flow.createFunction({ id: "fn" }, { event: "a/b" }, () => "ok");
    const res = await serve({ client: flow, functions: [fn] })(new Request(URL_, { method: "POST", body: JSON.stringify(invoke("fn")) }));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ name: "NoSigningKey" });

    // Dev mode from the Workers env: no signature needed.
    const dev = await serve({ client: flow, functions: [fn] })(
      new Request(URL_, { method: "POST", body: JSON.stringify(invoke("fn")) }),
      { FLOW_DEV: "1" },
    );
    expect(dev.status).toBe(200);
    expect(await dev.json()).toBe("ok");
  });

  it("reads the signing key from the Workers env", async () => {
    const flow = new Flow({ id: "shop" });
    const fn = flow.createFunction({ id: "fn" }, { event: "a/b" }, () => "ok");
    const worker = serveCloudflare({ client: flow, functions: [fn] });
    const body = JSON.stringify(invoke("fn"));
    const req = new Request(URL_, { method: "POST", headers: { "X-Inngest-Signature": await signRequest(KEY, body) }, body });
    const res = await worker.fetch(req, { FLOW_SIGNING_KEY: KEY });
    expect(res.status).toBe(200);
  });
});

describe("manifest and sync", () => {
  const flow = new Flow({ id: "billing", signingKey: KEY, baseUrl: "https://engine.example.com/" });
  const charge = flow.createFunction(
    {
      id: "charge",
      name: "Charge",
      retries: 4,
      concurrency: { limit: 10, key: "event.data.accountId" },
      timeouts: { step: "30s", finish: "15m" },
      onFailure: async ({ error, event, step }) => step.run("notify", () => ({ message: error.message, original: event.data.event.name })),
    },
    [{ event: "billing/charge" }, { cron: "0 2 * * *" }],
    () => null,
  );

  it("GET returns the manifest, signed over the empty body", async () => {
    const handle = serve({ client: flow, functions: [charge] });
    expect((await handle(new Request(URL_))).status).toBe(401);
    const res = await handle(new Request(URL_, { headers: { "X-Inngest-Signature": await signRequest(KEY, "") } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      appId: "billing",
      url: URL_,
      sdk: { language: "typescript", version: SDK_VERSION },
      functions: [
        {
          id: "charge",
          name: "Charge",
          triggers: [{ event: "billing/charge" }, { cron: "0 2 * * *" }],
          retries: 4,
          concurrency: { limit: 10, key: "event.data.accountId" },
          timeouts: { step: "30s", finish: "15m" },
        },
        {
          id: "charge-failure",
          triggers: [{ event: "inngest/function.failed", if: "event.data.function_id == 'billing-charge'" }],
        },
      ],
      manifestHash: expect.stringMatching(/^v1:[0-9a-f]{64}$/),
    });
  });

  it("PUT sends the manifest to the engine and returns its answer", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const mock = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json({ ok: true, created: true, modified: ["billing-charge"], archived: [] });
    }) as unknown as typeof fetch;
    const client = new Flow({ ...flow.options, fetch: mock });
    const handle = serve({ client, functions: [client.createFunction({ id: "charge" }, { event: "billing/charge" }, () => null)] });
    const res = await handle(new Request(URL_, { method: "PUT" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, created: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://engine.example.com/apps/billing/sync");
    expect(calls[0]!.init.method).toBe("PUT");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${await signingKeyBearer(KEY)}`);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      appId: "billing",
      url: URL_,
      sdk: { language: "typescript", version: SDK_VERSION },
      functions: [{ id: "charge", triggers: [{ event: "billing/charge" }] }],
      manifestHash: expect.stringMatching(/^v1:[0-9a-f]{64}$/),
    });
  });

  it("PUT passes on an engine error as it came", async () => {
    const mock = (async () => Response.json({ error: "invalid signing key", status: 401 }, { status: 401 })) as unknown as typeof fetch;
    const client = new Flow({ ...flow.options, fetch: mock });
    const res = await serve({ client, functions: [] })(new Request(URL_, { method: "PUT" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid signing key", status: 401 });
  });

  it("the failure function gets the error and the failure event", async () => {
    const handle = serve({ client: flow, functions: [charge] });
    const failed = event({
      name: "inngest/function.failed",
      data: { function_id: "billing-charge", run_id: "run_0", error: { name: "Error", message: "card gone" }, event: event({ name: "billing/charge" }) },
    });
    const res = await post(handle, { ...invoke("charge-failure"), event: failed, events: [failed] });
    expect(await opsOf(res)).toEqual([
      { op: "StepCompleted", id: h("notify"), name: "notify", data: { message: "card gone", original: "billing/charge" } },
    ]);
  });

  it("checks IDs", () => {
    expect(() => new Flow({ id: "bad id" })).toThrow();
    expect(() => flow.createFunction({ id: "-x" }, { event: "a/b" }, () => 1)).toThrow();
    expect(() => flow.createFunction({ id: "x" }, [], () => 1)).toThrow();
    expect(() => flow.createFunction({ id: "a".repeat(60), onFailure: () => 1 }, { event: "a/b" }, () => 1)).toThrow(/too long/);
  });
});

describe("engine URL", () => {
  it("is the option, else FLOW_BASE_URL, else the default", () => {
    expect(DEFAULT_BASE_URL).toBe("https://worker.flow.clevixstudio.com");
    expect(new Flow({ id: "a" }).settings({}).baseUrl).toBe(DEFAULT_BASE_URL);
    expect(new Flow({ id: "a" }).settings({ FLOW_BASE_URL: "https://mine.example.com" }).baseUrl).toBe("https://mine.example.com");
    expect(new Flow({ id: "a", baseUrl: "https://opt.example.com" }).settings({ FLOW_BASE_URL: "https://mine.example.com" }).baseUrl).toBe(
      "https://opt.example.com",
    );
    // Empty counts as not set, like in the Go SDK.
    expect(new Flow({ id: "a", baseUrl: "" }).settings({ FLOW_BASE_URL: "" }).baseUrl).toBe(DEFAULT_BASE_URL);
  });

  it("PUT sync sends this endpoint's own URL (FLOW_SERVE_URL is gone)", async () => {
    const bodies: string[] = [];
    const mock = (async (_url: string, init: RequestInit) => {
      bodies.push(init.body as string);
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    const flow = new Flow({ id: "shop", signingKey: KEY, fetch: mock });
    await serve({ client: flow, functions: [] })(new Request("https://shop.example.com/api/flow?x=1", { method: "PUT" }), {
      FLOW_SERVE_URL: "https://ignored.example.com/flow",
    });
    expect(JSON.parse(bodies[0]!).url).toBe("https://shop.example.com/api/flow");
  });
});

describe("sending events", () => {
  it("posts to /e with the event key", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const mock = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json({ ids: ["evt_1"], status: 200 });
    }) as unknown as typeof fetch;
    const flow = new Flow({ id: "shop", fetch: mock });
    const out = await flow.send({ name: "user/signed-up", data: { userId: "u1" } }, {
      env: { FLOW_EVENT_KEY: "ek", FLOW_BASE_URL: "https://engine.example.com" },
    });
    expect(out).toEqual({ ids: ["evt_1"], status: 200 });
    expect(calls[0]!.url).toBe("https://engine.example.com/e");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer ek");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ name: "user/signed-up", data: { userId: "u1" } });
  });

  it("throws on an engine error", async () => {
    const mock = (async () => Response.json({ error: "invalid event key", status: 401 }, { status: 401 })) as unknown as typeof fetch;
    const flow = new Flow({ id: "shop", fetch: mock, eventKey: "bad", baseUrl: "https://engine.example.com" });
    await expect(flow.send([{ name: "a/b" }])).rejects.toThrow(/401.*invalid event key/);
  });
});

describe("big state (useApi)", () => {
  const BASE = "https://engine.example.com/";
  const STATE_URL = "https://engine.example.com/runs/run_1/state";
  type Page = RunStatePage | Response | Error;

  /** A fake engine: answers each state request with the next page. */
  function engine(pages: Page[]) {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const mock = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), auth: new Headers(init?.headers).get("Authorization") });
      const next = pages.shift();
      if (!next) return Response.json({ error: "no more pages" }, { status: 500 });
      if (next instanceof Error) throw next;
      if (next instanceof Response) return next;
      return Response.json(next);
    }) as unknown as typeof fetch;
    return { calls, mock };
  }

  function bigApp(handler: FlowFunction["handler"], fetchMock: typeof fetch, options: Partial<FlowOptions> = {}) {
    const flow = new Flow({ id: "shop", signingKey: KEY, baseUrl: BASE, fetch: fetchMock, ...options });
    const fn = flow.createFunction({ id: "fn" }, { event: "user/signed-up" }, handler);
    return serve({ client: flow, functions: [fn] });
  }

  const useApi = () => invoke("fn", {}, { events: [], useApi: true });

  it("loads every page, merges the memo, takes events from page 1, then runs", async () => {
    const { calls, mock } = engine([
      { events: [event({ id: "evt_a" }), event({ id: "evt_b" })], memo: { [h("a")]: { data: "A" } }, next: "c 1" },
      { memo: { [h("b")]: { data: { big: "B" } } }, next: "c2" },
      { events: [event({ id: "ignored" })], memo: { [h("c")]: { error: { name: "Error", message: "boom" } } }, next: null },
    ]);
    const ran: string[] = [];
    let seenEvents: FlowEvent[] = [];
    const handle = bigApp(async ({ step, events }) => {
      seenEvents = events;
      const a = await step.run("a", () => ran.push("a"));
      const b = await step.run("b", () => ran.push("b"));
      let c: unknown;
      try {
        await step.run("c", () => ran.push("c"));
      } catch (err) {
        c = err instanceof StepError ? "caught" : err;
      }
      return { a, b, c };
    }, mock);

    const res = await post(handle, useApi());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ a: "A", b: { big: "B" }, c: "caught" });
    expect(ran).toEqual([]);
    expect(seenEvents.map((e) => e.id)).toEqual(["evt_a", "evt_b"]);
    const bearer = `Bearer ${await signingKeyBearer(KEY)}`;
    expect(calls).toEqual([
      { url: STATE_URL, auth: bearer },
      { url: `${STATE_URL}?cursor=c%201`, auth: bearer },
      { url: `${STATE_URL}?cursor=c2`, auth: bearer },
    ]);
  });

  it("uses the current signing key, not the fallback", async () => {
    const { calls, mock } = engine([{ events: [], memo: {}, next: null }]);
    const handle = bigApp(() => "ok", mock, { signingKeyFallback: generateSigningKey() });
    expect((await post(handle, useApi())).status).toBe(200);
    expect(calls[0]!.auth).toBe(`Bearer ${await signingKeyBearer(KEY)}`);
  });

  it("runs the first new step after loading the memo", async () => {
    const { mock } = engine([{ events: [event()], memo: { [h("a")]: { data: 1 } }, next: null }]);
    const handle = bigApp(async ({ step }) => {
      const a = await step.run("a", () => 100);
      return step.run("b", () => (a as number) + 1);
    }, mock);
    expect(await opsOf(await post(handle, useApi()))).toEqual([{ op: "StepCompleted", id: h("b"), name: "b", data: 2 }]);
  });

  const failures: Array<[string, () => Page[]]> = [
    ["a 404 answer", () => [Response.json({ error: "no such run" }, { status: 404 })]],
    ["a 401 answer", () => [Response.json({ error: "bad key" }, { status: 401 })]],
    ["bad JSON", () => [new Response("not json", { status: 200 })]],
    ["a page without memo", () => [Response.json({ next: null })]],
    ["a network error", () => [new Error("connection reset")]],
    ["a later page failing", () => [{ events: [], memo: { [h("a")]: { data: 1 } }, next: "c2" }, new Response("oops", { status: 503 })]],
  ];
  for (const [name, pages] of failures) {
    it(`answers 500 StateLoadFailed on ${name}, without running the function`, async () => {
      const { mock } = engine(pages());
      const handler = vi.fn(() => "ran");
      const res = await post(bigApp(handler, mock), useApi());
      expect(res.status).toBe(500);
      expect(res.headers.get("X-Inngest-No-Retry")).toBeNull();
      expect(((await res.json()) as { name: string }).name).toBe("StateLoadFailed");
      expect(handler).not.toHaveBeenCalled();
    });
  }

  it("loads the state from the default engine URL when none is set", async () => {
    const { calls, mock } = engine([{ events: [event()], memo: {}, next: null }]);
    const flow = new Flow({ id: "shop", signingKey: KEY, fetch: mock });
    const handle = serve({ client: flow, functions: [flow.createFunction({ id: "fn" }, { event: "user/signed-up" }, () => "ran")] });
    const res = await post(handle, useApi());
    expect(res.status).toBe(200);
    expect(calls[0]!.url).toMatch(/^https:\/\/worker\.flow\.clevixstudio\.com\/runs\//);
  });

  it("needs a signing key even in dev mode (same as the Go SDK)", async () => {
    const { calls, mock } = engine([{ events: [event()], memo: {}, next: null }]);
    const handle = bigApp(() => "ok", mock, { signingKey: undefined, isDev: true });
    const res = await handle(new Request(URL_, { method: "POST", body: JSON.stringify(useApi()) }));
    expect(res.status).toBe(500);
    expect((await res.json()).name).toBe("StateLoadFailed");
    expect(calls).toEqual([]);
  });

  it("does not call the state API without useApi", async () => {
    const { calls, mock } = engine([]);
    const handle = bigApp(async ({ step }) => step.run("a", () => 1), mock);
    const res = await post(handle, invoke("fn", { [h("a")]: { data: 7 } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toBe(7);
    expect(calls).toEqual([]);
  });
});

describe("answer signature", () => {
  async function check(res: Response, request: string, key = KEY): Promise<boolean> {
    return verifyAnswer({
      header: res.headers.get("X-Flow-Answer-Signature"),
      key,
      request,
      status: res.status,
      noRetry: res.headers.get("X-Inngest-No-Retry"),
      retryAfter: res.headers.get("Retry-After"),
      body: await res.clone().text(),
    });
  }

  it("signs the manifest GET", async () => {
    const { handle } = app(() => 1);
    const request = await signRequest(KEY, "");
    const res = await handle(new Request(URL_, { headers: { "X-Inngest-Signature": request } }));
    expect(res.status).toBe(200);
    expect(await check(res, request)).toBe(true);
    // Another request's signature does not fit this answer.
    expect(await check(res, await signRequest(KEY, "x"))).toBe(false);
  });

  it("signs POST answers: done, steps, and errors with their retry headers", async () => {
    const flow = new Flow({ id: "shop", signingKey: KEY });
    const fns = [
      flow.createFunction({ id: "done" }, { event: "a/b" }, () => "ok"),
      flow.createFunction({ id: "step" }, { event: "a/b" }, async ({ step }) => step.run("s", () => 1)),
      flow.createFunction({ id: "fail" }, { event: "a/b" }, () => {
        throw new NonRetriableError("no");
      }),
      flow.createFunction({ id: "later" }, { event: "a/b" }, () => {
        throw new RetryAfterError("later", new Date(Date.now() + 60_000));
      }),
    ];
    const handle = serve({ client: flow, functions: fns });
    for (const fnId of ["done", "step", "fail", "later", "missing"]) {
      const text = JSON.stringify(invoke(fnId));
      const request = await signRequest(KEY, text);
      const res = await handle(new Request(URL_, { method: "POST", headers: { "X-Inngest-Signature": request }, body: text }));
      expect(await check(res, request), fnId).toBe(true);
    }
  });

  it("signs with the key that matched (the fallback while rotating)", async () => {
    const old = generateSigningKey();
    const flow = new Flow({ id: "shop", signingKey: KEY, signingKeyFallback: old });
    const handle = serve({ client: flow, functions: [] });
    const request = await signRequest(old, "");
    const res = await handle(new Request(URL_, { headers: { "X-Inngest-Signature": request } }));
    expect(await check(res, request, old)).toBe(true);
  });

  it("signs a 500 when the output can not be made JSON", async () => {
    const flow = new Flow({ id: "shop", signingKey: KEY });
    const handle = serve({ client: flow, functions: [flow.createFunction({ id: "big" }, { event: "a/b" }, () => ({ n: 1n }))] });
    const text = JSON.stringify(invoke("big"));
    const request = await signRequest(KEY, text);
    const res = await handle(new Request(URL_, { method: "POST", headers: { "X-Inngest-Signature": request }, body: text }));
    expect(res.status).toBe(500);
    expect(((await res.clone().json()) as { name: string }).name).toBe("SerializationError");
    expect(await check(res, request)).toBe(true);
  });

  it("dev mode with a bad fallback key still takes signed calls", async () => {
    const flow = new Flow({ id: "shop", signingKeyFallback: "junk", isDev: true });
    const handle = serve({ client: flow, functions: [] });
    const res = await handle(new Request(URL_, { headers: { "X-Inngest-Signature": await signRequest(KEY, "") } }));
    expect(res.status).toBe(200);
  });

  it("does not sign a 401", async () => {
    const { handle } = app(() => 1);
    const res = await handle(new Request(URL_));
    expect(res.status).toBe(401);
    expect(res.headers.get("X-Flow-Answer-Signature")).toBeNull();
  });

  it("dev mode signs only signed calls", async () => {
    const flow = new Flow({ id: "shop", signingKey: KEY, isDev: true });
    const handle = serve({ client: flow, functions: [] });
    const unsigned = await handle(new Request(URL_));
    expect(unsigned.status).toBe(200);
    expect(unsigned.headers.get("X-Flow-Answer-Signature")).toBeNull();
    const request = await signRequest(KEY, "");
    expect(await check(await handle(new Request(URL_, { headers: { "X-Inngest-Signature": request } })), request)).toBe(true);
  });
});
