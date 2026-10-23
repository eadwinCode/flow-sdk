import {
  DEFAULT_HEARTBEAT_MS,
  HEADERS,
  matchSignature,
  parseSigningKey,
  sha256Hex,
  signAnswer,
  signingKeyBearer,
  STATUS,
  STREAM_ANSWER_HEADERS,
  STREAM_HEARTBEAT,
  streamedAnswerTail,
  type AppManifest,
  type FunctionConfig,
  type FlowEvent,
  type InvokeRequest,
  type MemoEntry,
  type RunStatePage,
  type SerializedError,
  type SyncCheck,
} from "@clevix/protocol";
import { trimSlash, type Flow, type FlowEnv, type FlowSettings } from "./client.ts";
import { execute } from "./execute.ts";
import type { FlowFunction } from "./types.ts";
import { SDK_VERSION } from "./version.ts";

// The app's one endpoint (see docs/sdk-protocol.md, "The one endpoint"):
//   POST  run a function (signed by the engine)
//   PUT   sync: send the manifest to the engine
//   GET   the manifest (signed over the empty body)
// Every answer to a POST or GET that passed the signature check is signed too
// (X-Flow-Answer-Signature), so the engine knows it came from the app.
// When the engine asks (X-Flow-Stream: 1), a POST answer is streamed: headers at once,
// a heartbeat now and then, the answer at the end. A proxy in front of the app then
// does not end a long step (Cloudflare ends a call that sends nothing for 100 s).
// Sync at boot: the app asks the engine for the hash of its last sync and PUTs its
// manifest only when its own hash is different, then checks again now and then
// (see `checkSync`).

export interface ServeOptions {
  client: Flow;
  functions: FlowFunction[];
  /**
   * Streamed answers (default: on, a heartbeat every 20 s). Only used when the engine
   * asks for it. `false` turns it off: answers are sent whole at the end, as before.
   */
  streaming?: boolean | { heartbeatMs?: number };
  /**
   * Sync at boot (default: on). At start (on Workers: on an isolate's first request, in
   * the background), the app checks the engine's copy of its manifest and syncs when it
   * changed, so a deploy needs no Resync. Then it checks again every `checkEveryMs` the
   * engine gives (5 min): a timer on Node, the first request after that time on Workers.
   * `false` turns all of it off. Needs the signing key; without one it does nothing.
   */
  syncOnBoot?: boolean;
}

/** The heartbeat interval, or null when streaming is off. */
function heartbeatMs(streaming: ServeOptions["streaming"]): number | null {
  if (streaming === false) return null;
  const ms = typeof streaming === "object" ? streaming.heartbeatMs : undefined;
  if (ms === undefined) return DEFAULT_HEARTBEAT_MS;
  // setInterval takes at most 2^31 - 1 ms.
  if (!Number.isFinite(ms) || ms < 1 || ms > 2_147_483_647) {
    throw new Error("streaming.heartbeatMs must be a number from 1 to 2147483647");
  }
  return ms;
}

/** The part of the Workers `ctx` the SDK uses: work that may go on after the answer. */
export interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * A standard fetch handler. On Workers, pass the handler's `env` and `ctx` as the
 * second and third arguments (`ctx` lets the sync at boot finish after the answer).
 */
export type FetchHandler = (request: Request, env?: unknown, ctx?: WaitUntil) => Promise<Response>;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body ?? null), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function errorResponse(status: number, error: SerializedError, headers: Record<string, string> = {}): Response {
  return json(error, status, headers);
}

/** The manifest entry for one function: ID, triggers and config, as given. */
export function functionConfig(fn: FlowFunction): FunctionConfig {
  const { onFailure: _onFailure, id: _id, name, ...config } = fn.options;
  return {
    id: fn.id,
    ...(name !== undefined ? { name } : {}),
    triggers: fn.triggers,
    ...config,
  };
}

export function buildManifest(appId: string, url: string, functions: FlowFunction[]): AppManifest {
  return {
    appId,
    url,
    sdk: { language: "typescript", version: SDK_VERSION },
    functions: functions.map(functionConfig),
  };
}

/**
 * The SDK's hash of a manifest: `v1:` and the sha256 of its `sdk` and `functions` as
 * JSON with sorted keys. The URL is left out, so every copy of the app has the same
 * hash. It is the same each time for the same code; the engine only compares it.
 */
export async function manifestHash(manifest: Pick<AppManifest, "sdk" | "functions">): Promise<string> {
  const text = JSON.stringify({ sdk: manifest.sdk, functions: manifest.functions }, (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value,
  );
  return `v1:${await sha256Hex(text)}`;
}

/** What `serveApp` gives the adapters: the handler, and a way to start the sync at boot. */
export interface ServedApp {
  handler: FetchHandler;
  /**
   * Starts the sync at boot, once; later calls do nothing. Runs in the background and
   * never throws. The handler calls it on the first request; a long-running server
   * calls it at start.
   */
  boot(env?: FlowEnv, ctx?: WaitUntil): void;
}

export function serve(options: ServeOptions): FetchHandler {
  return serveApp(options).handler;
}

export function serveApp(options: ServeOptions): ServedApp {
  const { client } = options;
  const heartbeat = heartbeatMs(options.streaming);
  // Each function, plus the `<id>-failure` function made from its onFailure.
  const functions: FlowFunction[] = [];
  for (const fn of options.functions) {
    functions.push(fn);
    if (fn.failure) functions.push(fn.failure);
  }
  const byId = new Map<string, FlowFunction>();
  for (const fn of functions) {
    if (fn.appId !== client.id) throw new Error(`function ${fn.id} belongs to app ${fn.appId}, not ${client.id}`);
    if (byId.has(fn.id)) throw new Error(`two functions have the id ${fn.id}`);
    byId.set(fn.id, fn);
  }
  // The same for the whole life of the handler, so it is made once.
  let hash: Promise<string> | undefined;
  const ownHash = () => (hash ??= manifestHash(buildManifest(client.id, "", functions)));

  let booted = options.syncOnBoot === false;
  // When (Date.now() time) to check again, and its timer. Null while a check runs, or
  // when no check is planned.
  let nextDue: number | null = null;
  let nextTimer: ReturnType<typeof setTimeout> | undefined;

  const check = (env?: FlowEnv, ctx?: WaitUntil): void => {
    const done = (async () => {
      try {
        const { nextInMs } = await checkSync(client.settings(env), functions, await ownHash());
        if (nextInMs === undefined) return;
        nextDue = Date.now() + nextInMs;
        // A long-running server checks again with a timer. On Workers a timer does not
        // outlive the request, so the first request after that time does it.
        if (!ctx) {
          nextTimer = setTimeout(() => checkAgain(env, undefined, true), nextInMs);
          (nextTimer as { unref?: () => void }).unref?.();
        }
      } catch (err) {
        console.warn(`flow: the sync check of app ${client.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    try {
      ctx?.waitUntil(done);
    } catch {
      // Not a real ctx: the check still runs, it just may not finish after the answer.
    }
  };

  /** The next check (heartbeat or retryAt), once, when its time has come (or the timer fired). */
  const checkAgain = (env?: FlowEnv, ctx?: WaitUntil, timerFired = false): void => {
    if (nextDue === null || (!timerFired && Date.now() < nextDue)) return;
    nextDue = null;
    clearTimeout(nextTimer);
    nextTimer = undefined;
    check(env, ctx);
  };

  const boot = (env?: FlowEnv, ctx?: WaitUntil): void => {
    if (booted) return;
    booted = true;
    check(env, ctx);
  };

  const handler: FetchHandler = async (request, env, ctx) => {
    const flowEnv = env && typeof env === "object" ? (env as FlowEnv) : undefined;
    boot(flowEnv, ctx);
    checkAgain(flowEnv, ctx);
    const settings = client.settings(flowEnv);
    const keyProblem = checkKeys(settings);
    if (keyProblem) return errorResponse(500, { name: "NoSigningKey", message: keyProblem });

    switch (request.method) {
      case "POST":
        return handleRun(request, settings, byId, heartbeat);
      case "GET": {
        const signer = await checkRequest(request, "", settings);
        if (!signer) return unauthorized();
        const manifest = { ...buildManifest(client.id, serveUrl(request), functions), manifestHash: await ownHash() };
        return seal(json(manifest), signer);
      }
      case "PUT":
        return handleSync(request, settings, functions, await ownHash());
      default:
        return errorResponse(405, { name: "MethodNotAllowed", message: `${request.method} is not allowed` });
    }
  };
  return { handler, boot };
}

/** Why the app cannot serve, or null. Without a signing key it serves only in dev mode. */
function checkKeys(s: FlowSettings): string | null {
  if (!s.signingKey) {
    return s.isDev ? null : "no signing key: set FLOW_SIGNING_KEY (or FLOW_DEV=1 for local development)";
  }
  for (const key of [s.signingKey, s.signingKeyFallback]) {
    if (!key) continue;
    try {
      parseSigningKey(key);
    } catch {
      return "the signing key is not in the format signkey-<64 hex chars>";
    }
  }
  return null;
}

/** How to sign the answers to one request: the key that matched and the request's signature. */
interface Signer {
  /** Null: do not sign (dev mode, and the request was not signed with one of the keys). */
  key: string | null;
  request: string;
}

/**
 * Checks the request's signature. Null: refuse it (401). Otherwise, how to sign the
 * answer (see `seal`). Dev mode lets every request in; it signs the answer only when
 * the request was signed with one of its keys.
 */
async function checkRequest(request: Request, body: string, s: FlowSettings): Promise<Signer | null> {
  const header = request.headers.get(HEADERS.signature);
  const key = await matchSignature({ header, body, keys: [s.signingKey, s.signingKeyFallback] });
  if (key === null || header === null) return s.isDev ? { key: null, request: "" } : null;
  return { key, request: header };
}

/** The answer's signature, or null when it is not signed. */
async function answerSignature(signer: Signer, status: number, headers: Headers, body: string): Promise<string | null> {
  if (signer.key === null) return null;
  return signAnswer(signer.key, {
    request: signer.request,
    status,
    noRetry: headers.get(HEADERS.noRetry),
    retryAfter: headers.get(HEADERS.retryAfter),
    body,
  });
}

/** Signs an answer: adds X-Flow-Answer-Signature. */
async function seal(response: Response, signer: Signer): Promise<Response> {
  if (signer.key === null) return response;
  const body = await response.text();
  const headers = new Headers(response.headers);
  const signature = await answerSignature(signer, response.status, headers, body);
  if (signature !== null) headers.set(HEADERS.answerSignature, signature);
  return new Response(body, { status: response.status, headers });
}

/**
 * A streamed answer (see @clevix/protocol stream.ts): 200 at once, a heartbeat now and
 * every `heartbeatMs`, then the meta line and body of the answer `answer` makes. If
 * `answer` throws, the stream breaks off, as a normal answer would be lost.
 */
function streamAnswer(signer: Signer, heartbeatMs: number, answer: () => Promise<Response>): Response {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let open = true;
  const stop = () => {
    open = false;
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const beat = () => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(STREAM_HEARTBEAT));
        } catch {
          stop();
        }
      };
      beat();
      timer = setInterval(beat, heartbeatMs);
      void (async () => {
        try {
          const response = await answer();
          const body = await response.text();
          const tail = streamedAnswerTail({
            status: response.status,
            // An empty header is null, as in the Go SDK.
            noRetry: response.headers.get(HEADERS.noRetry) || null,
            retryAfter: response.headers.get(HEADERS.retryAfter) || null,
            signature: await answerSignature(signer, response.status, response.headers, body),
            body,
          });
          if (!open) return;
          stop();
          controller.enqueue(encoder.encode(tail));
          controller.close();
        } catch (err) {
          if (!open) return;
          stop();
          controller.error(err);
        }
      })();
    },
    cancel() {
      // The engine went away (or the step timeout hit): stop the heartbeats.
      stop();
    },
  });
  return new Response(stream, { status: 200, headers: { ...STREAM_ANSWER_HEADERS } });
}

function unauthorized(): Response {
  return errorResponse(401, { name: "Unauthorized", message: "missing or invalid signature" });
}

/**
 * This endpoint's URL as the request shows it (origin and path), sent in the manifest.
 * An app added by URL in the dashboard does not need it: the engine keeps the URL it
 * was given, and keeps a stored URL when this one is not usable (an app behind a proxy
 * may see itself as http).
 */
function serveUrl(request: Request): string {
  const url = new URL(request.url);
  return `${url.origin}${url.pathname}`;
}

async function handleRun(
  request: Request,
  s: FlowSettings,
  byId: Map<string, FlowFunction>,
  heartbeat: number | null,
): Promise<Response> {
  // Check the raw bytes as received, before parsing.
  const body = await request.text();
  const signer = await checkRequest(request, body, s);
  if (!signer) return unauthorized();
  const invoke = parseInvoke(body);
  // A bad request is answered at once, never streamed.
  if (invoke instanceof Response) return seal(invoke, signer);
  if (heartbeat !== null && request.headers.get(HEADERS.stream) === "1") {
    return streamAnswer(signer, heartbeat, () => run(invoke, s, byId));
  }
  return seal(await run(invoke, s, byId), signer);
}

/** The invoke request in the body, or the 400 answer when it is not one. */
function parseInvoke(body: string): InvokeRequest | Response {
  let invoke: InvokeRequest;
  try {
    invoke = JSON.parse(body) as InvokeRequest;
  } catch {
    return errorResponse(400, { name: "BadRequest", message: "body must be JSON" });
  }
  if (!invoke || typeof invoke !== "object" || typeof invoke.fnId !== "string" || !invoke.memo) {
    return errorResponse(400, { name: "BadRequest", message: "body is not an invoke request" });
  }
  return invoke;
}

async function run(invoke: InvokeRequest, s: FlowSettings, byId: Map<string, FlowFunction>): Promise<Response> {
  const fn = byId.get(invoke.fnId);
  if (!fn) {
    return errorResponse(
      500,
      { name: "FunctionNotFound", message: `no function ${invoke.fnId} in this app` },
      { [HEADERS.noRetry]: "true" },
    );
  }

  if (invoke.useApi === true) {
    // The state was too big for this request: load it from the engine first.
    try {
      const state = await loadState(invoke.runId, s);
      invoke = { ...invoke, memo: state.memo, events: state.events };
    } catch (err) {
      // No no-retry header: the engine calls again.
      return errorResponse(500, { name: "StateLoadFailed", message: err instanceof Error ? err.message : String(err) });
    }
  }

  const result = await execute(fn, invoke);
  try {
    if (result.type === "done") return json(result.output, STATUS.done);
    if (result.type === "ops") return json(result.ops, STATUS.ops);
  } catch (err) {
    // JSON.stringify threw (a BigInt, a loop): answer a 500 the engine can read, as Go does.
    return errorResponse(500, { name: "SerializationError", message: err instanceof Error ? err.message : String(err) });
  }
  const headers: Record<string, string> = {};
  if (result.noRetry) headers[HEADERS.noRetry] = "true";
  if (result.retryAt !== undefined) {
    headers[HEADERS.retryAfter] = String(Math.max(0, Math.ceil((result.retryAt - Date.now()) / 1000)));
  }
  return errorResponse(500, result.error, headers);
}

/** Stops a bad cursor from looping forever. A 32 MiB state is about 8 pages. */
const MAX_STATE_PAGES = 1000;

/**
 * Loads a run's whole state from the engine (`GET /runs/:runId/state`), page by page.
 * Throws on any failure, so the function never runs with part of its memo.
 */
async function loadState(runId: string, s: FlowSettings): Promise<{ memo: Record<string, MemoEntry>; events: FlowEvent[] }> {
  if (typeof runId !== "string" || runId.length === 0) throw new Error("the invoke request has no runId");
  const headers: Record<string, string> = {};
  // The engine's state API always needs the key, also in dev mode (same as the Go SDK).
  if (!s.signingKey) throw new Error("loading the run state needs a signing key: set FLOW_SIGNING_KEY");
  headers.Authorization = `Bearer ${await signingKeyBearer(s.signingKey)}`;

  const base = `${trimSlash(s.baseUrl)}/runs/${encodeURIComponent(runId)}/state`;
  const memo: Record<string, MemoEntry> = {};
  let events: FlowEvent[] | undefined;
  let cursor: string | null = null;
  for (let page = 0; ; page++) {
    if (page >= MAX_STATE_PAGES) throw new Error(`the run state has more than ${MAX_STATE_PAGES} pages`);
    const url: string = cursor === null ? base : `${base}?cursor=${encodeURIComponent(cursor)}`;
    const response = await s.fetch(url, { method: "GET", headers });
    const text = await response.text();
    if (response.status !== 200) {
      throw new Error(`loading the run state failed (${response.status}): ${text.slice(0, 500)}`);
    }
    let body: RunStatePage;
    try {
      body = JSON.parse(text) as RunStatePage;
    } catch {
      throw new Error("the run state page is not JSON");
    }
    if (!body || typeof body !== "object" || !body.memo || typeof body.memo !== "object" || Array.isArray(body.memo)) {
      throw new Error("the run state page has no memo");
    }
    if (body.next !== null && typeof body.next !== "string") {
      throw new Error("the run state page has a bad next cursor");
    }
    if (page === 0) {
      if (body.events !== undefined && !Array.isArray(body.events)) throw new Error("the run state page has bad events");
      events = body.events ?? [];
    }
    Object.assign(memo, body.memo);
    if (body.next === null) break;
    cursor = body.next;
  }
  return { memo, events: events ?? [] };
}

async function handleSync(request: Request, s: FlowSettings, functions: FlowFunction[], hash: string): Promise<Response> {
  if (!s.signingKey) {
    return errorResponse(500, { name: "NoSigningKey", message: "sync needs a signing key: set FLOW_SIGNING_KEY" });
  }
  const manifest = { ...buildManifest(s.appId, serveUrl(request), functions), manifestHash: hash };
  let response: Response;
  try {
    response = await putManifest(s, s.signingKey, manifest);
  } catch (err) {
    return errorResponse(502, { name: "SyncFailed", message: err instanceof Error ? err.message : String(err) });
  }
  // Hand back the engine's answer as it came.
  return new Response(await response.text(), {
    status: response.status,
    headers: { "Content-Type": response.headers.get("Content-Type") ?? "application/json" },
  });
}

function syncUrl(s: FlowSettings): string {
  return `${trimSlash(s.baseUrl)}/apps/${encodeURIComponent(s.appId)}/sync`;
}

async function putManifest(s: FlowSettings, signingKey: string, manifest: unknown): Promise<Response> {
  return s.fetch(syncUrl(s), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${await signingKeyBearer(signingKey)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(manifest),
  });
}

/** What a sync check did. "waiting": the engine's rolling-deploy guard is on, no PUT. */
export type SyncCheckResult = "no-key" | "in-sync" | "synced" | "waiting" | "replaced" | "failed";

export interface SyncCheckDone {
  result: SyncCheckResult;
  /** Check again in this many ms (the heartbeat, or the guard's `retryAt`). None: stop. */
  nextInMs?: number;
}

/** The least time between two checks, so a wrong clock or answer can not make a tight loop. */
const MIN_RETRY_MS = 5_000;
/** Checked a little after `retryAt`, so the engine's guard has surely ended. */
const RETRY_SLACK_MS = 1_000;
/** The heartbeat after a failed check, when the engine did not say (`checkEveryMs`). */
const DEFAULT_CHECK_EVERY_MS = 5 * 60_000;
/** setTimeout takes at most 2^31 - 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * How long to wait for a `retryAt` (ms since epoch, the engine's clock). Measured from
 * the engine's `Date` header when it has one, so the app's clock does not matter.
 */
export function retryDelay(retryAt: unknown, date: string | null, now = Date.now()): number | undefined {
  if (typeof retryAt !== "number" || !Number.isFinite(retryAt)) return undefined;
  const engineNow = date ? Date.parse(date) : NaN;
  const wait = retryAt - (Number.isNaN(engineNow) ? now : engineNow) + RETRY_SLACK_MS;
  return Math.min(Math.max(wait, MIN_RETRY_MS), MAX_TIMER_MS);
}

/** The engine's `checkEveryMs`, or undefined when it did not send a usable one. */
function heartbeatDelay(checkEveryMs: unknown): number | undefined {
  if (typeof checkEveryMs !== "number" || !Number.isFinite(checkEveryMs) || checkEveryMs <= 0) return undefined;
  return Math.min(Math.max(checkEveryMs, MIN_RETRY_MS), MAX_TIMER_MS);
}

/**
 * One sync check: `GET /apps/:id/sync?hash=`, and a PUT of the manifest only when the
 * engine's hash is not `hash` (null counts as different) and its guard is off
 * (`retryAt` null). The PUT has no URL: there is no request to take it from, and the
 * engine keeps the URL it has. It runs at boot, then every `checkEveryMs` (so a canary
 * that ends on the old version still syncs), or at `retryAt` while the guard is on.
 * Logs what went wrong, never throws.
 */
export async function checkSync(s: FlowSettings, functions: FlowFunction[], hash: string): Promise<SyncCheckDone> {
  // Without a key there is nothing to sign with (dev mode); the engine would say 401.
  if (!s.signingKey) return { result: "no-key" };
  const prefix = `flow: sync check of app ${s.appId}`;
  let heartbeat: number | undefined;
  const failed = (): SyncCheckDone => ({ result: "failed", nextInMs: heartbeat ?? DEFAULT_CHECK_EVERY_MS });
  try {
    const bearer = await signingKeyBearer(s.signingKey);
    // The check sends this copy's hash: the engine then knows copies with it still run,
    // which keeps its rolling-deploy guard on during a gradual deploy.
    const check = await s.fetch(`${syncUrl(s)}?hash=${encodeURIComponent(hash)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${bearer}` },
    });
    const checkText = await check.text();
    if (check.status === 404) {
      // An engine without this route: stop, it will not have it in 5 minutes either.
      console.warn(`${prefix}: the engine has no sync check (404), so this app syncs only on PUT or Resync`);
      return { result: "failed" };
    }
    if (check.status !== 200) {
      console.warn(`${prefix}: the check failed (${check.status}): ${engineError(checkText)}`);
      return failed();
    }
    const parsed = parseJson(checkText);
    if (!parsed) {
      console.warn(`${prefix}: the check answer is not a JSON object`);
      return failed();
    }
    const stored = parsed as Partial<SyncCheck>;
    heartbeat = heartbeatDelay(stored.checkEveryMs);
    const keepChecking = (result: SyncCheckResult): SyncCheckDone =>
      heartbeat === undefined ? { result } : { result, nextInMs: heartbeat };

    if (stored.manifestHash === hash) return keepChecking("in-sync");
    if (stored.retryAt !== undefined && stored.retryAt !== null) {
      // The guard is on (an old copy during a deploy, or a rollback): no PUT until it ends.
      const wait = retryDelay(stored.retryAt, check.headers.get("Date"));
      console.info(
        `${prefix}: the engine has a newer manifest and keeps it for now` +
          (wait === undefined ? "" : `; checking again in ${Math.ceil(wait / 1000)} s`),
      );
      return wait === undefined ? keepChecking("waiting") : { result: "waiting", nextInMs: wait };
    }

    const { url: _url, ...manifest } = buildManifest(s.appId, "", functions);
    const response = await putManifest(s, s.signingKey, { ...manifest, manifestHash: hash });
    const text = await response.text();
    if (response.ok) {
      console.info(`${prefix}: synced (the engine had ${stored.manifestHash ? "an older manifest" : "no manifest hash"})`);
      return keepChecking("synced");
    }
    const body = parseJson(text);
    if (response.status === 409 && body?.code === "ManifestReplaced") {
      // The check's answer was out of date: same as `retryAt` above.
      const wait = retryDelay(body.retryAt, response.headers.get("Date"));
      console.warn(
        `${prefix}: not saved, a newer manifest replaced this one: ${engineError(text)}` +
          (wait === undefined ? "" : ` (checking again in ${Math.ceil(wait / 1000)} s)`),
      );
      return wait === undefined ? keepChecking("replaced") : { result: "replaced", nextInMs: wait };
    }
    const neverSynced = stored.syncedAt === null || stored.syncedAt === undefined;
    console.warn(
      `${prefix}: the sync failed (${response.status}): ${engineError(text)}` +
        (neverSynced
          ? ". The engine may not know this app's URL yet: add the app by URL in the dashboard, or sync once with curl -X PUT <app-url>"
          : ""),
    );
    return failed();
  } catch (err) {
    console.warn(`${prefix}: failed: ${err instanceof Error ? err.message : String(err)}`);
    return failed();
  }
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The engine's `error` text, or the start of the body. */
function engineError(text: string): string {
  const body = parseJson(text);
  return typeof body?.error === "string" ? body.error : text.slice(0, 500);
}
