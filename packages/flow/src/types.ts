import type { CancelOn, FlowEvent, IncomingEvent, Json, SerializedError } from "@clevix/protocol";

// Public types of the SDK. Config option shapes follow Inngest's `inngest` package
// and are sent to the engine as given (see docs/sdk-protocol.md, "Sync").

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
  timeouts?: { step?: Duration };
  cancelOn?: CancelOn[];
  concurrency?: number | ConcurrencyOption | ConcurrencyOption[];
  throttle?: RateOption;
  rateLimit?: Omit<RateOption, "burst">;
  debounce?: { period: Duration; key?: string; timeout?: Duration };
  batchEvents?: { maxSize: number; timeout: Duration; key?: string; if?: string };
  priority?: { run?: string };
  idempotency?: string;
  singleton?: { key?: string; mode: "skip" | "cancel" };
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
