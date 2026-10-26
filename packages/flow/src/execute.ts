import { parseDuration, type InvokeRequest, type Json, type Opcode, type SerializedError } from "@clevix/protocol";
import { NonRetriableError, RetryAfterError, serializeError, StepError } from "./errors.ts";
import { sha1Hex } from "./sha1.ts";
import type { FlowFunction, HandlerContext, StepRunInfo, StepTools } from "./types.ts";

// Runs one call of a function (see docs/protocol.md, "Running a function").
//
// The handler runs from the top. A memoized step resolves at once, so the code keeps
// going. A new step returns a promise that never resolves in this request. Once the
// handler has found new steps and a full tick passes with no more step calls, the
// steps found so far are the ones "found together", and we decide what to answer.

/** Largest step output the engine takes (4 MB, in UTF-8 bytes). */
export const MAX_OUTPUT_BYTES = 4_000_000;

export type ExecResult =
  | { type: "done"; output: Json }
  | { type: "ops"; ops: Opcode[] }
  | { type: "error"; error: SerializedError; noRetry?: boolean; retryAt?: number };

type RunFn = (info: StepRunInfo) => unknown;
type Settled = { ok: true; value: unknown } | { ok: false; error: unknown };

interface NewStep {
  id: string;
  name: string;
  /** Set for step.run; other steps carry their opcode. */
  run?: RunFn;
  op?: Opcode;
}

const encoder = new TextEncoder();

/** The hashed ID of a user's step ID for its Nth use (N = 0 for the first). */
export function hashStepId(id: string, occurrence: number): string {
  return sha1Hex(occurrence === 0 ? id : `${id}:${occurrence}`);
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

/** Lets every queued microtask run, so all step calls of this tick are made. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function toTime(time: Date | number | string): number {
  const ms = time instanceof Date ? time.getTime() : typeof time === "number" ? time : Date.parse(time);
  if (!Number.isFinite(ms)) throw new Error(`invalid time: ${String(time)}`);
  return ms;
}

/** Error fields shared by StepFailed and the 500 answer. */
export function failureOf(err: unknown): { error: SerializedError; noRetry?: boolean; retryAt?: number } {
  return {
    error: serializeError(err),
    ...(err instanceof NonRetriableError ? { noRetry: true } : {}),
    ...(err instanceof RetryAfterError ? { retryAt: err.retryAt } : {}),
  };
}

export async function execute(fn: FlowFunction, request: InvokeRequest): Promise<ExecResult> {
  const target = request.targetStepId;
  const counts = new Map<string, number>();
  const found: NewStep[] = [];
  /** New steps seen while running a target; not run and not reported. */
  let skipped = 0;
  /** Counts step calls, to tell when the handler has gone quiet. */
  let calls = 0;
  let decided = false;
  // Kept in an object: the callbacks below change these, and TypeScript would not see that.
  const state: { settled: Settled | null; target: NewStep | null } = { settled: null, target: null };
  let wake: (() => void) | null = null;
  const signal = () => {
    const w = wake;
    wake = null;
    w?.();
  };

  function call<T>(id: string, makeOp: ((hashed: string) => Opcode) | null, run?: RunFn): Promise<T> {
    if (decided) return never();
    if (typeof id !== "string" || id.length === 0) {
      return Promise.reject(new Error("a step ID must be a non-empty string"));
    }
    calls++;
    const occurrence = counts.get(id) ?? 0;
    counts.set(id, occurrence + 1);
    const hashed = hashStepId(id, occurrence);

    const entry = request.memo[hashed];
    if (entry) {
      if ("error" in entry) return Promise.reject(new StepError(id, entry.error));
      if ("data" in entry) return Promise.resolve(entry.data as T);
      // A `ref` entry means the invoker did not load a big output: a bug on the engine side.
      return Promise.reject(new Error(`step ${id}: memo entry was not loaded`));
    }

    if (target !== undefined) {
      if (hashed === target && run && !state.target) state.target = { id: hashed, name: id, run };
      else skipped++;
    } else {
      let op: Opcode | undefined;
      try {
        // Built only for a new step: Sleep.until must never be computed on replay.
        op = makeOp ? makeOp(hashed) : undefined;
      } catch (err) {
        return Promise.reject(err);
      }
      found.push({ id: hashed, name: id, ...(run ? { run } : {}), ...(op ? { op } : {}) });
    }
    signal();
    return never();
  }

  const step: StepTools = {
    run: (id, fn) => call(id, null, fn as RunFn),
    sleep: (id, duration) =>
      call(id, (hashed) => ({ op: "Sleep", id: hashed, name: id, until: Date.now() + parseDuration(duration) })),
    sleepUntil: (id, time) => call(id, (hashed) => ({ op: "Sleep", id: hashed, name: id, until: toTime(time) })),
    waitForEvent: (id, options) =>
      call(id, (hashed) => ({
        op: "WaitForEvent",
        id: hashed,
        name: id,
        event: options.event,
        timeout: options.timeout,
        ...(options.match !== undefined ? { match: options.match } : {}),
        ...(options.if !== undefined ? { if: options.if } : {}),
      })),
    sendEvent: (id, events) =>
      call(id, (hashed) => ({ op: "SendEvent", id: hashed, name: id, events: Array.isArray(events) ? events : [events] })),
    invoke: (id, options) =>
      call(id, (hashed) => ({
        op: "InvokeFunction",
        id: hashed,
        name: id,
        function: typeof options.function === "string" ? options.function : `${options.function.appId}-${options.function.id}`,
        ...(options.data !== undefined ? { data: options.data } : {}),
        ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
      })),
  };

  const ctx: HandlerContext = {
    event: request.event,
    events: request.events,
    step,
    runId: request.runId,
    attempt: request.attempt,
  };

  void (async () => fn.handler(ctx))().then(
    (value) => {
      state.settled = { ok: true, value };
      signal();
    },
    (error: unknown) => {
      state.settled = { ok: false, error };
      signal();
    },
  );

  // Wait until the handler ends, reaches the target, or goes quiet after finding new steps.
  for (;;) {
    if (state.settled || state.target) break;
    if (found.length + skipped === 0) {
      // Nothing new yet: the handler may be awaiting real work. Wait for its next move.
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      continue;
    }
    const before = calls;
    await tick();
    if (calls === before) break;
  }
  decided = true;
  const done = state.settled;
  const hit = state.target;

  if (hit) return { type: "ops", ops: [await runStep(hit, request)] };
  if (done && !done.ok) return { type: "error", ...failureOf(done.error) };
  if (target !== undefined) {
    return {
      type: "error",
      error: { name: "StepNotFound", message: `the function did not reach step ${target}` },
    };
  }
  if (found.length === 1 && found[0]!.run) return { type: "ops", ops: [await runStep(found[0]!, request)] };
  if (found.length > 0) {
    return {
      type: "ops",
      ops: found.map((s) => (s.run ? { op: "StepPlanned", id: s.id, name: s.name } : s.op!)),
    };
  }
  return { type: "done", output: done?.ok ? (done.value ?? null) : null };
}

/** Runs one step.run callback and reports it as StepCompleted or StepFailed. */
async function runStep(s: NewStep, request: InvokeRequest): Promise<Opcode> {
  const info: StepRunInfo = { stepId: s.id, idempotencyKey: `${request.runId}:${s.id}`, attempt: request.attempt };
  try {
    const value = await s.run!(info);
    const data: Json = value === undefined ? null : value;
    const size = encoder.encode(JSON.stringify(data) ?? "null").length;
    if (size > MAX_OUTPUT_BYTES) {
      return {
        op: "StepFailed",
        id: s.id,
        name: s.name,
        error: { name: "OutputTooLarge", message: `step output is ${size} bytes; the limit is ${MAX_OUTPUT_BYTES}` },
        noRetry: true,
      };
    }
    return { op: "StepCompleted", id: s.id, name: s.name, data };
  } catch (err) {
    return { op: "StepFailed", id: s.id, name: s.name, ...failureOf(err) };
  }
}
