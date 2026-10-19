const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeBase32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const b of bytes) {
    buffer = (buffer << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCKFORD[(buffer << (5 - bits)) & 31];
  return out;
}

/** ULID: 48-bit time + 80 random bits, sortable by creation time. */
export function ulid(now = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  return time + encodeBase32(crypto.getRandomValues(new Uint8Array(10))).slice(0, 16);
}

/**
 * Deterministic ID from parts, e.g. run ID = hashId("run", eventId, functionId).
 * The same parts always give the same ID, which is what makes run creation idempotent.
 */
export async function hashId(prefix: string, ...parts: string[]): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(parts.join("\u0000")),
  );
  return `${prefix}_${encodeBase32(new Uint8Array(digest)).slice(0, 26)}`;
}
