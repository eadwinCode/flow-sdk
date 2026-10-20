// Keys and request signing, following Inngest's scheme (see docs/architecture.md,
// "Keys and signing"). Uses WebCrypto only, so it runs in Workers, Node and browsers.
//
// Signing key format: `signkey-<64 hex chars>`.
// Engine -> app:  X-Inngest-Signature: t=<unix seconds>&s=<hex HMAC-SHA256(secret, body + t)>
// App -> engine answer: X-Flow-Answer-Signature: s=<hex HMAC-SHA256(secret, answerString)>
// App -> engine:  Authorization: Bearer signkey-<hex sha256(secret bytes)>

const encoder = new TextEncoder();

const SIGNING_KEY_RE = /^signkey-([0-9a-f]{64})$/;
const BEARER_RE = /^signkey-([0-9a-f]{64})$/;

export const SIGNATURE_TOLERANCE_SEC = 300;

export function parseSigningKey(key: string): { secret: string } {
  const m = SIGNING_KEY_RE.exec(key);
  if (!m) throw new Error("invalid signing key format");
  return { secret: m[1]! };
}

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (const b of view) out += b.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return toHex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/** Compares two strings in time that depends only on their length. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function randomHex(bytes: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function generateSigningKey(): string {
  return `signkey-${randomHex(32)}`;
}

export function generateEventKey(): string {
  return randomHex(32);
}

/** Header value for a request signed with `signingKey`. */
export async function signRequest(
  signingKey: string,
  body: string,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<string> {
  const { secret } = parseSigningKey(signingKey);
  const t = String(nowSec);
  return `t=${t}&s=${await hmacHex(secret, body + t)}`;
}

/**
 * Checks a signature header against one or more keys (current, then fallback).
 * Rejects headers older or newer than the tolerance, so captured calls cannot be replayed.
 */
export async function verifySignature(opts: {
  header: string | null | undefined;
  body: string;
  keys: Array<string | undefined>;
  nowSec?: number;
  toleranceSec?: number;
}): Promise<boolean> {
  return (await matchSignature(opts)) !== null;
}

/**
 * Like `verifySignature`, but returns the key that matched (the first one, if both do),
 * or null. The SDK signs its answer with that key.
 */
export async function matchSignature(opts: {
  header: string | null | undefined;
  body: string;
  keys: Array<string | undefined>;
  nowSec?: number;
  toleranceSec?: number;
}): Promise<string | null> {
  if (!opts.header) return null;
  const params = new URLSearchParams(opts.header);
  const t = params.get("t");
  const s = params.get("s");
  if (!t || !s || !/^\d+$/.test(t)) return null;
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(t)) > (opts.toleranceSec ?? SIGNATURE_TOLERANCE_SEC)) return null;

  let matched: string | null = null;
  for (const key of opts.keys) {
    if (!key) continue;
    // A key in a bad format matches nothing (as in Go); the SDK refuses such keys before this.
    let secret: string;
    try {
      ({ secret } = parseSigningKey(key));
    } catch {
      continue;
    }
    // Check every key so timing does not reveal which one matched.
    if (timingSafeEqual(s, await hmacHex(secret, opts.body + t)) && matched === null) matched = key;
  }
  return matched;
}

/**
 * What an answer signature covers. `request` is the request's whole
 * X-Inngest-Signature header; its `s` ties the answer to that one call.
 * `noRetry` and `retryAfter` are the answer's X-Inngest-No-Retry and Retry-After
 * headers (null or "" when not set): they change what the engine does.
 */
export interface AnswerParts {
  request: string;
  status: number;
  noRetry?: string | null;
  retryAfter?: string | null;
  body: string;
}

function answerString(p: AnswerParts): string | null {
  const s = new URLSearchParams(p.request).get("s");
  if (!s) return null;
  return ["flow-answer-v1", s, String(p.status), p.noRetry ?? "", p.retryAfter ?? "", p.body].join("\n");
}

/** X-Flow-Answer-Signature value for an answer, signed with the key that passed the request. */
export async function signAnswer(signingKey: string, parts: AnswerParts): Promise<string> {
  const { secret } = parseSigningKey(signingKey);
  const message = answerString(parts);
  if (message === null) throw new Error("the request signature has no s");
  return `s=${await hmacHex(secret, message)}`;
}

/** Checks an X-Flow-Answer-Signature header, made with `key` (the key that signed the request). */
export async function verifyAnswer(opts: AnswerParts & { header: string | null | undefined; key: string }): Promise<boolean> {
  if (!opts.header) return false;
  const s = new URLSearchParams(opts.header).get("s");
  const message = answerString(opts);
  if (!s || message === null) return false;
  const { secret } = parseSigningKey(opts.key);
  return timingSafeEqual(s, await hmacHex(secret, message));
}

/** The bearer token an app sends to the engine: a hash of the key's secret, never the key. */
export async function signingKeyBearer(signingKey: string): Promise<string> {
  const { secret } = parseSigningKey(signingKey);
  return `signkey-${await sha256Hex(fromHex(secret))}`;
}

/** The hash in a bearer token, or null if it is not one. */
export function parseBearer(token: string): { hash: string } | null {
  const m = BEARER_RE.exec(token);
  return m ? { hash: m[1]! } : null;
}

/** Hash stored for an event key. */
export function hashEventKey(eventKey: string): Promise<string> {
  return sha256Hex(eventKey);
}
