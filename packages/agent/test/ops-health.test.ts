// Covers healthReport and formatHealth on PGlite, and on a pg pool pointed at
// a closed local port to stand in for an unreachable database. It does not
// cover a hosted Postgres that answers slowly, or the app role's read grants.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatHealth, healthReport } from "../src/ops/health.js";
import { cachePut } from "../src/store/cache.js";
import { createPgDb, type Db } from "../src/store/db.js";
import { setFlag } from "../src/store/flags.js";
import { reserve, reserveQlooCall, setBucket } from "../src/store/meter.js";
import { migratedPglite } from "./helpers/pglite.js";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1_000;
const FAR_FUTURE = new Date("2099-01-01T00:00:00.000Z");
const MARKER = "MARKERq7z";

let db: Db;

beforeEach(async () => {
  db = await migratedPglite();
});

afterEach(async () => {
  await db.close();
});

async function addRun(status: string, createdAt: Date): Promise<void> {
  await db.query("INSERT INTO runs (id, status, input, created_at) VALUES ($1::uuid, $2, $3::json, $4::timestamptz)", [
    randomUUID(),
    status,
    "{}",
    createdAt.toISOString(),
  ]);
}

async function healthySite(): Promise<void> {
  await setBucket(db, { key: "qloo:day", cap: 300, windowEnd: FAR_FUTURE });
  await setBucket(db, { key: "qloo:month", cap: 9_000, windowEnd: FAR_FUTURE });
  await setFlag(db, "live_runs", true);
}

describe("healthReport", () => {
  it("reports a healthy site with no problems", async () => {
    await healthySite();
    expect(await reserveQlooCall(db, NOW)).toBe(true);
    await addRun("done", new Date(NOW.getTime() - HOUR_MS));
    await addRun("done", new Date(NOW.getTime() - 2 * HOUR_MS));
    await addRun("failed", new Date(NOW.getTime() - 23 * HOUR_MS));
    await addRun("done", new Date(NOW.getTime() - 25 * HOUR_MS));
    await cachePut(db, "k1", { n: 1 }, HOUR_MS, NOW);

    const report = await healthReport(db, NOW);

    expect(report).toEqual({
      checkedAt: NOW.toISOString(),
      databaseReachable: true,
      buckets: [
        { key: "qloo:day", used: 1, cap: 300, percentUsed: 0.3, windowEnd: FAR_FUTURE.toISOString(), windowEnded: false },
        { key: "qloo:month", used: 1, cap: 9_000, percentUsed: 0, windowEnd: FAR_FUTURE.toISOString(), windowEnded: false },
      ],
      liveRuns: true,
      runsLast24h: { done: 2, failed: 1 },
      inflight: 0,
      cacheRows: 1,
      problems: [],
    });
    expect(formatHealth(report).at(-1)).toBe("No problems.");
  });

  it("flags a bucket at 80 percent but not one just under it", async () => {
    await healthySite();
    await setBucket(db, { key: "youtube:day", cap: 100, windowEnd: FAR_FUTURE });
    await setBucket(db, { key: "anthropic:day", cap: 1_000, windowEnd: FAR_FUTURE });
    await reserve(db, [{ key: "youtube:day", amount: 80 }, { key: "anthropic:day", amount: 799 }], NOW);

    const { problems } = await healthReport(db, NOW);

    expect(problems).toEqual(["youtube:day: 80% used (80 of 100)."]);
  });

  it("flags a window that has ended and a cap of 0", async () => {
    await healthySite();
    await setBucket(db, { key: "youtube:day", cap: 100, windowEnd: NOW });
    await setBucket(db, { key: "qloo:day:offline", cap: 0, windowEnd: FAR_FUTURE });

    const report = await healthReport(db, NOW);

    expect(report.buckets?.find((bucket) => bucket.key === "youtube:day")?.windowEnded).toBe(true);
    expect(report.problems).toEqual([
      "qloo:day:offline: its cap is 0, so it refuses every call.",
      "youtube:day: its window ended at 2026-10-19 12:00 UTC, so it refuses every call until the budgets are rolled.",
    ]);
  });

  it("flags live runs off, whether the flag is false or was never set", async () => {
    await setBucket(db, { key: "qloo:day", cap: 300, windowEnd: FAR_FUTURE });
    const never = await healthReport(db, NOW);
    await setFlag(db, "live_runs", false);
    const off = await healthReport(db, NOW);

    for (const report of [never, off]) {
      expect(report.liveRuns).toBe(false);
      expect(report.problems).toEqual(["Live runs are off, so the site shows saved runs only."]);
    }
  });

  it("flags an empty budget table and leaves per-second buckets out of the list", async () => {
    await setFlag(db, "live_runs", true);
    expect((await healthReport(db, NOW)).problems).toEqual([
      "No budget buckets are set, so every metered call is refused. Run the budgets command.",
    ]);

    await healthySite();
    expect(await reserveQlooCall(db, NOW)).toBe(true);
    const report = await healthReport(db, new Date(NOW.getTime() + 10_000));
    expect(report.buckets?.map((bucket) => bucket.key)).toEqual(["qloo:day", "qloo:month"]);
    expect(report.problems).toEqual([]);
  });

  it("reports an unreachable database without the connection string in any output", async () => {
    // Port 1 on loopback has no listener, so the pool fails to connect
    // without leaving this machine.
    const unreachable = createPgDb(`postgres://${MARKER}user:${MARKER}pass@127.0.0.1:1/${MARKER}db`);
    try {
      const report = await healthReport(unreachable, NOW);

      expect(report.databaseReachable).toBe(false);
      expect(report.problems).toEqual(["The database could not be reached, so no run can start and no metered call can go out."]);
      expect(JSON.stringify(report)).not.toContain(MARKER);
      expect(formatHealth(report).join("\n")).not.toContain(MARKER);
      expect(JSON.stringify(report)).not.toMatch(/postgres|127\.0\.0\.1/);
    } finally {
      await unreachable.close();
    }
  });

  it("never throws when every query fails", async () => {
    const broken: Db = {
      query: async () => {
        throw new Error(`driver said ${MARKER}`);
      },
      transaction: async () => {
        throw new Error(MARKER);
      },
      close: async () => {},
    };

    const report = await healthReport(broken, NOW);

    expect(report.databaseReachable).toBe(false);
    expect(JSON.stringify(report)).not.toContain(MARKER);
  });
});
