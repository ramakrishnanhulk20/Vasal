// Covers ops nightly in scripts/ops.ts on PGlite: prune and reconcile run
// whatever budgets returned, the reconcile frees a lost run place and prints
// its counts, and the night passes only when every step did. It does not
// cover the scheduler that starts it (Railway's cron), the process exit code,
// which main and runToExit set from this result (ops-exit.test.ts covers
// runToExit), or a step that throws.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readArgs, runNightly } from "../scripts/ops.js";
import { acquireMcpRunSlots } from "../src/server/caps.js";
import { cachePut } from "../src/store/cache.js";
import type { Db } from "../src/store/db.js";
import { migratedPglite } from "./helpers/pglite.js";

const HOUR_MS = 60 * 60 * 1_000;

let db: Db;
let lines: string[];

beforeEach(async () => {
  db = await migratedPglite();
  lines = [];
  const keep = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(keep);
  vi.spyOn(console, "error").mockImplementation(keep);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await db.close();
});

async function cacheKeys(): Promise<string[]> {
  const { rows } = await db.query<{ k: string }>("SELECT cache_key AS k FROM qloo_cache");
  return rows.map((row) => row.k);
}

describe("ops nightly", () => {
  it("still prunes on a night budgets fails because no profile covers the date, and fails the night", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2027-03-01T03:00:00.000Z"));
    await cachePut(db, "expired", { n: 1 }, HOUR_MS, new Date(Date.now() - 2 * HOUR_MS));

    expect(await runNightly(db)).toBe(false);

    expect(await cacheKeys()).toEqual([]);
    expect(lines).toContain("Budgets at 2027-03-01 03:00 UTC: no profile in scripts/budget-policy.json covers today, so nothing was set.");
    expect(lines.some((line) => line.startsWith("Pruned 1 expired cache rows"))).toBe(true);
    expect(lines.at(-1)).toBe("Nightly: budgets failed, prune passed, reconcile passed.");
  });

  it("passes when budgets and prune both pass", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T03:00:00.000Z"));

    expect(await runNightly(db)).toBe(true);

    expect(lines).toContain("No problems.");
    expect(lines).toContain("No place was lost.");
    expect(lines.at(-1)).toBe("Nightly: budgets passed, prune passed, reconcile passed.");
  });

  it("frees a run place lost to a failed release, after budgets and prune, and prints the counts before and after", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T03:00:00.000Z"));
    expect(await acquireMcpRunSlots(db, 1, 3)).toBe(true);

    expect(await runNightly(db)).toBe(true);

    const { rows } = await db.query<{ slot: string; n: number }>("SELECT slot, n FROM inflight ORDER BY slot");
    expect(rows).toEqual([
      { slot: "mcp", n: 0 },
      { slot: "runs", n: 0 },
    ]);
    const order = ["$ ops budgets", "$ ops prune", "$ ops reconcile"].map((line) => lines.indexOf(line));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order[0]).toBeGreaterThanOrEqual(0);
    expect(lines).toEqual(expect.arrayContaining(["  site  1 before, 0 after", "  MCP   1 before, 0 after", "Freed 2 places that no run held."]));
  });

  it("readArgs accepts nightly and reconcile alone", () => {
    expect(readArgs(["nightly"])).toEqual({ dev: false, tunnelPort: undefined, command: { name: "nightly" } });
    expect(readArgs(["reconcile"])).toEqual({ dev: false, tunnelPort: undefined, command: { name: "reconcile" } });
    for (const argv of [["nightly", "extra"], ["nightly", "--yes"], ["nightly", "--pick", "1"], ["reconcile", "extra"], ["reconcile", "--yes"]]) {
      expect(readArgs(argv), argv.join(" ")).toBeUndefined();
    }
  });
});
