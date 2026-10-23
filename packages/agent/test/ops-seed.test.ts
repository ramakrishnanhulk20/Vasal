// Covers the operator's seed in src/ops/seed.ts on PGlite: which buckets its
// meter charges, the preview, a picked run end to end through the real agent
// runner with the shared fakes, the closes for a missing pick and a missing
// show, and the seed arguments of scripts/ops.ts. It does not cover
// createSeedAgent's real Qloo, Anthropic, directory or feed calls (the
// operator's first live seed does), runSeed's printed report, or a deploy's
// restart sweep failing a seed run mid-way.
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readArgs } from "../scripts/ops.js";
import { loadPolicy } from "../src/ops/policy.js";
import { previewRun } from "../src/ops/promote.js";
import { rollBuckets } from "../src/ops/roll.js";
import { seedAgentFrom, seedMeterHooks, seedShow, type SeedAgent } from "../src/ops/seed.js";
import { getRun, listBoard, listEventsAfter } from "../src/server/runs.js";
import type { Db } from "../src/store/db.js";
import { usage } from "../src/store/meter.js";
import { fakeFeeds, fakeModel, fakeQloo } from "./helpers/agent-fakes.js";
import { migratedPglite } from "./helpers/pglite.js";

const POLICY_FILE = fileURLToPath(new URL("../scripts/budget-policy.json", import.meta.url));
const SHOW = "Synthetic Show";

let db: Db;

beforeEach(async () => {
  db = await migratedPglite();
});

afterEach(async () => {
  vi.useRealTimers();
  await db.close();
});

function fakeSeedAgent(feeds = fakeFeeds().feeds): SeedAgent {
  return seedAgentFrom(db, { qloo: fakeQloo().qloo, model: fakeModel().model, feeds, trends: false });
}

async function runCount(): Promise<number> {
  const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM runs");
  return rows[0]!.n;
}

describe("seed", () => {
  it("seedMeterHooks charges only the offline buckets", async () => {
    // A day inside the shipped policy, so the roll covers it whenever the suite runs.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T12:00:00.000Z"));
    expect((await rollBuckets(db, await loadPolicy(POLICY_FILE), new Date())).covered).toBe(true);
    const hooks = seedMeterHooks(db);

    expect(await hooks.waitForQlooSlot(db)).toBe(true);
    expect(await hooks.reserveModelTokens(100)).toBe(true);

    const keys = ["qloo:day:offline", "qloo:month", "anthropic:day:offline", "qloo:day", "qloo:day:mcp", "anthropic:day", "anthropic:day:mcp"];
    const used: Record<string, number | undefined> = {};
    for (const key of keys) used[key] = (await usage(db, key))?.used;
    expect(used).toEqual({
      "qloo:day:offline": 1,
      "qloo:month": 1,
      "anthropic:day:offline": 100,
      "qloo:day": 0,
      "qloo:day:mcp": 0,
      "anthropic:day": 0,
      "anthropic:day:mcp": 0,
    });
  });

  it("preview lists candidates in rank order and writes no run", async () => {
    const outcome = await seedShow(db, fakeSeedAgent(), SHOW, undefined);

    expect(outcome).toEqual({
      kind: "preview",
      candidates: [1, 2, 3, 4, 5].map((n) => ({
        rank: n,
        name: `Synthetic Show ${n}`,
        publisher: `Synthetic Publisher ${n}`,
        qlooName: `Synthetic Show ${n}`,
      })),
    });
    expect(await runCount()).toBe(0);
  });

  it("pick 1 builds a run that promote accepts", async () => {
    const outcome = await seedShow(db, fakeSeedAgent(), SHOW, 1);

    if (outcome.kind !== "done") throw new Error(`expected done, got ${JSON.stringify(outcome)}`);
    expect(outcome.picked).toEqual({ rank: 1, name: "Synthetic Show 1", publisher: "Synthetic Publisher 1", qlooName: "Synthetic Show 1" });
    // Showcase runs are website runs, so they are made with the default origin.
    expect(await getRun(db, outcome.runId)).toMatchObject({ status: "done", surface: "web", errorCode: null });
    expect(outcome.guests).toBeGreaterThanOrEqual(3);
    expect(outcome.guests).toBe((await listBoard(db, outcome.runId)).length);
    expect(outcome.pastGuests).toEqual({ checked: true, skipped: 0 });
    expect((await previewRun(db, outcome.runId)).refusal).toBeNull();
  });

  it("a pick past the list closes the run as SEED_PICK_MISSING", async () => {
    const outcome = await seedShow(db, fakeSeedAgent(), SHOW, 6);

    expect(outcome).toMatchObject({ kind: "failed", code: "SEED_PICK_MISSING" });
    const runId = outcome.kind === "failed" ? outcome.runId : null;
    expect(runId).not.toBeNull();
    expect(await getRun(db, runId!)).toMatchObject({ status: "failed", errorCode: "SEED_PICK_MISSING" });
    expect((await listEventsAfter(db, runId!, 0)).at(-1)).toMatchObject({ event: "failed", data: { code: "SEED_PICK_MISSING" } });
    expect(await listBoard(db, runId!)).toEqual([]);
  });

  it("a show the directory cannot find fails honestly", async () => {
    const agent = fakeSeedAgent(fakeFeeds({ shows: [] }).feeds);

    expect(await seedShow(db, agent, "Nothing", undefined)).toEqual({ kind: "failed", runId: null, code: "SHOW_NOT_FOUND" });
    expect(await runCount()).toBe(0);

    const picked = await seedShow(db, agent, "Nothing", 1);
    expect(picked).toMatchObject({ kind: "failed", code: "SHOW_NOT_FOUND" });
    const runId = picked.kind === "failed" ? picked.runId : null;
    expect(runId).not.toBeNull();
    expect(await getRun(db, runId!)).toMatchObject({ status: "failed", errorCode: "SHOW_NOT_FOUND" });
  });
});

describe("ops.ts seed arguments", () => {
  it("readArgs accepts and refuses seed arguments", () => {
    expect(readArgs(["seed", "X"])).toEqual({ dev: false, tunnelPort: undefined, command: { name: "seed", show: "X", pick: undefined } });
    expect(readArgs(["seed", "X", "--pick", "2"])).toEqual({ dev: false, tunnelPort: undefined, command: { name: "seed", show: "X", pick: 2 } });
    expect(readArgs(["--tunnel", "55432", "seed", "X", "--pick", "1"])).toEqual({
      dev: false,
      tunnelPort: 55432,
      command: { name: "seed", show: "X", pick: 1 },
    });

    for (const argv of [
      ["seed"],
      ["seed", "a", "b"],
      ["seed", "  "],
      ["seed", "X", "--pick", "0"],
      ["seed", "X", "--pick", "11"],
      ["seed", "X", "--pick", "x"],
      ["seed", "X", "--yes"],
      ["seed", "X", "--apply"],
      ["health", "--pick", "1"],
      ["promote", "00000000-0000-4000-8000-000000000700", "1", "--pick", "1"],
    ]) {
      expect(readArgs(argv), argv.join(" ")).toBeUndefined();
    }
  });
});
