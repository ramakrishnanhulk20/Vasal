// Covers storing and reading cached bodies on PGlite. It does not cover how
// the cache key is built (one builder in src/qloo, C7.1), whether a caller
// only caches good 200 responses (C7.2 is the caller's precondition), the
// real Qloo response schemas, or the pg adapter. All bodies are synthetic.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { cacheGet, cachePut } from "../src/store/cache.js";
import type { Db } from "../src/store/db.js";
import { StoreError } from "../src/store/errors.js";
import { migratedPglite } from "./helpers/pglite.js";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const HOUR = 60 * 60 * 1_000;
const MARKER = "MARKER-c41e07";
const entity = z.object({ id: z.string(), score: z.number() });

let db: Db;

beforeEach(async () => {
  db = await migratedPglite();
});

afterEach(async () => {
  await db.close();
});

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await errorOf(promise);
  return error instanceof StoreError ? error.code : String(error);
}

describe("cacheGet and cachePut", () => {
  it("returns the stored body before expiry and null from the expiry instant on", async () => {
    await cachePut(db, "GET hackathon.api.qloo.com /search?query=a", { id: "e1", score: 0.5 }, HOUR, NOW);

    expect(await cacheGet(db, "GET hackathon.api.qloo.com /search?query=a", entity, NOW)).toEqual({ id: "e1", score: 0.5 });
    expect(await cacheGet(db, "GET hackathon.api.qloo.com /search?query=a", entity, new Date(NOW.getTime() + HOUR - 1))).not.toBeNull();
    expect(await cacheGet(db, "GET hackathon.api.qloo.com /search?query=a", entity, new Date(NOW.getTime() + HOUR))).toBeNull();
  });

  it("returns null for a missing key", async () => {
    expect(await cacheGet(db, "never stored", entity, NOW)).toBeNull();
  });

  it("treats a stored body that fails the schema as missing (C6.5)", async () => {
    await cachePut(db, "k", { id: 42, score: "high" }, HOUR, NOW);
    await db.query(
      "INSERT INTO qloo_cache (cache_key, body, fetched_at, expires_at) VALUES ($1, $2::text::json, $3::timestamptz, $4::timestamptz)",
      ["planted", '"just a string"', NOW.toISOString(), new Date(NOW.getTime() + HOUR).toISOString()],
    );

    expect(await cacheGet(db, "k", entity, NOW)).toBeNull();
    expect(await cacheGet(db, "planted", entity, NOW)).toBeNull();
  });

  it("keeps keys that differ by one character apart", async () => {
    await cachePut(db, "q=SmartLess&take=5", { id: "a", score: 1 }, HOUR, NOW);
    await cachePut(db, "q=SmartLess&take=6", { id: "b", score: 2 }, HOUR, NOW);

    expect(await cacheGet(db, "q=SmartLess&take=5", entity, NOW)).toEqual({ id: "a", score: 1 });
    expect(await cacheGet(db, "q=SmartLess&take=6", entity, NOW)).toEqual({ id: "b", score: 2 });
    expect(await cacheGet(db, "q=SmartLess&take=7", entity, NOW)).toBeNull();
    expect(await cacheGet(db, "Q=SmartLess&take=5", entity, NOW)).toBeNull();
  });

  it("returns an object with its keys in the order they were stored", async () => {
    // Holds for keys that are not integer-like; JavaScript itself lists
    // integer-like keys first in every object.
    const body = { zeta: 1, alpha: { yankee: 2, bravo: 3 }, mid: [{ delta: 4, charlie: 5 }], beta: null };
    await cachePut(db, "ordered", body, HOUR, NOW);

    const back = await cacheGet(db, "ordered", z.unknown(), NOW);

    expect(JSON.stringify(back)).toBe(JSON.stringify(body));
    expect(Object.keys(back as object)).toEqual(["zeta", "alpha", "mid", "beta"]);
  });

  it("replaces an entry and its expiry on a second put", async () => {
    await cachePut(db, "k", { id: "old", score: 1 }, HOUR, NOW);
    await cachePut(db, "k", { id: "new", score: 2 }, 2 * HOUR, NOW);

    expect(await cacheGet(db, "k", entity, new Date(NOW.getTime() + HOUR + 1))).toEqual({ id: "new", score: 2 });
  });

  it("accepts a key of exactly 4,096 characters and a body of exactly 1,000,000", async () => {
    const key = "k".repeat(4_096);
    const body = "x".repeat(999_998);
    await cachePut(db, key, body, HOUR, NOW);

    expect(await cacheGet(db, key, z.string(), NOW)).toBe(body);
  });

  it("throws STORE_BAD_INPUT past the size caps and for bodies or ttls it cannot store (C6.7)", async () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;

    expect(await codeOf(cachePut(db, "k".repeat(4_097), {}, HOUR, NOW))).toBe("STORE_BAD_INPUT");
    expect(await codeOf(cachePut(db, "", {}, HOUR, NOW))).toBe("STORE_BAD_INPUT");
    expect(await codeOf(cachePut(db, "k", "x".repeat(999_999), HOUR, NOW))).toBe("STORE_BAD_INPUT");
    expect(await codeOf(cachePut(db, "k", undefined, HOUR, NOW))).toBe("STORE_BAD_INPUT");
    expect(await codeOf(cachePut(db, "k", { n: 1n }, HOUR, NOW))).toBe("STORE_BAD_INPUT");
    expect(await codeOf(cachePut(db, "k", circular, HOUR, NOW))).toBe("STORE_BAD_INPUT");
    for (const ttl of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(await codeOf(cachePut(db, "k", {}, ttl, NOW))).toBe("STORE_BAD_INPUT");
    }
    expect(await codeOf(cacheGet(db, "k".repeat(4_097), entity, NOW))).toBe("STORE_BAD_INPUT");
    expect((await db.query("SELECT count(*)::int AS n FROM qloo_cache")).rows[0]).toEqual({ n: 0 });
  });

  it("never repeats the key or body in a StoreError", async () => {
    const refusals = [
      cachePut(db, MARKER.repeat(500), {}, HOUR, NOW),
      cachePut(db, "k", MARKER.repeat(100_000), HOUR, NOW),
      cacheGet(db, MARKER.repeat(500), entity, NOW),
    ];
    for (const refusal of refusals) {
      const error = await errorOf(refusal);
      expect(error).toBeInstanceOf(StoreError);
      expect(String(error)).not.toContain("MARKER");
      expect(JSON.stringify(error)).not.toContain("MARKER");
    }
  });
});
