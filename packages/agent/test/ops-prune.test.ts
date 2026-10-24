// Covers pruneExpired on PGlite, which runs as its owner, including the MCP
// key and counter rows and the runs nobody confirmed. It does not cover the
// app role being refused DELETE (roles.sql needs hosted Postgres), a confirm
// racing the prune on hosted Postgres, or the time a prune takes on a large
// table.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueToken } from "../src/mcp/tokens.js";
import { pruneExpired } from "../src/ops/prune.js";
import { appendEvent, createRun, getRun, listEventsAfter, setRunStatus } from "../src/server/runs.js";
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
const NOTHING = { cacheRows: 0, secondBuckets: 0, visitorCounters: 0, mcpTokens: 0, mcpTokenDaily: 0, mcpKeyIssue: 0, confirmExpired: 0 };

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

    expect(await pruneExpired(db, NOW)).toEqual({ ...NOTHING, cacheRows: 2, secondBuckets: 1, visitorCounters: 2 });

    expect(await keysOf("qloo_cache")).toEqual(["live"]);
    expect(await keysOf("usage_buckets")).toEqual([liveSecond, "qloo:day", "qloo:month", "youtube:day"].sort());
    expect(await keysOf("visitor_counters")).toEqual([hash(3), hash(4), hash(5)]);
    expect((await usage(db, "qloo:day"))?.used).toBe(2);
  });

  it("finds nothing the second time", async () => {
    await cachePut(db, "expired", { n: 1 }, HOUR_MS, ago(DAY_MS));
    await addVisitorWindow(hash(1), ago(5 * DAY_MS));

    expect(await pruneExpired(db, NOW)).toEqual({ ...NOTHING, cacheRows: 1, visitorCounters: 1 });
    expect(await pruneExpired(db, NOW)).toEqual(NOTHING);
  });

  it("removes MCP counter days that started more than 2 days ago and keys expired over a week that no run points to (D6.2)", async () => {
    const day = (ms: number) => ago(ms).toISOString().slice(0, 10);
    const expiredLongAgo = await issueToken(db);
    const expiredWithRun = await issueToken(db);
    const expiredRecently = await issueToken(db);
    const live = await issueToken(db);
    const setLife = (id: string, expiresAt: Date) =>
      db.query("UPDATE mcp_tokens SET created_at = $2::timestamptz, expires_at = $3::timestamptz WHERE id = $1::uuid", [
        id,
        new Date(expiresAt.getTime() - 30 * DAY_MS).toISOString(),
        expiresAt.toISOString(),
      ]);
    await setLife(expiredLongAgo.id, ago(7 * DAY_MS + 1));
    await setLife(expiredWithRun.id, ago(30 * DAY_MS));
    await setLife(expiredRecently.id, ago(7 * DAY_MS));
    const runId = await createRun(db, { show: "Synthetic Show", exclude: [] }, ago(31 * DAY_MS), { surface: "mcp", tokenId: expiredWithRun.id });
    await db.query("INSERT INTO mcp_token_inflight (token_id, n) VALUES ($1::uuid, 0)", [expiredLongAgo.id]);
    for (const [tokenId, ms] of [
      [expiredLongAgo.id, 9 * DAY_MS],
      [live.id, 3 * DAY_MS],
      [live.id, 2 * DAY_MS],
      [live.id, DAY_MS],
      [live.id, 0],
    ] as const) {
      await db.query("INSERT INTO mcp_token_daily (token_id, day, runs) VALUES ($1::uuid, $2::date, 1)", [tokenId, day(ms)]);
    }
    for (const [n, ms] of [[1, 3 * DAY_MS], [2, 2 * DAY_MS], [3, DAY_MS], [4, 0]] as const) {
      await db.query("INSERT INTO mcp_key_issue (visitor_hash, day, n) VALUES ($1, $2::date, 1)", [hash(n), day(ms)]);
    }

    // NOW is 12:00 UTC, so the day that started 2 days and 12 hours ago goes,
    // and the one that started 1 day and 12 hours ago stays.
    expect(await pruneExpired(db, NOW)).toEqual({ ...NOTHING, mcpTokens: 1, mcpTokenDaily: 3, mcpKeyIssue: 2 });

    const { rows: tokens } = await db.query<{ id: string }>("SELECT id::text AS id FROM mcp_tokens ORDER BY id");
    expect(tokens.map((row) => row.id)).toEqual([expiredWithRun.id, expiredRecently.id, live.id].sort());
    const { rows: days } = await db.query<{ day: string }>("SELECT day::text AS day FROM mcp_token_daily ORDER BY day");
    expect(days.map((row) => row.day)).toEqual([day(DAY_MS), day(0)]);
    const { rows: issued } = await db.query<{ visitor_hash: string }>("SELECT visitor_hash FROM mcp_key_issue ORDER BY visitor_hash");
    expect(issued.map((row) => row.visitor_hash)).toEqual([hash(3), hash(4)]);
    expect((await db.query("SELECT 1 FROM mcp_token_inflight")).rows).toEqual([]);
    expect((await db.query("SELECT 1 FROM runs WHERE id = $1::uuid", [runId])).rows).toHaveLength(1);
    expect(await pruneExpired(db, NOW)).toEqual(NOTHING);
  });

  it("closes a run left awaiting its confirm for 2 hours as failed with CONFIRM_EXPIRED and its failed event, and leaves younger and running runs alone (C6.4)", async () => {
    const input = { show: "Synthetic Show", exclude: [] };
    const awaiting = async (createdAt: Date) => {
      const runId = await createRun(db, input, createdAt);
      await setRunStatus(db, runId, "awaiting_confirm", undefined, createdAt);
      return runId;
    };
    const stale = await awaiting(ago(2 * HOUR_MS));
    await appendEvent(db, stale, "candidates", { candidates: [] }, ago(2 * HOUR_MS));
    const young = await awaiting(ago(30 * 60 * 1_000));
    const running = await createRun(db, input, ago(2 * HOUR_MS));
    await setRunStatus(db, running, "running", undefined, ago(2 * HOUR_MS));

    expect(await pruneExpired(db, NOW)).toEqual({ ...NOTHING, confirmExpired: 1 });

    expect(await getRun(db, stale)).toMatchObject({ status: "failed", errorCode: "CONFIRM_EXPIRED", finishedAt: NOW });
    expect(await listEventsAfter(db, stale, 0)).toEqual([
      { seq: 1, event: "candidates", data: { candidates: [] } },
      { seq: 2, event: "failed", data: { code: "CONFIRM_EXPIRED" } },
    ]);
    expect((await getRun(db, young))?.status).toBe("awaiting_confirm");
    expect((await getRun(db, running))?.status).toBe("running");
    expect(await pruneExpired(db, NOW)).toEqual(NOTHING);
  });

  it("refuses an invalid date before deleting anything", async () => {
    await cachePut(db, "expired", { n: 1 }, HOUR_MS, ago(DAY_MS));

    await expect(pruneExpired(db, new Date(Number.NaN))).rejects.toThrow(StoreError);
    expect(await keysOf("qloo_cache")).toEqual(["expired"]);
  });
});
