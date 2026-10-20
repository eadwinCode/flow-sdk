import { signingKeyBearer, type IncomingEvent, type Json } from "@clevix/protocol";
import type { RealtimeToken } from "./realtime.ts";
import type { FlowFunction, FunctionOptions, Handler, Trigger } from "./types.ts";

// The Flow client: app settings, createFunction and send.

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const FAILURE_SUFFIX = "-failure";
export const FAILURE_EVENT = "inngest/function.failed";
/** The engine's URL when neither `baseUrl` nor FLOW_BASE_URL is set. Self-hosters set FLOW_BASE_URL. */
export const DEFAULT_BASE_URL = "https://worker.clevixstudio.com";

export interface FlowOptions {
  /** The app's ID. */
  id: string;
  signingKey?: string;
  signingKeyFallback?: string;
  eventKey?: string;
  /** Engine URL. Default: FLOW_BASE_URL, else "https://worker.clevixstudio.com". */
  baseUrl?: string;
  /**
   * This endpoint's public URL, for example "https://billing.example.com/api/flow".
   * Used only as the `url` in the manifest (the GET answer and the PUT sync). Set it
   * when a proxy in front of the app changes the host or path. Default:
   * FLOW_SERVE_URL, else the URL the request shows.
   */
  serveUrl?: string;
  /** Turns off signature checks. For local development only. */
  isDev?: boolean;
  fetch?: typeof fetch;
}

/** Options merged with env vars. Options passed in code win. */
export interface FlowSettings {
  appId: string;
  signingKey?: string;
  signingKeyFallback?: string;
  eventKey?: string;
  baseUrl: string;
  serveUrl?: string;
  isDev: boolean;
  fetch: typeof fetch;
}

/** Env vars as Workers give them (the handler's `env`) or as `process.env` holds them. */
export type FlowEnv = Record<string, unknown>;

function processEnv(): FlowEnv {
  const proc = (globalThis as { process?: { env?: FlowEnv } }).process;
  return proc?.env ?? {};
}

export class Flow {
  readonly id: string;
  readonly options: FlowOptions;

  constructor(options: FlowOptions) {
    if (!ID_RE.test(options.id)) {
      throw new Error(`invalid app id "${options.id}": use letters, digits, - and _ (up to 64)`);
    }
    this.id = options.id;
    this.options = options;
  }

  /** Reads settings from the options, then `env` (Workers), then `process.env`. */
  settings(env?: FlowEnv): FlowSettings {
    const read = (name: string): string | undefined => {
      for (const source of [env ?? {}, processEnv()]) {
        const value = source[name];
        if (typeof value === "string" && value.length > 0) return value;
      }
      return undefined;
    };
    const o = this.options;
    return {
      appId: this.id,
      signingKey: o.signingKey ?? read("FLOW_SIGNING_KEY"),
      signingKeyFallback: o.signingKeyFallback ?? read("FLOW_SIGNING_KEY_FALLBACK"),
      eventKey: o.eventKey ?? read("FLOW_EVENT_KEY"),
      // An empty option counts as not set, like an empty env var (same as the Go SDK).
      baseUrl: o.baseUrl || read("FLOW_BASE_URL") || DEFAULT_BASE_URL,
      serveUrl: o.serveUrl || read("FLOW_SERVE_URL") || undefined,
      isDev: o.isDev ?? read("FLOW_DEV") === "1",
      // Wrapped: on Workers, calling a detached `fetch` throws "Illegal invocation".
      fetch: o.fetch ?? ((input, init) => fetch(input, init)),
    };
  }

  /**
   * Live messages from functions to browsers. A message goes to the browsers
   * connected right now; nothing is stored. A publish is a plain call, not a step,
   * so a retried step publishes again: treat messages as hints.
   */
  get realtime(): FlowRealtime {
    return {
      publish: async ({ channel, topic, data }, options = {}) => {
        const res = await this.postSigned("/v1/realtime/publish", { appId: this.id, channel, topic, data }, options.env);
        if (!res.ok) throw new Error(`realtime publish failed (${res.status}): ${res.error}`);
      },
      token: async ({ channel, topics }, options = {}) => {
        if (topics.length === 0) throw new Error("realtime token needs at least one topic");
        const res = await this.postSigned("/v1/realtime/token", { appId: this.id, channel, topics }, options.env);
        if (!res.ok) throw new Error(`realtime token failed (${res.status}): ${res.error}`);
        return res.body as RealtimeToken;
      },
    };
  }

  /** POSTs JSON with the signing key as bearer; on a 401 it tries the fallback key. */
  private async postSigned(
    path: string,
    payload: unknown,
    env?: FlowEnv,
  ): Promise<{ ok: boolean; status: number; body: unknown; error: string }> {
    const s = this.settings(env);
    const keys = [s.signingKey, s.signingKeyFallback].filter((k): k is string => !!k);
    if (keys.length === 0) keys.push(""); // dev: no key; the engine answers 401
    const body = JSON.stringify(payload);
    let last = { ok: false, status: 0, body: null as unknown, error: "" };
    for (const [i, key] of keys.entries()) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (key) headers.Authorization = `Bearer ${await signingKeyBearer(key)}`;
      const response = await s.fetch(`${trimSlash(s.baseUrl)}${path}`, { method: "POST", headers, body });
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        // not JSON
      }
      const error = parsed && typeof parsed === "object" && "error" in parsed ? String(parsed.error) : text;
      last = { ok: response.ok, status: response.status, body: parsed, error };
      if (response.status !== 401 || i === keys.length - 1) break;
    }
    return last;
  }

  /** Defines a function. Pass the result to `serve`. */
  createFunction(options: FunctionOptions, trigger: Trigger | Trigger[], handler: Handler): FlowFunction {
    if (!ID_RE.test(options.id)) {
      throw new Error(`invalid function id "${options.id}": use letters, digits, - and _ (up to 64)`);
    }
    const triggers = Array.isArray(trigger) ? trigger : [trigger];
    if (triggers.length === 0) throw new Error(`function ${options.id} needs at least one trigger`);
    for (const t of triggers) {
      const ok = t && (("event" in t && typeof t.event === "string" && t.event) || ("cron" in t && typeof t.cron === "string" && t.cron));
      if (!ok) throw new Error(`function ${options.id} has an invalid trigger`);
    }

    let failure: FlowFunction | undefined;
    if (options.onFailure) {
      const failureId = `${options.id}${FAILURE_SUFFIX}`;
      if (!ID_RE.test(failureId)) {
        throw new Error(`function id "${options.id}" is too long for onFailure (${failureId} must be up to 64 chars)`);
      }
      const onFailure = options.onFailure;
      failure = {
        id: failureId,
        appId: this.id,
        options: { id: failureId },
        triggers: [{ event: FAILURE_EVENT, if: `event.data.function_id == '${this.id}-${options.id}'` }],
        handler: (ctx) => onFailure({ ...ctx, error: ctx.event.data?.error }),
      };
    }

    return {
      id: options.id,
      appId: this.id,
      options,
      triggers,
      handler,
      ...(failure ? { failure } : {}),
    };
  }

  /**
   * Sends one event or a list (up to 100) to the engine. Needs the event key and the
   * engine URL. On Workers, pass the handler's `env` if they live there.
   */
  async send(
    events: IncomingEvent | IncomingEvent[],
    options: { env?: FlowEnv } = {},
  ): Promise<{ ids: string[]; status: number }> {
    const s = this.settings(options.env);
    if (!s.eventKey) throw new Error("flow.send needs an event key (eventKey or FLOW_EVENT_KEY)");
    const response = await s.fetch(`${trimSlash(s.baseUrl)}/e`, {
      method: "POST",
      headers: { Authorization: `Bearer ${s.eventKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(events),
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON; reported below
    }
    if (!response.ok) {
      const reason = body && typeof body === "object" && "error" in body ? String(body.error) : text;
      throw new Error(`sending events failed (${response.status}): ${reason}`);
    }
    return body as { ids: string[]; status: number };
  }
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** `flow.realtime`. On Workers, pass the handler's `env` if the keys live there. */
export interface FlowRealtime {
  /** Sends `data` (any JSON value, up to about 64 KB) to the browsers on `topic` of `channel`. */
  publish(message: { channel: string; topic: string; data: Json }, options?: { env?: FlowEnv }): Promise<void>;
  /**
   * A token that lets one browser connect to `channel` and read `topics` (1 to 10).
   * Call it in your own route, after you checked that the user may see that channel,
   * and send the result to the browser as JSON.
   */
  token(request: { channel: string; topics: string[] }, options?: { env?: FlowEnv }): Promise<RealtimeToken>;
}
