// Wire types shared by the engine, the invoker and (later) the SDKs.
// Everything here crosses JSON and Workers RPC, so payloads are typed `Json`.
// The engine never runs user code: it sends an InvokeRequest to an app and
// gets back an InvokeOutcome built from the app's HTTP response.

/**
 * Any JSON value. Typed loosely on purpose: Workers RPC types turn `unknown` into
 * `never`, and a recursive JSON type hits TypeScript's depth limit there.
 */
// biome-ignore lint/suspicious/noExplicitAny: see above
export type Json = any;

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

/** An event as it travels through the engine, after the Event API gave it an ID. */
export interface FlowEvent {
  id: string;
  name: string;
  data: Json;
  /** When the event happened (ms since epoch). A future `ts` schedules the run. */
  ts: number;
  user?: Json;
}

/** What a sender posts to `POST /e/:key`. */
export interface IncomingEvent {
  name: string;
  data?: Json;
  /** Idempotency ID: two events with the same `id` are one event. */
  id?: string;
  ts?: number;
  user?: Json;
}

/**
 * A finished step as the SDK sees it during replay. `ref` is internal: a big output
 * kept in R2, which the invoker replaces with `data` before the app sees the memo.
 */
export type MemoEntry = { data: Json } | { error: SerializedError } | { ref: string };

/** A big payload kept in R2 (key and size in bytes). Internal to the engine. */
export interface PayloadRef {
  key: string;
  size: number;
}

/** Body of the signed POST the invoker sends to an app. */
export interface InvokeRequest {
  fnId: string;
  runId: string;
  event: FlowEvent;
  events: FlowEvent[];
  memo: Record<string, MemoEntry>;
  /** Attempt number for the step being run, starting at 0. */
  attempt: number;
  maxAttempts: number;
  /** Set when the engine asks the app to run one planned (parallel) step. */
  targetStepId?: string;
  /** Internal: a big batch of events kept in R2; the invoker fills `events` from it. */
  eventsRef?: string;
  /**
   * The run's state is too big to send in this request (over MAX_REQUEST_STATE_BYTES):
   * `memo` is {} and `events` is []. The SDK loads both from the engine's run state API
   * (`GET /runs/:runId/state`, see docs/sdk-protocol.md) before it runs the function.
   * `event` is always sent. Same idea as Inngest's `use_api`.
   */
  useApi?: boolean;
}

/** A memo entry as the run state API returns it: always loaded, never a `ref`. */
export type LoadedMemoEntry = { data: Json } | { error: SerializedError };

/** One page of `GET /runs/:runId/state`. */
export interface RunStatePage {
  /** The run's events (the batch). Only on the first page (no cursor). */
  events?: FlowEvent[];
  memo: Record<string, LoadedMemoEntry>;
  /** Pass as `?cursor=` for the next page; null on the last page. */
  next: string | null;
}

/** Most of a run's state that goes inside one app request; over it, `useApi` is set. */
export const MAX_REQUEST_STATE_BYTES = 4 * 1024 * 1024;
/**
 * Most state one run may hold: its events, every step's output or error, and its
 * output (Inngest's limit too). Passing it fails the run with `StateOverflowed`.
 */
export const MAX_RUN_STATE_BYTES = 32 * 1024 * 1024;

/** What the SDK reports back when it reaches a step that is not in the memo. */
export type Opcode =
  | {
      op: "StepCompleted";
      id: string;
      name: string;
      data: Json;
      /** Internal, set only by the invoker: a big output it stored in R2 (data is then null). */
      dataRef?: PayloadRef;
    }
  | {
      op: "StepFailed";
      id: string;
      name: string;
      error: SerializedError;
      /** NonRetriableError: fail the step now, skip remaining attempts. */
      noRetry?: boolean;
      /** RetryAfterError: retry at this time (ms since epoch). */
      retryAt?: number;
    }
  | { op: "StepPlanned"; id: string; name: string }
  | { op: "Sleep"; id: string; name: string; until: number }
  | {
      op: "WaitForEvent";
      id: string;
      name: string;
      /** Name of the event to wait for. */
      event: string;
      /** How long to wait, e.g. "7d". The step returns null when it runs out. */
      timeout: string | number;
      /** Field path in both events, e.g. "data.userId". */
      match?: string;
      /** Expression over `event` (the trigger) and `async` (the incoming event). */
      if?: string;
    }
  | { op: "SendEvent"; id: string; name: string; events: IncomingEvent[] }
  | {
      op: "InvokeFunction";
      id: string;
      name: string;
      /** Full function ID: "<appId>-<functionId>". Can be in another app. */
      function: string;
      data?: Json;
      user?: Json;
      /** Stop waiting after this long; the step then fails with InvokeTimeout. */
      timeout?: string | number;
    };

/** The invoker's summary of one app call, handed to RunDO.applyResult. */
export type InvokeOutcome =
  | { type: "ops"; ops: Opcode[] }
  | { type: "done"; output: Json; outputRef?: PayloadRef }
  | { type: "error"; error: SerializedError; noRetry?: boolean; retryAt?: number };

/** Message on the `invoke` Queue, from a RunDO to the invoker. */
export interface InvokeMessage {
  runId: string;
  appId: string;
  token: string;
  timeoutMs: number;
  /** Included when small; otherwise the invoker asks the RunDO for it. */
  request?: InvokeRequest;
}

export type Trigger = { event: string; if?: string } | { cron: string };

/** Cancel a run when a matching event arrives (Inngest's `cancelOn`). */
export interface CancelOn {
  event: string;
  /** Field path in both events, e.g. "data.orderId". */
  match?: string;
  /** Expression over `event` (the trigger) and `async` (the incoming event). */
  if?: string;
  /** Stop listening after this long. */
  timeout?: string | number;
}

/** One function in an app's manifest. Unknown keys are kept as config. */
export interface FunctionConfig {
  id: string;
  name?: string;
  triggers: Trigger[];
  retries?: number;
  timeouts?: { step?: string | number; finish?: string | number };
  cancelOn?: CancelOn[];
  [key: string]: unknown;
}

/** Body of `PUT /apps/:appId/sync`. */
export interface AppManifest {
  appId: string;
  url: string;
  sdk?: { language: string; version: string };
  functions: FunctionConfig[];
}

export const HEADERS = {
  signature: "X-Inngest-Signature",
  noRetry: "X-Inngest-No-Retry",
  retryAfter: "Retry-After",
} as const;

/**
 * HTTP contract for the app endpoint:
 * - 200: the function returned; body is its output (JSON).
 * - 206: more steps; body is Opcode[].
 * - anything else: error; body may be a SerializedError. `X-Inngest-No-Retry: true`
 *   means do not retry, `Retry-After` gives a retry time.
 */
export const STATUS = {
  done: 200,
  ops: 206,
} as const;
