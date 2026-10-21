import {
  DEFAULT_HEARTBEAT_MS,
  HEADERS,
  matchSignature,
  parseSigningKey,
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

export interface ServeOptions {
  client: Flow;
  functions: FlowFunction[];
  /**
   * Streamed answers (default: on, a heartbeat every 20 s). Only used when the engine
   * asks for it. `false` turns it off: answers are sent whole at the end, as before.
   */
  streaming?: boolean | { heartbeatMs?: number };
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

/** A standard fetch handler. On Workers, pass the handler's `env` as the second argument. */
export type FetchHandler = (request: Request, env?: unknown) => Promise<Response>;

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

export function serve(options: ServeOptions): FetchHandler {
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

  return async (request, env) => {
    const settings = client.settings(env && typeof env === "object" ? (env as FlowEnv) : undefined);
    const keyProblem = checkKeys(settings);
    if (keyProblem) return errorResponse(500, { name: "NoSigningKey", message: keyProblem });

    switch (request.method) {
      case "POST":
        return handleRun(request, settings, byId, heartbeat);
      case "GET": {
        const signer = await checkRequest(request, "", settings);
        if (!signer) return unauthorized();
        return seal(json(buildManifest(client.id, serveUrl(request), functions)), signer);
      }
      case "PUT":
        return handleSync(request, settings, functions);
      default:
        return errorResponse(405, { name: "MethodNotAllowed", message: `${request.method} is not allowed` });
    }
  };
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

async function handleSync(request: Request, s: FlowSettings, functions: FlowFunction[]): Promise<Response> {
  if (!s.signingKey) {
    return errorResponse(500, { name: "NoSigningKey", message: "sync needs a signing key: set FLOW_SIGNING_KEY" });
  }
  const manifest = buildManifest(s.appId, serveUrl(request), functions);
  let response: Response;
  try {
    response = await s.fetch(`${trimSlash(s.baseUrl)}/apps/${encodeURIComponent(s.appId)}/sync`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${await signingKeyBearer(s.signingKey)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(manifest),
    });
  } catch (err) {
    return errorResponse(502, { name: "SyncFailed", message: err instanceof Error ? err.message : String(err) });
  }
  // Hand back the engine's answer as it came.
  return new Response(await response.text(), {
    status: response.status,
    headers: { "Content-Type": response.headers.get("Content-Type") ?? "application/json" },
  });
}
