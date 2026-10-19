const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** Parses "500ms", "30s", "1h30m", "3d" (or a number of ms) into milliseconds. */
export function parseDuration(input: string | number): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) throw new Error(`invalid duration: ${input}`);
    return input;
  }
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d|w)/g;
  let total = 0;
  let consumed = 0;
  for (const m of input.trim().matchAll(re)) {
    total += Number(m[1]) * UNIT_MS[m[2]!]!;
    consumed += m[0].length;
  }
  if (consumed === 0 || consumed !== input.trim().length) {
    throw new Error(`invalid duration: ${input}`);
  }
  return total;
}

/**
 * Retry delay for an attempt (0-based): min(cap, base * 2^attempt) * random(0.5, 1.0).
 * The jitter spreads retries out so failing runs do not all retry at once.
 */
export function backoffMs(
  attempt: number,
  opts: { baseMs?: number; capMs?: number; random?: () => number } = {},
): number {
  const base = opts.baseMs ?? 1_000;
  const cap = opts.capMs ?? 3_600_000;
  const random = opts.random ?? Math.random;
  const raw = Math.min(cap, base * 2 ** attempt);
  return Math.round(raw * (0.5 + 0.5 * random()));
}
