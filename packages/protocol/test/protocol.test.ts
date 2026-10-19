import { describe, expect, it } from "vitest";
import {
  backoffMs,
  generateSigningKey,
  hashId,
  parseBearer,
  parseDuration,
  parseSigningKey,
  signingKeyBearer,
  signRequest,
  ulid,
  verifySignature,
} from "../src/index.ts";

describe("signing", () => {
  const key = generateSigningKey("prod");
  const body = JSON.stringify({ fnId: "f", runId: "r" });
  const now = 1_800_000_000;

  it("parses the key format", () => {
    expect(parseSigningKey(key).env).toBe("prod");
    expect(() => parseSigningKey("signkey-prod-short")).toThrow();
  });

  it("accepts a valid signature", async () => {
    const header = await signRequest(key, body, now);
    expect(await verifySignature({ header, body, keys: [key], nowSec: now })).toBe(true);
  });

  it("rejects a changed body", async () => {
    const header = await signRequest(key, body, now);
    expect(
      await verifySignature({ header, body: body + " ", keys: [key], nowSec: now }),
    ).toBe(false);
  });

  it("rejects the wrong key", async () => {
    const header = await signRequest(key, body, now);
    const other = generateSigningKey("prod");
    expect(await verifySignature({ header, body, keys: [other], nowSec: now })).toBe(false);
  });

  it("rejects old signatures (replay)", async () => {
    const header = await signRequest(key, body, now);
    expect(await verifySignature({ header, body, keys: [key], nowSec: now + 301 })).toBe(false);
    expect(await verifySignature({ header, body, keys: [key], nowSec: now + 299 })).toBe(true);
  });

  it("accepts the fallback key during rotation", async () => {
    const newKey = generateSigningKey("prod");
    const header = await signRequest(key, body, now);
    expect(
      await verifySignature({ header, body, keys: [newKey, key], nowSec: now }),
    ).toBe(true);
  });

  it("rejects missing or broken headers", async () => {
    for (const header of [null, "", "t=abc&s=00", "s=00"]) {
      expect(await verifySignature({ header, body, keys: [key], nowSec: now })).toBe(false);
    }
  });

  it("makes a stable bearer token that hides the secret", async () => {
    const bearer = await signingKeyBearer(key);
    expect(bearer).toBe(await signingKeyBearer(key));
    expect(bearer).not.toContain(parseSigningKey(key).secret);
    expect(parseBearer(bearer)?.env).toBe("prod");
    expect(parseBearer("nope")).toBeNull();
  });
});

describe("ids", () => {
  it("ulid is 26 chars and sorts by time", () => {
    const a = ulid(1000);
    const b = ulid(2000);
    expect(a).toHaveLength(26);
    expect(a < b).toBe(true);
  });

  it("hashId is deterministic", async () => {
    expect(await hashId("run", "evt", "fn")).toBe(await hashId("run", "evt", "fn"));
    expect(await hashId("run", "evt", "fn")).not.toBe(await hashId("run", "evt", "fn2"));
    expect(await hashId("run", "a", "bc")).not.toBe(await hashId("run", "ab", "c"));
    expect(await hashId("run", "x")).toMatch(/^run_[0-9A-Z]{26}$/);
  });
});

describe("time", () => {
  it("parses durations", () => {
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("3d")).toBe(3 * 86_400_000);
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(parseDuration(42)).toBe(42);
    expect(() => parseDuration("3 days")).toThrow();
    expect(() => parseDuration("")).toThrow();
  });

  it("backoff grows, is capped, and has jitter", () => {
    expect(backoffMs(0, { random: () => 1 })).toBe(1_000);
    expect(backoffMs(0, { random: () => 0 })).toBe(500);
    expect(backoffMs(3, { random: () => 1 })).toBe(8_000);
    expect(backoffMs(30, { random: () => 1 })).toBe(3_600_000);
  });
});
