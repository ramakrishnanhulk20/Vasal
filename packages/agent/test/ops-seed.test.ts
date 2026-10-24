// Covers the operator's seed in src/ops/seed.ts on PGlite: which buckets its
// meter charges, the preview, a picked run end to end through the real agent
// runner with the shared fakes, its briefs and the briefs command's writer,
// the closes for a missing pick and a missing show, and the seed and briefs
// arguments of scripts/ops.ts. It does not cover createSeedAgent's real
// Qloo, Anthropic, directory or feed calls (the operator's first live seed
// does), runSeed's and runBriefs's printed reports, or a deploy's restart
// sweep failing a seed run or a brief mid-way.
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readArgs } from "../scripts/ops.js";
import { loadPolicy } from "../src/ops/policy.js";
import { previewRun, readBriefs } from "../src/ops/promote.js";
import { rollBuckets } from "../src/ops/roll.js";
import { seedAgentFrom, seedMeterHooks, seedShow, writeBriefs, type SeedAgent } from "../src/ops/seed.js";
import {
  claimBrief,
  createRun,
  finishRun,
  getBrief,
  getBriefClaim,
  getRun,
  listBoard,
  listEventsAfter,
  markBriefFailed,
  putBoard,
  setRunStatus,
} from "../src/server/runs.js";
import type { Db } from "../src/store/db.js";
import { usage } from "../src/store/meter.js";
import { fakeFeeds, fakeModel, fakeQloo } from "./helpers/agent-fakes.js";
import { BRIEF_DRAFT } from "./helpers/briefs.js";
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
  return seedAgentFrom(db, { qloo: fakeQloo().qloo, model: fakeModel(BRIEF_DRAFT).model, feeds, trends: false });
}

// Seven guests in the runner's board shape, two more than a visitor's run
// may brief (C7.3).
const SEVEN_GUESTS = Array.from({ length: 7 }, (_, index) => ({
  personId: `00000000-0000-4000-8000-0000000008${String(index + 1).padStart(2, "0")}`,
  name: `Synthetic Guest ${index + 1}`,
  fit: 0.5,
  fitKnown: true,
  fitRank: index + 1,
  reach: "bookable",
  rising: { state: "steady", points: 0 },
  bringsNew: null,
  sharedTags: [],
  angle: "A synthetic angle.",
  showName: SHOW,
}));

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
    expect(outcome.briefs.guests.map((guest) => guest.state.kind)).toEqual(Array.from({ length: outcome.guests }, () => "written"));
    expect((await previewRun(db, outcome.runId)).refusal).toBeNull();
  });

  it("writeBriefs writes all 7 briefs of a done 7-guest board, past the website's 5, and retries a claim that failed once", async () => {
    const runId = await createRun(db, { show: SHOW, exclude: [] });
    await setRunStatus(db, runId, "running");
    const guestIds = await putBoard(db, runId, SEVEN_GUESTS);
    await finishRun(db, runId, "done", { name: "done", data: { guests: 7 } });
    const retried = guestIds[6]!;
    expect(await claimBrief(db, runId, retried, 5)).toBe("claimed");
    expect(await markBriefFailed(db, runId, retried, "MODEL_TIMEOUT")).toBe(true);

    const before = await readBriefs(db, runId);
    expect(before.guests.map((guest) => guest.state)).toEqual([
      ...Array.from({ length: 6 }, () => ({ kind: "none" })),
      { kind: "retry", code: "MODEL_TIMEOUT" },
    ]);

    const after = await writeBriefs(db, fakeSeedAgent().runner, runId);

    expect(after.guests.map((guest) => guest.state.kind)).toEqual(Array.from({ length: 7 }, () => "written"));
    for (const [index, guestId] of guestIds.entries()) {
      expect(await getBrief(db, runId, guestId)).toMatchObject({
        why: `Synthetic Guest ${index + 1} has 50% fit with ${SHOW} listeners.`,
        pitch_subject: `${SHOW} would love to have Synthetic Guest ${index + 1}`,
      });
    }
    expect(await getBriefClaim(db, runId, retried)).toEqual({ status: "done", attempts: 2, errorCode: null });
    const { rows } = await db.query("SELECT count(*)::int AS n FROM run_brief_claims WHERE run_id = $1::uuid AND status = 'done'", [runId]);
    expect(rows).toEqual([{ n: 7 }]);
    expect((await previewRun(db, runId)).refusal).toBeNull();
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

  it("readArgs accepts briefs with a run id and an optional --yes, and refuses anything else", () => {
    const runId = "00000000-0000-4000-8000-000000000700";
    expect(readArgs(["briefs", runId])).toEqual({ dev: false, tunnelPort: undefined, command: { name: "briefs", runId, yes: false } });
    expect(readArgs(["--tunnel", "55432", "briefs", runId, "--yes"])).toEqual({
      dev: false,
      tunnelPort: 55432,
      command: { name: "briefs", runId, yes: true },
    });

    for (const argv of [["briefs"], ["briefs", runId, "extra"], ["briefs", runId, "--apply"], ["briefs", runId, "--pick", "1"]]) {
      expect(readArgs(argv), argv.join(" ")).toBeUndefined();
    }
  });
});
