import { parseDuration, signingKeyBearer, type IncomingEvent, type Json } from "@clevix/protocol";
import { StreamClosedError, StreamGoneError } from "./errors.ts";
import type { RealtimeMessage, RealtimeState, RealtimeToken, StreamItem, StreamToken } from "./realtime.ts";
import { baseSocketUrl, checkAfter, readStreamWith, subscribeWith } from "./socket.ts";
import type {
  ActiveRunStatus,
  CancelResult,
  Duration,
  FlowFunction,
  FunctionOptions,
  Handler,
  PauseResult,
  RetryResult,
  RunCounts,
  RunDetail,
  RunPage,
  RunStatus,
  SingletonRun,
  StartResult,
  StreamSnapshot,
  Trigger,
} from "./types.ts";

// The Flow client: app settings, createFunction, send and start, and the engine's
// realtime, runs and streams APIs.

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const TAG_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const MAX_TAGS = 3;
const STREAM_ID_RE = /^[A-Za-z0-9:_.-]{1,256}$/;
const RESERVED_STREAM_IDS = new Set([".", "..", "token", "connect"]);
const MAX_PUBLISH_MANY = 100;
const MAX_CHANNELS = 100;
const MAX_CHANNEL_CHARS = 8_000;
const FAILURE_SUFFIX = "-failure";
export const FAILURE_EVENT = "inngest/function.failed";
/** The engine's URL when neither `baseUrl` nor FLOW_BASE_URL is set. Self-hosters set FLOW_BASE_URL. */
export const DEFAULT_BASE_URL = "https://worker.flow.clevixstudio.com";

export interface FlowOptions {
  /** The app's ID. */
  id: string;
  signingKey?: string;
  signingKeyFallback?: string;
  eventKey?: string;
  /** Engine URL. Default: FLOW_BASE_URL, else "https://worker.flow.clevixstudio.com". */
  baseUrl?: string;
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
    const token: FlowRealtime["token"] = async (request, options = {}) => {
      checkChannels("realtime token", request);
      if (request.topics.length === 0) throw new Error("realtime token needs at least one topic");
      const res = await this.callSigned("POST", "/v1/realtime/token", { appId: this.id, ...request }, options.env);
      if (!res.ok) throw failed("realtime token", res);
      return res.body as RealtimeToken;
    };
    return {
      publish: async ({ channel, topic, data }, options = {}) => {
        const res = await this.callSigned("POST", "/v1/realtime/publish", { appId: this.id, channel, topic, data }, options.env);
        if (!res.ok) throw failed("realtime publish", res);
      },
      publishMany: async (messages, options = {}) => {
        if (messages.length === 0 || messages.length > MAX_PUBLISH_MANY) {
          throw new Error(`realtime publishMany takes 1 to ${MAX_PUBLISH_MANY} messages, not ${messages.length}`);
        }
        const list = messages.map(({ channel, topic, data }) => ({ channel, topic, data }));
        const res = await this.callSigned("POST", "/v1/realtime/publish", { appId: this.id, messages: list }, options.env);
        if (!res.ok) throw failed("realtime publishMany", res);
      },
      token,
      subscribe: (options) => {
        const { topics, env } = options;
        checkChannels("realtime subscribe", options);
        const channels: string[] | undefined = "channels" in options ? options.channels : undefined;
        const channel = "channel" in options ? options.channel : "";
        const request = channels ? { channels, topics } : { channel, topics };
        if (topics.length === 0) throw new Error("realtime subscribe needs at least one topic");
        return subscribeWith(
          {
            refreshToken: () => token(request, { env }),
            onMessage: options.onMessage,
            ...(options.onState ? { onState: options.onState } : {}),
            ...(options.WebSocket ? { WebSocket: options.WebSocket } : {}),
          },
          baseSocketUrl(this.settings(env).baseUrl),
        );
      },
    };
  }

  /**
   * Starts a run of one function now, without an event, and says if it did not start
   * (a singleton run holds the key, the function is paused, or there is no such
   * function). Singleton, throttle, concurrency and priority apply; rate limit,
   * debounce and batching do not. Pass the same `id` again to retry safely: it lands on
   * the same run. With `whenPaused: "hold"`, a paused function takes the run anyway:
   * it waits, paused, and starts when the function is resumed. Throws when the engine
   * answers with an error.
   */
  async start(
    fn: string | FlowFunction,
    options: { data?: Json; id?: string; user?: Json; whenPaused?: "refuse" | "hold"; env?: FlowEnv } = {},
  ): Promise<StartResult> {
    const { data, id, user, whenPaused, env } = options;
    const path = `/v1/functions/${encodeURIComponent(this.functionIdOf(fn))}/start`;
    const res = await this.callSigned("POST", path, { appId: this.id, data, id: id || undefined, user, whenPaused }, env);
    if (!res.ok) throw failed("start", res);
    return res.body as StartResult;
  }

  /** Pauses and resumes the app's functions, as the dashboard does. */
  get functions(): FlowFunctions {
    const call = async (fn: string | FlowFunction, action: "pause" | "resume", env?: FlowEnv) => {
      if (!this.functionIdOf(fn)) throw new Error(`function ${action} needs a function id`);
      const path = `/v1/functions/${encodeURIComponent(this.functionIdOf(fn))}/${action}`;
      // The engine stops after a while on a function with many runs, with `more`: the
      // same call goes on, so it is made until there is no more.
      let runs = 0;
      for (;;) {
        const res = await this.callSigned("POST", path, { appId: this.id }, env);
        if (!res.ok) throw failed(`function ${action}`, res);
        const page = res.body as PauseResult & { more?: boolean };
        runs += page.runs;
        if (!page.more) return { paused: page.paused, runs };
      }
    };
    return {
      pause: (fn, options = {}) => call(fn, "pause", options.env),
      resume: (fn, options = {}) => call(fn, "resume", options.env),
    };
  }

  /**
   * Finds, counts, cancels and retries the app's runs. `list` and `counts` read an
   * index that lags the runs by a few seconds; the rest do not.
   */
  get runs(): FlowRuns {
    return {
      list: async (options = {}) => {
        const params: Record<string, string | undefined> = {
          // An empty value means no filter, so it is left out.
          function: options.function ? this.functionIdOf(options.function) : undefined,
          status: options.status?.length ? options.status.join(",") : undefined,
          limit: options.limit === undefined ? undefined : String(options.limit),
          before: options.before || undefined,
          order: options.order,
        };
        for (const [name, value] of Object.entries(options.tags ?? {})) params[`tag.${name}`] = value;
        const res = await this.callSigned("GET", this.withQuery("/v1/runs", params), undefined, options.env);
        if (!res.ok) throw failed("runs list", res);
        return res.body as RunPage;
      },
      counts: async (options) => {
        const path = this.withQuery("/v1/runs/counts", { function: this.functionIdOf(options.function) });
        const res = await this.callSigned("GET", path, undefined, options.env);
        if (!res.ok) throw failed("runs counts", res);
        return res.body as RunCounts;
      },
      singleton: async (fn, key, options = {}) => {
        // A string key goes as it is; any other value as JSON text.
        const params = typeof key === "string" ? { key } : { keyJson: JSON.stringify(key) };
        const path = this.withQuery(`/v1/functions/${encodeURIComponent(this.functionIdOf(fn))}/singleton`, params);
        const res = await this.callSigned("GET", path, undefined, options.env);
        if (!res.ok) throw failed("runs singleton", res);
        return res.body as SingletonRun;
      },
      cancel: async (request, options = {}) => {
        const body: Record<string, unknown> = { appId: this.id };
        if ("runId" in request) {
          body.runId = request.runId;
        } else if ("tag" in request) {
          if (request.status?.length === 0) throw new Error("status must name at least one status, or be left out");
          Object.assign(body, {
            function: this.functionIdOf(request.function),
            tag: request.tag,
            status: request.status,
            cursor: request.cursor || undefined,
          });
        } else {
          Object.assign(body, { function: this.functionIdOf(request.function), singletonKey: request.singletonKey });
        }
        const res = await this.callSigned("POST", "/v1/runs/cancel", body, options.env);
        if (!res.ok) throw failed("runs cancel", res);
        return res.body as CancelResult;
      },
      get: async (runId, options = {}) => {
        if (!runId) throw new Error("runs get needs a run id");
        const path = this.withQuery(`/v1/runs/${encodeURIComponent(runId)}`, {});
        const res = await this.callSigned("GET", path, undefined, options.env);
        if (res.status === 404) return null;
        if (!res.ok) throw failed("runs get", res);
        return res.body as RunDetail;
      },
      retry: async (runId, options = {}) => {
        if (!runId) throw new Error("runs retry needs a run id");
        const res = await this.callSigned("POST", `/v1/runs/${encodeURIComponent(runId)}/retry`, { appId: this.id }, options.env);
        if (res.status === 404) return { retried: false };
        if (!res.ok) throw failed("runs retry", res);
        return res.body as RetryResult;
      },
      delete: async (runId, options = {}) => {
        if (!runId) throw new Error("runs delete needs a run id");
        const res = await this.callSigned("POST", `/v1/runs/${encodeURIComponent(runId)}/delete`, { appId: this.id }, options.env);
        if (res.status === 404) return { deleted: false };
        if (!res.ok) throw failed("runs delete", res);
        return res.body as { deleted: boolean; reason?: "kept" };
      },
    };
  }

  /**
   * Streams: lists of items kept for a while, that a reader can read from any offset
   * and then follow live. One writer per stream. See docs/streams.md.
   */
  get streams(): FlowStreams {
    const path = (id: string, rest = "") => {
      // These match the pattern, but a URL would read "." and ".." as path steps, and
      // "token" and "connect" are routes under /v1/streams/.
      if (!STREAM_ID_RE.test(id) || RESERVED_STREAM_IDS.has(id)) {
        throw new Error(`invalid stream id "${id}": use letters, digits and :_.- (up to 256), not ., .., token or connect`);
      }
      return `/v1/streams/${encodeURIComponent(id)}${rest}`;
    };
    const token = async (id: string, options: { env?: FlowEnv } = {}) => {
      path(id);
      const res = await this.callSigned("POST", "/v1/streams/token", { appId: this.id, stream: id }, options.env);
      if (!res.ok) throw streamFailed("stream token", id, res);
      return res.body as StreamToken;
    };
    return {
      open: async (id, options) => {
        const body = { appId: this.id, meta: options.meta, ttlMs: parseDuration(options.ttl) };
        const res = await this.callSigned("POST", path(id, "/open"), body, options.env);
        if (!res.ok) throw streamFailed("stream open", id, res);
        return { created: (res.body as { created: boolean }).created };
      },
      append: async (id, items, options = {}) => {
        const res = await this.callSigned("POST", path(id, "/append"), { appId: this.id, items }, options.env);
        if (!res.ok) throw streamFailed("stream append", id, res);
        return (res.body as { offsets: string[] }).offsets;
      },
      snapshot: async <T>(id: string, options: { after?: string; env?: FlowEnv } = {}) => {
        const items: StreamItem<T>[] = [];
        let after = options.after ?? "";
        // Each page has up to 1000 items; read on from the last offset while there are more.
        for (;;) {
          const res = await this.callSigned("GET", this.withQuery(path(id), { after: after || undefined }), undefined, options.env);
          if (!res.ok) {
            if (res.code === "StreamGone") return null;
            throw streamFailed("stream snapshot", id, res);
          }
          const page = res.body as { meta: Json; items: StreamItem<T>[]; ended: boolean; more: boolean };
          items.push(...page.items);
          const last = page.items[page.items.length - 1];
          if (!page.more || !last) return { meta: page.meta, items, ended: page.ended };
          after = last.offset;
        }
      },
      close: async (id, options) => {
        const body = { appId: this.id, end: options.end, graceMs: parseDuration(options.grace) };
        const res = await this.callSigned("POST", path(id, "/close"), body, options.env);
        if (!res.ok) throw streamFailed("stream close", id, res);
        return { closed: (res.body as { closed: boolean }).closed };
      },
      delete: async (id, options = {}) => {
        const res = await this.callSigned("DELETE", this.withQuery(path(id), {}), undefined, options.env);
        if (!res.ok) throw streamFailed("stream delete", id, res);
        return { deleted: (res.body as { deleted: boolean }).deleted };
      },
      token,
      read: (id, options = {}) => {
        path(id);
        checkAfter(options.after);
        return this.readItems(id, () => token(id, { env: options.env }), options);
      },
    };
  }

  /** `flow.streams.read`: the socket reader as an async iterable. */
  private async *readItems<T>(
    id: string,
    refreshToken: () => Promise<StreamToken>,
    options: { after?: string; signal?: AbortSignal; WebSocket?: typeof WebSocket; env?: FlowEnv },
  ): AsyncGenerator<StreamItem<T>> {
    const { signal } = options;
    if (signal?.aborted) return;
    const queue: StreamItem<T>[] = [];
    let ended = false;
    let failure: Error | undefined;
    let wake: (() => void) | undefined;
    const poke = () => wake?.();
    const stop = readStreamWith<T>(
      {
        refreshToken,
        ...(options.after ? { after: options.after } : {}),
        onItem: (item) => {
          queue.push(item);
          poke();
        },
        onEnd: () => {
          ended = true;
          poke();
        },
        onGone: (error) => {
          failure = error;
          poke();
        },
        // A bad key, a refused workspace, a bad app ID: stop, and throw it.
        stopOn: lasting,
        onFail: (error) => {
          failure = error;
          poke();
        },
        ...(options.WebSocket ? { WebSocket: options.WebSocket } : {}),
      },
      baseSocketUrl(this.settings(options.env).baseUrl),
    );
    signal?.addEventListener("abort", poke);
    try {
      for (;;) {
        if (signal?.aborted) return;
        const item = queue.shift();
        if (item) {
          yield item;
          continue;
        }
        if (failure) throw failure;
        if (ended) return;
        await new Promise<void>((resolve) => (wake = resolve));
        wake = undefined;
      }
    } finally {
      signal?.removeEventListener("abort", poke);
      stop();
    }
  }

  /** The function's own ID. A function made by another app's client is refused. */
  private functionIdOf(fn: string | FlowFunction): string {
    if (typeof fn === "string") return fn;
    if (fn.appId !== this.id) throw new Error(`function ${fn.id} belongs to app ${fn.appId}, not ${this.id}`);
    return fn.id;
  }

  /** `path?name=value&...` with the app's ID, for a GET or DELETE (an old shared key reads it there). */
  private withQuery(path: string, params: Record<string, string | undefined>): string {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) if (value !== undefined) query.set(name, value);
    query.set("appId", this.id);
    return `${path}?${query}`;
  }

  /** Calls the engine with the signing key as bearer; on a 401 it tries the fallback key. */
  private async callSigned(method: "GET" | "POST" | "DELETE", path: string, payload: unknown, env?: FlowEnv): Promise<EngineAnswer> {
    const s = this.settings(env);
    const keys = [s.signingKey, s.signingKeyFallback].filter((k): k is string => !!k);
    if (keys.length === 0) keys.push(""); // dev: no key; the engine answers 401
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    let last: EngineAnswer = { ok: false, status: 0, body: null, error: "" };
    for (const [i, key] of keys.entries()) {
      const headers: Record<string, string> = body === undefined ? {} : { "Content-Type": "application/json" };
      if (key) headers.Authorization = `Bearer ${await signingKeyBearer(key)}`;
      const response = await s.fetch(`${trimSlash(s.baseUrl)}${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        // not JSON
      }
      const error = parsed && typeof parsed === "object" && "error" in parsed ? String(parsed.error) : text;
      const code = parsed && typeof parsed === "object" && "code" in parsed ? String(parsed.code) : undefined;
      last = { ok: response.ok, status: response.status, body: parsed, error, ...(code ? { code } : {}) };
      if (response.status !== 401 || i === keys.length - 1) break;
    }
    return last;
  }

  /** Defines a function. Pass the result to `serve`. */
  createFunction(options: FunctionOptions, trigger: Trigger | Trigger[], handler: Handler): FlowFunction {
    if (!ID_RE.test(options.id)) {
      throw new Error(`invalid function id "${options.id}": use letters, digits, - and _ (up to 64)`);
    }
    const tags = Object.entries(options.tags ?? {});
    if (tags.length > MAX_TAGS) throw new Error(`function ${options.id} has ${tags.length} tags (at most ${MAX_TAGS})`);
    for (const [name, expression] of tags) {
      if (!TAG_NAME_RE.test(name)) {
        throw new Error(`function ${options.id} has an invalid tag name "${name}": a letter, then letters, digits and _ (up to 32)`);
      }
      if (typeof expression !== "string" || !expression) throw new Error(`function ${options.id}: tag ${name} needs an expression`);
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
        handler: (ctx) => {
          const attempts: unknown = ctx.event.data?.attempts;
          return onFailure({ ...ctx, error: ctx.event.data?.error, attempts: typeof attempts === "number" ? attempts : 0 });
        },
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

/** What the engine answered a signed call. */
interface EngineAnswer {
  ok: boolean;
  status: number;
  body: unknown;
  error: string;
  /** The error's `code`, when the engine gave one. */
  code?: string;
}

/** An error answer from the engine. `status` is the HTTP status. */
function failed(what: string, res: EngineAnswer): Error & { status: number } {
  return Object.assign(new Error(`${what} failed (${res.status}): ${res.error}`), { status: res.status });
}

/** One of `channel` or `channels` (1 to 100), as the engine takes them. */
function checkChannels(what: string, request: { channel?: unknown; channels?: unknown }): void {
  const { channel, channels } = request;
  if (channel !== undefined && channels !== undefined) throw new Error(`${what}: give channel or channels, not both`);
  if (channels !== undefined) {
    if (!Array.isArray(channels) || channels.length === 0 || channels.length > MAX_CHANNELS) {
      throw new Error(`${what}: channels must list 1 to ${MAX_CHANNELS} channels`);
    }
    // So the token fits in a connect URL.
    const chars = channels.reduce((n: number, c: unknown) => n + String(c).length, 0);
    if (chars > MAX_CHANNEL_CHARS) {
      throw new Error(`${what}: channels have ${chars} characters of names in all (at most ${MAX_CHANNEL_CHARS})`);
    }
  } else if (typeof channel !== "string" || !channel) {
    throw new Error(`${what} needs a channel`);
  }
}

/** A 4xx that asking again will not fix (not 408 or 429). */
function lasting(error: Error): boolean {
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** StreamGoneError and StreamClosedError for the engine's codes; else a plain Error. */
function streamFailed(what: string, id: string, res: EngineAnswer): Error {
  if (res.code === "StreamGone") return new StreamGoneError(id);
  if (res.code === "StreamClosed") return new StreamClosedError(id);
  return failed(what, res);
}

/** One realtime message to send. */
export interface RealtimeOut {
  channel: string;
  topic: string;
  data: Json;
}

/** `flow.realtime.subscribe`: one channel, or many (1 to 100) on one socket. */
export type ServerSubscribeOptions<T = unknown> = ({ channel: string } | { channels: string[] }) & {
  /** 1 to 10 topics; on many channels, they apply to every channel. */
  topics: string[];
  onMessage: (message: RealtimeMessage<T>) => void;
  onState?: (state: RealtimeState, error?: Error) => void;
  /** Default: the global WebSocket (Node 22 and later have one). */
  WebSocket?: typeof WebSocket;
  env?: FlowEnv;
};

/** `flow.realtime`. On Workers, pass the handler's `env` if the keys live there. */
export interface FlowRealtime {
  /** Sends `data` (any JSON value, up to about 64 KB) to the browsers on `topic` of `channel`. */
  publish(message: RealtimeOut, options?: { env?: FlowEnv }): Promise<void>;
  /**
   * Sends 1 to 100 messages in one call (up to 1 MB in all, 64 KB each). The engine
   * checks them all first: one bad message fails the call and sends none.
   */
  publishMany(messages: RealtimeOut[], options?: { env?: FlowEnv }): Promise<void>;
  /**
   * A token that lets one browser connect to `channel` (or to 1 to 100 `channels` on one
   * socket) and read `topics` (1 to 10). Call it in your own route, after you checked
   * that the user may see that channel, and send the result to the browser as JSON.
   */
  token(
    request: { channel: string; topics: string[] } | { channels: string[]; topics: string[] },
    options?: { env?: FlowEnv },
  ): Promise<RealtimeToken>;
  /**
   * Subscribes from a server, until the returned function is called. It makes its own
   * token before every connect, and connects at `baseUrl`. Messages can be lost while it
   * connects again, and at the socket's 1-hour renewal: read missed state from your own
   * store.
   */
  subscribe<T = unknown>(options: ServerSubscribeOptions<T>): () => void;
}

/** `flow.runs`. On Workers, pass the handler's `env` if the keys live there. */
export interface FlowRuns {
  /**
   * The app's runs, newest first (or oldest first with `order: "oldest"`). A `tags`
   * filter needs `function`. `limit` is 1 to 200 (default 50). Reads an index that lags
   * the runs by a few seconds.
   */
  list(options?: {
    function?: string | FlowFunction;
    status?: RunStatus[];
    tags?: Record<string, string>;
    limit?: number;
    before?: string;
    order?: "newest" | "oldest";
    env?: FlowEnv;
  }): Promise<RunPage>;
  /** How many runs of one function there are in each status. Reads the same index as `list`. */
  counts(options: { function: string | FlowFunction; env?: FlowEnv }): Promise<RunCounts>;
  /**
   * The active run that holds a singleton key (the value the function's `singleton.key`
   * gives), with no index lag. Nulls when no run holds it.
   */
  singleton(fn: string | FlowFunction, key: Json, options?: { env?: FlowEnv }): Promise<SingletonRun>;
  /**
   * Cancels one run, the run that holds a singleton key, or the active runs with a tag
   * (up to 500 a call, oldest first; `more` says there are more: call again with `next`
   * as `cursor`). Runs that had ended go in `notActive`.
   */
  cancel(
    request:
      | { runId: string }
      | { function: string | FlowFunction; singletonKey: Json }
      | { function: string | FlowFunction; tag: Record<string, string>; status?: ActiveRunStatus[]; cursor?: string },
    options?: { env?: FlowEnv },
  ): Promise<CancelResult>;
  /** One of the app's runs, with its event and error, with no index lag. Null when there is none. */
  get(runId: string, options?: { env?: FlowEnv }): Promise<RunDetail | null>;
  /**
   * Retries a failed or cancelled run from where it stopped, under the same run ID, as
   * the dashboard's Retry. `retried` is false for a run that has not ended that way.
   */
  retry(runId: string, options?: { env?: FlowEnv }): Promise<RetryResult>;
  /**
   * Deletes a run that has ended now, as its retention would later. `deleted` is false
   * for an active run, one that is not found, and one kept for debugging (`reason:
   * "kept"`).
   */
  delete(runId: string, options?: { env?: FlowEnv }): Promise<{ deleted: boolean; reason?: "kept" }>;
}

/** `flow.functions`. On Workers, pass the handler's `env` if the keys live there. */
export interface FlowFunctions {
  /**
   * Pauses a function: new runs are refused (or held, with `start`'s `whenPaused`), and
   * its active runs pause at their next step.
   */
  pause(fn: string | FlowFunction, options?: { env?: FlowEnv }): Promise<PauseResult>;
  /** Resumes a paused function and its paused runs. */
  resume(fn: string | FlowFunction, options?: { env?: FlowEnv }): Promise<PauseResult>;
}

/**
 * `flow.streams`. On Workers, pass the handler's `env` if the keys live there.
 * A stream ID is letters, digits and `:_.-`, up to 256.
 */
export interface FlowStreams {
  /** Makes a stream, deleted after `ttl` (1 s to 7 days) unless closed. `created` is false when it was there already. */
  open(id: string, options: { meta?: Json; ttl: Duration; env?: FlowEnv }): Promise<{ created: boolean }>;
  /** Adds 1 to 100 items, in order. Gives back their offsets. Throws StreamGoneError or StreamClosedError. */
  append(id: string, items: Json[], options?: { env?: FlowEnv }): Promise<string[]>;
  /** Every item after `after` (default: all), without following. Null when the stream is gone. */
  snapshot<T = Json>(id: string, options?: { after?: string; env?: FlowEnv }): Promise<StreamSnapshot<T> | null>;
  /**
   * Writes `end` as the last item and deletes the stream `grace` (0 to 7 days) later.
   * `closed` is false when it was closed already. Throws StreamGoneError.
   */
  close(id: string, options: { end: Json; grace: Duration; env?: FlowEnv }): Promise<{ closed: boolean }>;
  /** Deletes the stream now. `deleted` is false when there was none. */
  delete(id: string, options?: { env?: FlowEnv }): Promise<{ deleted: boolean }>;
  /** A token that lets one browser read the stream with `readStream`. Send it as JSON. */
  token(id: string, options?: { env?: FlowEnv }): Promise<StreamToken>;
  /**
   * Every item after `after`, then new ones as they come, until the end item (which it
   * gives too) or until `signal` aborts. A closed stream with nothing after `after` ends
   * at once, with no item. Connects again from the last offset after a drop.
   * Throws StreamGoneError when the stream is gone, or goes while read.
   */
  read<T = Json>(
    id: string,
    options?: { after?: string; signal?: AbortSignal; WebSocket?: typeof WebSocket; env?: FlowEnv },
  ): AsyncIterable<StreamItem<T>>;
}
