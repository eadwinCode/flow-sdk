import { parseDuration, type SerializedError } from "@clevix/protocol";

/**
 * Throw this to fail for good, with no more retries. In a step it fails the step;
 * outside a step it fails the run.
 */
export class NonRetriableError extends Error {
  override readonly name: string = "NonRetriableError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * Throw this to ask for the next retry at a given time.
 * `at` is a Date, a time in ms since epoch, or a duration from now like "30s".
 */
export class RetryAfterError extends Error {
  override readonly name: string = "RetryAfterError";
  /** When to retry, in ms since epoch. */
  readonly retryAt: number;

  constructor(message: string, at: Date | number | string, options?: { cause?: unknown }) {
    super(message, options);
    this.retryAt =
      at instanceof Date ? at.getTime() : typeof at === "number" ? at : Date.now() + parseDuration(at);
    if (!Number.isFinite(this.retryAt)) throw new Error(`RetryAfterError: invalid time ${String(at)}`);
  }
}

/**
 * What a step call throws on replay when the step ran out of retries. It has the
 * step's error name and message. Catch it to run compensation steps.
 */
export class StepError extends Error {
  /** The user's step ID. */
  readonly stepId: string;

  constructor(stepId: string, error: SerializedError) {
    super(error.message);
    this.name = error.name;
    this.stepId = stepId;
    if (error.stack !== undefined) this.stack = error.stack;
  }
}

/**
 * The stream does not exist: it was never opened, or it was deleted (its time ran out,
 * or `delete` was called). `flow.streams` throws it on the engine's 404 `StreamGone`,
 * and `read` throws it when the engine closes the socket with 4404.
 */
export class StreamGoneError extends Error {
  override readonly name: string = "StreamGoneError";

  readonly streamId: string;

  constructor(streamId: string) {
    super(`stream ${streamId} is gone`);
    this.streamId = streamId;
  }
}

/** An append to a stream that is closed. `flow.streams.append` throws it on the engine's 409 `StreamClosed`. */
export class StreamClosedError extends Error {
  override readonly name: string = "StreamClosedError";

  readonly streamId: string;

  constructor(streamId: string) {
    super(`stream ${streamId} is closed`);
    this.streamId = streamId;
  }
}

/** Turns anything thrown into the wire error shape. */
export function serializeError(err: unknown): SerializedError {
  if (err && typeof err === "object" && "message" in err) {
    const e = err as { name?: unknown; message?: unknown; stack?: unknown };
    return {
      name: typeof e.name === "string" ? e.name : "Error",
      message: String(e.message),
      ...(typeof e.stack === "string" ? { stack: e.stack } : {}),
    };
  }
  return { name: "Error", message: String(err) };
}
