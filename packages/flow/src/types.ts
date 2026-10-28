import type { CancelOn, FlowEvent, IncomingEvent, Json, SerializedError } from "@clevix/protocol";
import type { StreamItem } from "./realtime.ts";

// Public types of the SDK. Config option shapes follow Inngest's `inngest` package
// and are sent to the engine as given (see docs/protocol.md, "Sync").

/** "30s", "5m", "7d", "1h30m", or milliseconds as a number. */
export type Duration = string | number;

export type Trigger = { event: string; if?: string } | { cron: string };

export interface ConcurrencyOption {
  limit: number;
  /** Expression over `event`, e.g. "event.data.accountId". */
  key?: string;
  scope?: "fn" | "env" | "account";
}

export interface RateOption {
  limit: number;
  period: Duration;
  key?: string;
  burst?: number;
}

export interface FunctionOptions {
  id: string;
  name?: string;
  retries?: number;
  /**
   * `step`: the longest one step's call may take. `finish`: the longest the whole run
   * may take, counted from its first step call; a run still going then is cancelled.
   */
  timeouts?: { step?: Duration; finish?: Duration };
  cancelOn?: CancelOn[];
  concurrency?: number | ConcurrencyOption | ConcurrencyOption[];
  throttle?: RateOption;
  rateLimit?: Omit<RateOption, "burst">;
  debounce?: { period: Duration; key?: string; timeout?: Duration };
  batchEvents?: { maxSize: number; timeout: Duration; key?: string; if?: string };
  priority?: { run?: string };
  idempotency?: string;
  singleton?: { key?: string; mode: "skip" | "cancel" };
  /**
   * Up to 3 tags on each run, to find runs with `flow.runs.list` and `flow.runs.cancel`.
   * A name is a letter, then letters, digits and _ (up to 32). A value is an expression
   * over `event`, worked out once when the run starts, e.g. "event.data.orderId".
   */
  tags?: Record<string, string>;
  /** Runs when the function fails for good. Becomes the function `<id>-failure`. */
  onFailure?: FailureHandler;
}

/** What `step.run` passes to its callback. */
export interface StepRunInfo {
  /** The hashed step ID. */
  stepId: string;
  /** `<runId>:<hashed step id>`: the same on every attempt. Pass it to outside APIs. */
  idempotencyKey: string;
  /** Attempt number, starting at 0. */
  attempt: number;
}

export interface WaitForEventOptions {
  event: string;
  timeout: Duration;
  /** Field path in both events, e.g. "data.userId". */
  match?: string;
  /** Expression over `event` (the trigger) and `async` (the incoming event). */
  if?: string;
}

export interface InvokeOptions {
  /** A function made with `createFunction`, or a full ID "<appId>-<functionId>". */
  function: FlowFunction | string;
  data?: Json;
  timeout?: Duration;
}

export interface StepTools {
  run<T>(id: string, fn: (info: StepRunInfo) => T | Promise<T>): Promise<Awaited<T>>;
  sleep(id: string, duration: Duration): Promise<void>;
  sleepUntil(id: string, time: Date | number | string): Promise<void>;
  /** Returns the matching event, or null when the timeout runs out. */
  waitForEvent(id: string, options: WaitForEventOptions): Promise<FlowEvent | null>;
  sendEvent(id: string, events: IncomingEvent | IncomingEvent[]): Promise<{ ids: string[] }>;
  invoke<T = Json>(id: string, options: InvokeOptions): Promise<T>;
}

export interface HandlerContext {
  event: FlowEvent;
  events: FlowEvent[];
  step: StepTools;
  runId: string;
  attempt: number;
}

export type Handler = (ctx: HandlerContext) => unknown;

export interface FailureContext extends HandlerContext {
  /** The error the run failed with (`event.data.error`). */
  error: SerializedError;
  /**
   * How many times the call that failed the run was tried (`event.data.attempts`); a
   * NonRetriableError in a step gives 1. 0 when the run failed with no failed try (for
   * example, its state grew too large), or with an older engine.
   */
  attempts: number;
}

export type FailureHandler = (ctx: FailureContext) => unknown;

/** A function made with `flow.createFunction`. Pass it to `serve`. */
export interface FlowFunction {
  readonly id: string;
  /** The app's ID, from the client. */
  readonly appId: string;
  readonly options: FunctionOptions;
  readonly triggers: Trigger[];
  readonly handler: Handler;
  /** The `<id>-failure` function made from `onFailure`, if set. */
  readonly failure?: FlowFunction;
}

/** What `flow.start` gives back. It does not throw when the run did not start. */
export type StartResult =
  | {
      started: true;
      runId: string;
      eventId: string;
      /** The run was started before, by a call with the same `id`. */
      existed?: true;
    }
  | {
      started: false;
      reason: "singleton";
      /** The run that holds the singleton, or null when it ended in between. */
      activeRunId: string | null;
    }
  | { started: false; reason: "paused" | "not_found" };

/** Statuses of an active run. */
export type ActiveRunStatus = "queued" | "running" | "sleeping" | "waiting" | "waiting_for_app" | "paused";
export type RunStatus = ActiveRunStatus | "completed" | "failed" | "cancelled";

/** One run in `flow.runs.list`. */
export interface RunSummary {
  id: string;
  /** The function's own ID, as in `createFunction`. */
  functionId: string;
  status: RunStatus;
  /** ms since epoch. */
  createdAt: number;
  /** ms since epoch; null while the run is active. */
  endedAt: number | null;
  /** {} when the run has none. */
  tags: Record<string, string>;
}

/** A page of `flow.runs.list`. Pass `next` as `before` for the next page. */
export interface RunPage {
  items: RunSummary[];
  next: string | null;
}

/**
 * Runs of one function by status. Ended runs are counted only while the engine keeps
 * them: `since` (ms since epoch) says from when.
 */
export type RunCounts = Record<RunStatus, number> & { since: number };

/** What `flow.runs.singleton` gives back: the active run for a key, or nulls. */
export interface SingletonRun {
  runId: string | null;
  status: RunStatus | null;
}

/** What `flow.runs.cancel` gives back. */
export interface CancelResult {
  cancelled: string[];
  /** Runs that had ended, or that are not the app's. */
  notActive: string[];
  /** Cancel by tag only: there are more runs to cancel; call again with `next` as `cursor`. */
  more: boolean;
  /** Cancel by tag only: pass it as `cursor` to go on after this page; null otherwise. */
  next: string | null;
}

/** What `flow.streams.snapshot` gives back. */
export interface StreamSnapshot<T = Json> {
  meta: Json;
  items: StreamItem<T>[];
  /** The stream is closed: the last item is the end item. */
  ended: boolean;
}
