// Covers ops nightly in scripts/ops.ts on PGlite: prune runs whatever budgets
// returned, and the night passes only when both steps did. It does not cover
// the scheduler that starts it (Railway's cron), the process exit code, which
// main and runToExit set from this result (ops-exit.test.ts covers
// runToExit), or a step that throws.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readArgs, runNightly } from "../scripts/ops.js";
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
    expect(lines.at(-1)).toBe("Nightly: budgets failed, prune passed.");
  });

  it("passes when budgets and prune both pass", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T03:00:00.000Z"));

    expect(await runNightly(db)).toBe(true);

    expect(lines).toContain("No problems.");
    expect(lines.at(-1)).toBe("Nightly: budgets passed, prune passed.");
  });

  it("readArgs accepts nightly alone", () => {
    expect(readArgs(["nightly"])).toEqual({ dev: false, tunnelPort: undefined, command: { name: "nightly" } });
    for (const argv of [["nightly", "extra"], ["nightly", "--yes"], ["nightly", "--pick", "1"]]) {
      expect(readArgs(argv), argv.join(" ")).toBeUndefined();
    }
  });
});
