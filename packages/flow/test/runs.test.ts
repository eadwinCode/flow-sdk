import { signingKeyBearer, type FlowEvent } from "@clevix/protocol";
import { describe, expect, it } from "vitest";
import { buildManifest, Flow, type FailureContext, type HandlerContext } from "../src/index.ts";
import { fakeFetch } from "./fakes.ts";

const KEY = `signkey-${"ab".repeat(32)}`;
const OLD_KEY = `signkey-${"cd".repeat(32)}`;
const BASE = "https://engine.test";

function client(answer: (url: string, init: RequestInit) => Response) {
  const { fetch, calls } = fakeFetch(answer);
  return { flow: new Flow({ id: "shop", signingKey: KEY, baseUrl: `${BASE}/`, fetch }), calls };
}

describe("flow.start", () => {
  it("posts to the function's start route with the signing key", async () => {
    const answer = { started: true, runId: "run_1", eventId: "evt_1" };
    const { flow, calls } = client(() => Response.json(answer));
    expect(await flow.start("agentenkit-run", { data: { job: 1 }, id: "job-1", user: { id: "u" } })).toEqual(answer);
    expect(calls).toEqual([
      {
        url: `${BASE}/v1/functions/agentenkit-run/start`,
        method: "POST",
        auth: `Bearer ${await signingKeyBearer(KEY)}`,
        contentType: "application/json",
        body: { appId: "shop", data: { job: 1 }, id: "job-1", user: { id: "u" } },
      },
    ]);
  });

  it("sends only the app ID when nothing else is given, and takes a function", async () => {
    const { flow, calls } = client(() => Response.json({ started: true, runId: "run_1", eventId: "evt_1", existed: true }));
    const fn = flow.createFunction({ id: "fn" }, { event: "a/b" }, () => null);
    expect(await flow.start(fn)).toMatchObject({ existed: true });
    expect(calls[0]).toMatchObject({ url: `${BASE}/v1/functions/fn/start`, body: { appId: "shop" } });
  });

  it("leaves out an empty id", async () => {
    const { flow, calls } = client(() => Response.json({ started: true, runId: "run_1", eventId: "evt_1" }));
    await flow.start("fn", { id: "" });
    expect(calls[0]!.body).toEqual({ appId: "shop" });
  });

  it("keeps the HTTP status on the error", async () => {
    const { flow } = client(() => Response.json({ error: "suspended", status: 403, code: "WorkspaceSuspended" }, { status: 403 }));
    await expect(flow.start("fn")).rejects.toMatchObject({ status: 403 });
  });

  it("refuses another app's function", async () => {
    const { flow } = client(() => Response.json({}));
    const other = new Flow({ id: "other" }).createFunction({ id: "fn" }, { event: "a/b" }, () => null);
    await expect(flow.start(other)).rejects.toThrow("belongs to app other, not shop");
  });

  it("does not throw when the run did not start", async () => {
    const answers = [
      { started: false, reason: "singleton", activeRunId: "run_0" },
      { started: false, reason: "singleton", activeRunId: null },
      { started: false, reason: "paused" },
      { started: false, reason: "not_found" },
    ];
    let i = 0;
    const { flow } = client(() => Response.json(answers[i++]));
    for (const answer of answers) expect(await flow.start("fn")).toEqual(answer);
  });

  it("throws for any other answer", async () => {
    const { flow } = client(() =>
      Response.json({ error: "too many events", status: 429, code: "RateLimited" }, { status: 429, headers: { "Retry-After": "1" } }),
    );
    await expect(flow.start("fn")).rejects.toThrow("start failed (429): too many events");
  });

  it("tries the fallback key on a 401", async () => {
    const good = `Bearer ${await signingKeyBearer(OLD_KEY)}`;
    const { fetch, calls } = fakeFetch((_url, init) =>
      (init.headers as Record<string, string>).Authorization === good
        ? Response.json({ started: false, reason: "paused" })
        : Response.json({ error: "invalid signing key", status: 401 }, { status: 401 }),
    );
    const flow = new Flow({ id: "shop", signingKey: KEY, signingKeyFallback: OLD_KEY, baseUrl: BASE, fetch });
    expect(await flow.start("fn")).toEqual({ started: false, reason: "paused" });
    expect(calls.map((c) => c.auth)).toEqual([`Bearer ${await signingKeyBearer(KEY)}`, good]);
  });
});

describe("flow.runs", () => {
  it("list sends the filters in the query, with no body", async () => {
    const page = {
      items: [{ id: "run_1", functionId: "fn", status: "sleeping", createdAt: 1, endedAt: null, tags: { agentRun: "r_1" } }],
      next: "c2",
    };
    const { flow, calls } = client(() => Response.json(page));
    const got = await flow.runs.list({ function: "fn", status: ["queued", "sleeping"], tags: { agentRun: "r_1" }, limit: 20, before: "c1" });
    expect(got).toEqual(page);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("GET");
    expect(call.body).toBeUndefined();
    expect(call.contentType).toBeUndefined();
    expect(call.auth).toBe(`Bearer ${await signingKeyBearer(KEY)}`);
    const url = new URL(call.url);
    expect(url.origin + url.pathname).toBe(`${BASE}/v1/runs`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      function: "fn",
      status: "queued,sleeping",
      "tag.agentRun": "r_1",
      limit: "20",
      before: "c1",
      appId: "shop",
    });
  });

  it("list with no options sends only the app ID", async () => {
    const { flow, calls } = client(() => Response.json({ items: [], next: null }));
    expect(await flow.runs.list()).toEqual({ items: [], next: null });
    expect(calls[0]!.url).toBe(`${BASE}/v1/runs?appId=shop`);
  });

  it("list leaves out empty values", async () => {
    const { flow, calls } = client(() => Response.json({ items: [], next: null }));
    await flow.runs.list({ function: "", status: [], before: "" });
    expect(calls[0]!.url).toBe(`${BASE}/v1/runs?appId=shop`);
  });

  it("list throws with the engine's error", async () => {
    const { flow } = client(() => Response.json({ error: "a tag filter needs function", status: 400 }, { status: 400 }));
    await expect(flow.runs.list({ tags: { a: "b" } })).rejects.toThrow("runs list failed (400): a tag filter needs function");
  });

  it("list tries the fallback key on a 401", async () => {
    const good = `Bearer ${await signingKeyBearer(OLD_KEY)}`;
    const { fetch, calls } = fakeFetch((_url, init) =>
      (init.headers as Record<string, string>).Authorization === good
        ? Response.json({ items: [], next: null })
        : Response.json({ error: "invalid signing key", status: 401 }, { status: 401 }),
    );
    const flow = new Flow({ id: "shop", signingKey: KEY, signingKeyFallback: OLD_KEY, baseUrl: BASE, fetch });
    expect(await flow.runs.list()).toEqual({ items: [], next: null });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.method).toBe("GET");
  });

  it("counts reads one function's counts", async () => {
    const counts = {
      queued: 3, running: 1, sleeping: 12, waiting: 0, waiting_for_app: 0, paused: 0,
      completed: 140, failed: 2, cancelled: 5, since: 1_793_000_000_000,
    };
    const { flow, calls } = client(() => Response.json(counts));
    expect(await flow.runs.counts({ function: "agentenkit-run" })).toEqual(counts);
    expect(calls[0]).toMatchObject({ method: "GET", url: `${BASE}/v1/runs/counts?function=agentenkit-run&appId=shop` });
  });

  it("singleton sends a string key as key and any other value as keyJson", async () => {
    const { flow, calls } = client(() => Response.json({ runId: "run_1", status: "sleeping" }));
    expect(await flow.runs.singleton("fn", "hitl:call 1")).toEqual({ runId: "run_1", status: "sleeping" });
    await flow.runs.singleton("fn", 42);
    await flow.runs.singleton("fn", { a: [1] });
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "GET"]);
    expect(calls.map((c) => Object.fromEntries(new URL(c.url).searchParams))).toEqual([
      { key: "hitl:call 1", appId: "shop" },
      { keyJson: "42", appId: "shop" },
      { keyJson: '{"a":[1]}', appId: "shop" },
    ]);
    expect(new URL(calls[0]!.url).pathname).toBe("/v1/functions/fn/singleton");
  });

  it("singleton throws for a function with no singleton", async () => {
    const { flow } = client(() => Response.json({ error: "function fn has no singleton", status: 400 }, { status: 400 }));
    await expect(flow.runs.singleton("fn", "k")).rejects.toThrow("runs singleton failed (400): function fn has no singleton");
  });

  it("cancel sends each of the three shapes", async () => {
    const answer = { cancelled: ["run_1"], notActive: [], more: false, next: null };
    const { flow, calls } = client(() => Response.json(answer));
    expect(await flow.runs.cancel({ runId: "run_1" })).toEqual(answer);
    await flow.runs.cancel({ function: "fn", singletonKey: "hitl-expiry:call_1" });
    await flow.runs.cancel({ function: "fn", tag: { agentRun: "r_1" }, status: ["queued", "sleeping"] });
    await flow.runs.cancel({ function: "fn", tag: { agentRun: "r_1" } });
    await flow.runs.cancel({ function: "fn", tag: { agentRun: "r_1" }, cursor: "c_9" });
    await flow.runs.cancel({ function: "fn", tag: { agentRun: "r_1" }, cursor: "" });
    expect(calls.map((c) => [c.method, c.url])).toEqual(Array(6).fill(["POST", `${BASE}/v1/runs/cancel`]));
    expect(calls.map((c) => c.body)).toEqual([
      { appId: "shop", runId: "run_1" },
      { appId: "shop", function: "fn", singletonKey: "hitl-expiry:call_1" },
      { appId: "shop", function: "fn", tag: { agentRun: "r_1" }, status: ["queued", "sleeping"] },
      { appId: "shop", function: "fn", tag: { agentRun: "r_1" } },
      { appId: "shop", function: "fn", tag: { agentRun: "r_1" }, cursor: "c_9" },
      { appId: "shop", function: "fn", tag: { agentRun: "r_1" } },
    ]);
  });

  it("cancel by tag goes on page by page with next", async () => {
    const pages = [
      { cancelled: ["run_1"], notActive: [], more: true, next: "c_1" },
      { cancelled: ["run_2"], notActive: [], more: false, next: null },
    ];
    let i = 0;
    const { flow, calls } = client(() => Response.json(pages[i++]));
    let cursor: string | undefined;
    const cancelled: string[] = [];
    for (;;) {
      const page = await flow.runs.cancel({ function: "fn", tag: { a: "b" }, ...(cursor ? { cursor } : {}) });
      cancelled.push(...page.cancelled);
      if (!page.more || !page.next) break;
      cursor = page.next;
    }
    expect(cancelled).toEqual(["run_1", "run_2"]);
    expect(calls.map((c) => (c.body as { cursor?: string }).cursor)).toEqual([undefined, "c_1"]);
  });

  it("cancel refuses an empty status list before any call", async () => {
    const { flow, calls } = client(() => Response.json({ cancelled: [], notActive: [], more: false }));
    await expect(flow.runs.cancel({ function: "fn", tag: { a: "b" }, status: [] })).rejects.toThrow(
      "status must name at least one status, or be left out",
    );
    expect(calls).toHaveLength(0);
  });

  it("cancel throws with the engine's error", async () => {
    const { flow } = client(() => Response.json({ error: "give one of runId, singletonKey, tag", status: 400 }, { status: 400 }));
    await expect(flow.runs.cancel({ runId: "" })).rejects.toThrow("runs cancel failed (400)");
  });
});

describe("tags", () => {
  it("go to the manifest as given", () => {
    const flow = new Flow({ id: "shop" });
    const fn = flow.createFunction({ id: "fn", tags: { agentRun: "event.data.job.runId" } }, { event: "a/b" }, () => null);
    expect(buildManifest("shop", "https://app", [fn]).functions[0]).toEqual({
      id: "fn",
      triggers: [{ event: "a/b" }],
      tags: { agentRun: "event.data.job.runId" },
    });
  });

  it("are checked at createFunction", () => {
    const flow = new Flow({ id: "shop" });
    const make = (tags: Record<string, string>) => () => flow.createFunction({ id: "fn", tags }, { event: "a/b" }, () => null);
    expect(make({ a: "event.data.a", b: "1", c: "2", d: "3" })).toThrow("has 4 tags (at most 3)");
    expect(make({ "1a": "event.data.a" })).toThrow('invalid tag name "1a"');
    expect(make({ a_b: "x", ["a".repeat(33)]: "y" })).toThrow("invalid tag name");
    expect(make({ "a-b": "x" })).toThrow("invalid tag name");
    expect(make({ a: "" })).toThrow("tag a needs an expression");
    expect(make({ A9_z: "event.data.a", ["b".repeat(32)]: "event.id" })).not.toThrow();
  });
});

describe("onFailure attempts", () => {
  function failureCtx(data: Record<string, unknown>): HandlerContext {
    const event: FlowEvent = { id: "evt_f", name: "inngest/function.failed", data, ts: 1 };
    return { event, events: [event], step: {} as HandlerContext["step"], runId: "run_f", attempt: 0 };
  }

  it("come from the failure event, and are 0 when it has none", async () => {
    const seen: Array<Pick<FailureContext, "attempts" | "error">> = [];
    const flow = new Flow({ id: "shop" });
    const fn = flow.createFunction(
      { id: "fn", onFailure: ({ attempts, error }) => seen.push({ attempts, error }) },
      { event: "a/b" },
      () => null,
    );
    const error = { name: "Error", message: "boom" };
    await fn.failure!.handler(failureCtx({ function_id: "shop-fn", error, attempts: 4 }));
    await fn.failure!.handler(failureCtx({ function_id: "shop-fn", error }));
    expect(seen).toEqual([
      { attempts: 4, error },
      { attempts: 0, error },
    ]);
  });
});
