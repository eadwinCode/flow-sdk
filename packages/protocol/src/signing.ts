// Keys and request signing, following Inngest's scheme (see docs/architecture.md,
// "Keys and signing"). Uses WebCrypto only, so it runs in Workers, Node and browsers.
//
// Signing key format: `signkey-<env>-<64 hex chars>`.
// Engine -> app:  X-Inngest-Signature: t=<unix seconds>&s=<hex HMAC-SHA256(secret, body + t)>
// App -> engine:  Authorization: Bearer signkey-<env>-<hex sha256(secret bytes)>

const encoder = new TextEncoder();

const SIGNING_KEY_RE = /^signkey-([a-z0-9]+)-([0-9a-f]{64})$/;
const BEARER_RE = /^signkey-([a-z0-9]+)-([0-9a-f]{64})$/;

export const SIGNATURE_TOLERANCE_SEC = 300;

export function parseSigningKey(key: string): { env: string; secret: string } {
  const m = SIGNING_KEY_RE.exec(key);
  if (!m) throw new Error("invalid signing key format");
  return { env: m[1]!, secret: m[2]! };
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

export function generateSigningKey(env: string): string {
  if (!/^[a-z0-9]+$/.test(env)) throw new Error("env must be lowercase letters and digits");
  return `signkey-${env}-${randomHex(32)}`;
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
  if (!opts.header) return false;
  const params = new URLSearchParams(opts.header);
  const t = params.get("t");
  const s = params.get("s");
  if (!t || !s || !/^\d+$/.test(t)) return false;
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(t)) > (opts.toleranceSec ?? SIGNATURE_TOLERANCE_SEC)) return false;

  let ok = false;
  for (const key of opts.keys) {
    if (!key) continue;
    const { secret } = parseSigningKey(key);
    // Check every key so timing does not reveal which one matched.
    if (timingSafeEqual(s, await hmacHex(secret, opts.body + t))) ok = true;
  }
  return ok;
}

/** The bearer token an app sends to the engine: the key's env plus a hash of its secret. */
export async function signingKeyBearer(signingKey: string): Promise<string> {
  const { env, secret } = parseSigningKey(signingKey);
  return `signkey-${env}-${await sha256Hex(fromHex(secret))}`;
}

/** Splits a bearer token into env and hash, or returns null if it is not one. */
export function parseBearer(token: string): { env: string; hash: string } | null {
  const m = BEARER_RE.exec(token);
  return m ? { env: m[1]!, hash: m[2]! } : null;
}

/** Hash stored for an event key. */
export function hashEventKey(eventKey: string): Promise<string> {
  return sha256Hex(eventKey);
}
