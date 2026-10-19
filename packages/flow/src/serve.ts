import {
  HEADERS,
  parseSigningKey,
  signingKeyBearer,
  STATUS,
  verifySignature,
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

export interface ServeOptions {
  client: Flow;
  functions: FlowFunction[];
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
        return handleRun(request, settings, byId);
      case "GET": {
        if (!(await signed(request, "", settings))) return unauthorized();
        return json(buildManifest(client.id, serveUrl(request, settings), functions));
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

async function signed(request: Request, body: string, s: FlowSettings): Promise<boolean> {
  if (s.isDev) return true;
  return verifySignature({
    header: request.headers.get(HEADERS.signature),
    body,
    keys: [s.signingKey, s.signingKeyFallback],
  });
}

function unauthorized(): Response {
  return errorResponse(401, { name: "Unauthorized", message: "missing or invalid signature" });
}

function serveUrl(request: Request, s: FlowSettings): string {
  if (s.serveUrl) return s.serveUrl;
  const url = new URL(request.url);
  return `${url.origin}${url.pathname}`;
}

async function handleRun(request: Request, s: FlowSettings, byId: Map<string, FlowFunction>): Promise<Response> {
  // Check the raw bytes as received, before parsing.
  const body = await request.text();
  if (!(await signed(request, body, s))) return unauthorized();
  let invoke: InvokeRequest;
  try {
    invoke = JSON.parse(body) as InvokeRequest;
  } catch {
    return errorResponse(400, { name: "BadRequest", message: "body must be JSON" });
  }
  if (!invoke || typeof invoke !== "object" || typeof invoke.fnId !== "string" || !invoke.memo) {
    return errorResponse(400, { name: "BadRequest", message: "body is not an invoke request" });
  }
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
  if (result.type === "done") return json(result.output, STATUS.done);
  if (result.type === "ops") return json(result.ops, STATUS.ops);
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
  if (!s.baseUrl) throw new Error("the run state is too big for the request and the engine URL is not set: set FLOW_BASE_URL");
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
  if (!s.baseUrl) {
    return errorResponse(500, { name: "NoBaseUrl", message: "sync needs the engine URL: set FLOW_BASE_URL" });
  }
  if (!s.signingKey) {
    return errorResponse(500, { name: "NoSigningKey", message: "sync needs a signing key: set FLOW_SIGNING_KEY" });
  }
  const manifest = buildManifest(s.appId, serveUrl(request, s), functions);
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
