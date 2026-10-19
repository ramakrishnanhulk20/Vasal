// Covers pruneExpired on PGlite, which runs as its owner. It does not cover
// the app role being refused DELETE (roles.sql needs hosted Postgres) or the
// time a prune takes on a large table.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pruneExpired } from "../src/ops/prune.js";
import { cachePut } from "../src/store/cache.js";
import type { Db } from "../src/store/db.js";
import { StoreError } from "../src/store/errors.js";
import { reserveQlooCall, setBucket, usage } from "../src/store/meter.js";
import { migratedPglite } from "./helpers/pglite.js";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const FAR_FUTURE = new Date("2099-01-01T00:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const hash = (n: number) => n.toString(16).padStart(64, "0");

let db: Db;

beforeEach(async () => {
  db = await migratedPglite();
});

afterEach(async () => {
  await db.close();
});

const KEY_QUERIES = {
  qloo_cache: 'SELECT cache_key AS k FROM qloo_cache ORDER BY cache_key COLLATE "C"',
  visitor_counters: 'SELECT visitor_hash AS k FROM visitor_counters ORDER BY visitor_hash COLLATE "C"',
  usage_buckets: 'SELECT key AS k FROM usage_buckets ORDER BY key COLLATE "C"',
} as const;

async function keysOf(table: keyof typeof KEY_QUERIES): Promise<string[]> {
  const { rows } = await db.query<{ k: string }>(KEY_QUERIES[table]);
  return rows.map((row) => row.k);
}

async function addVisitorWindow(visitorHash: string, windowStart: Date): Promise<void> {
  await db.query("INSERT INTO visitor_counters (visitor_hash, window_start, runs) VALUES ($1, $2::timestamptz, 1)", [
    visitorHash,
    windowStart.toISOString(),
  ]);
}

describe("pruneExpired", () => {
  it("removes exactly the expired rows and keeps every live one", async () => {
    await cachePut(db, "expired-yesterday", { n: 1 }, HOUR_MS, ago(DAY_MS));
    await cachePut(db, "expires-now", { n: 2 }, HOUR_MS, ago(HOUR_MS));
    await cachePut(db, "live", { n: 3 }, HOUR_MS, NOW);

    await setBucket(db, { key: "qloo:day", cap: 100, windowEnd: FAR_FUTURE });
    await setBucket(db, { key: "qloo:month", cap: 1_000, windowEnd: FAR_FUTURE });
    await setBucket(db, { key: "youtube:day", cap: 10, windowEnd: ago(DAY_MS) });
    expect(await reserveQlooCall(db, ago(10_000))).toBe(true);
    expect(await reserveQlooCall(db, NOW)).toBe(true);
    const liveSecond = `qloo:second:${Math.floor(NOW.getTime() / 1_000)}`;

    await addVisitorWindow(hash(1), ago(3 * DAY_MS));
    await addVisitorWindow(hash(2), ago(2 * DAY_MS + 1));
    await addVisitorWindow(hash(3), ago(2 * DAY_MS));
    await addVisitorWindow(hash(4), ago(DAY_MS));
    await addVisitorWindow(hash(5), ago(0));

    expect(await pruneExpired(db, NOW)).toEqual({ cacheRows: 2, secondBuckets: 1, visitorCounters: 2 });

    expect(await keysOf("qloo_cache")).toEqual(["live"]);
    expect(await keysOf("usage_buckets")).toEqual([liveSecond, "qloo:day", "qloo:month", "youtube:day"].sort());
    expect(await keysOf("visitor_counters")).toEqual([hash(3), hash(4), hash(5)]);
    expect((await usage(db, "qloo:day"))?.used).toBe(2);
  });

  it("finds nothing the second time", async () => {
    await cachePut(db, "expired", { n: 1 }, HOUR_MS, ago(DAY_MS));
    await addVisitorWindow(hash(1), ago(5 * DAY_MS));

    expect(await pruneExpired(db, NOW)).toEqual({ cacheRows: 1, secondBuckets: 0, visitorCounters: 1 });
    expect(await pruneExpired(db, NOW)).toEqual({ cacheRows: 0, secondBuckets: 0, visitorCounters: 0 });
  });

  it("refuses an invalid date before deleting anything", async () => {
    await cachePut(db, "expired", { n: 1 }, HOUR_MS, ago(DAY_MS));

    await expect(pruneExpired(db, new Date(Number.NaN))).rejects.toThrow(StoreError);
    expect(await keysOf("qloo_cache")).toEqual(["expired"]);
  });
});
