// Covers the operator's seed in src/ops/seed.ts on PGlite: which buckets its
// meter charges, the preview, a picked run end to end through the real agent
// runner with the shared fakes, its briefs and the briefs command's writer,
// the closes for a missing pick and a missing show, the guesses backfill that
// adds the Without Qloo flip to a done run, the --archive file and the
// past guest an archive line leaves out, and the seed, briefs, guesses and
// recheck arguments of scripts/ops.ts. It does not cover createSeedAgent's real
// Qloo, Anthropic, directory or feed calls (the operator's first live seed
// does), runSeed's, runBriefs's and runGuesses's printed reports, or a
// deploy's restart sweep failing a seed run or a brief mid-way.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZodType } from "zod";
import { readArgs } from "../scripts/ops.js";
import { AgentError } from "../src/agent/errors.js";
import type { ModelCallOptions, ModelClient } from "../src/agent/model.js";
import { WITHOUT_QLOO_SYSTEM } from "../src/agent/prompts.js";
import { loadPolicy } from "../src/ops/policy.js";
import { previewRun, readBriefs } from "../src/ops/promote.js";
import { rollBuckets } from "../src/ops/roll.js";
import {
  addGuesses,
  ArchiveError,
  parseArchive,
  planGuesses,
  readArchive,
  seedAgentFrom,
  seedMeterHooks,
  seedShow,
  writeBriefs,
  type SeedAgent,
} from "../src/ops/seed.js";
import type { MeteredQloo } from "../src/qloo/metered.js";
import type { QlooOperation } from "../src/qloo/request.js";
import {
  claimBrief,
  createRun,
  finishRun,
  getBrief,
  getBriefClaim,
  getRun,
  getWithoutQloo,
  listBoard,
  listEventsAfter,
  markBriefFailed,
  putBoard,
  putCandidates,
  setRunStatus,
} from "../src/server/runs.js";
import type { Db } from "../src/store/db.js";
import { usage } from "../src/store/meter.js";
import { fakeFeeds, fakeModel, fakeQloo, harnessFrom, personId } from "./helpers/agent-fakes.js";
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

function fakeSeedAgent(feeds = fakeFeeds().feeds, qloo = fakeQloo().qloo): SeedAgent {
  return seedAgentFrom(db, { qloo, harness: harnessFrom(qloo).harness, model: fakeModel(BRIEF_DRAFT).model, feeds, trends: false });
}

// The shared fake gives every show one Qloo podcast, and candidates that
// share one collapse to the first, so this gives each show its own.
function ownPodcasts(): MeteredQloo {
  const { qloo } = fakeQloo();
  return {
    ...qloo,
    async call<T>(op: QlooOperation, options?: Parameters<MeteredQloo["call"]>[1]) {
      if (op.op !== "search" || !op.types.includes("urn:entity:podcast")) return qloo.call<T>(op, options);
      const id = `00000000-0000-4000-8000-0000000005${op.query.slice(-1).padStart(2, "0")}`;
      return { data: [{ entity_id: id, name: op.query }] as T, fromCache: false };
    },
  };
}

// The shared fake model's finish_board names every pick each time; this one
// leaves out pick `left` the second time, so a board can still form once
// the tools refuse a past guest.
function droppingOnRetry(left: number): ModelClient {
  const { model } = fakeModel(BRIEF_DRAFT);
  let finishes = 0;
  return {
    ...model,
    async turn(params, options) {
      const reply = await model.turn(params, options);
      const content = reply.content.map((block) => {
        if (block.type !== "tool_use" || block.name !== "finish_board") return block;
        finishes += 1;
        const picks = [1, 2, 3, 4].filter((n) => n !== left).map((n) => ({ personId: personId(n), angle: "Their fans already love this kind of talk." }));
        return finishes === 1 ? block : { ...block, input: { picks } };
      });
      return { ...reply, content };
    },
  };
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
  it("seedMeterHooks charges only the offline buckets, and settles the model share down to the tokens used", async () => {
    // A day inside the shipped policy, so the roll covers it whenever the suite runs.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T12:00:00.000Z"));
    expect((await rollBuckets(db, await loadPolicy(POLICY_FILE), new Date())).covered).toBe(true);
    const hooks = seedMeterHooks(db);

    expect(await hooks.waitForQlooSlot(db)).toBe(true);
    const settle = await hooks.reserveModelTokens(100);
    if (settle === false) throw new Error("expected a settle callback");

    const keys = [
      "qloo:day:offline",
      "qloo:month:offline",
      "qloo:month",
      "anthropic:day:offline",
      "qloo:day",
      "qloo:day:mcp",
      "qloo:month:mcp",
      "anthropic:day",
      "anthropic:day:mcp",
    ];
    const used: Record<string, number | undefined> = {};
    for (const key of keys) used[key] = (await usage(db, key))?.used;
    expect(used).toEqual({
      "qloo:day:offline": 1,
      "qloo:month:offline": 1,
      "qloo:month": 1,
      "anthropic:day:offline": 100,
      "qloo:day": 0,
      "qloo:day:mcp": 0,
      "qloo:month:mcp": 0,
      "anthropic:day": 0,
      "anthropic:day:mcp": 0,
    });
    await settle(35);
    expect((await usage(db, "anthropic:day:offline"))?.used).toBe(35);
    expect((await usage(db, "anthropic:day"))?.used).toBe(0);
  });

  it("refuses an offline Qloo slot once qloo:month:offline is full, while qloo:month and the offline day still have room (audit A1-5)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T12:00:00.000Z"));
    expect((await rollBuckets(db, await loadPolicy(POLICY_FILE), new Date())).covered).toBe(true);
    const offlineMonth = await usage(db, "qloo:month:offline");
    expect(offlineMonth?.cap).toBe(3_000);
    await db.query("UPDATE usage_buckets SET used = cap WHERE key = 'qloo:month:offline'");
    const hooks = seedMeterHooks(db);

    expect(await hooks.waitForQlooSlot(db)).toBe(false);

    expect((await usage(db, "qloo:month:offline"))?.used).toBe(3_000);
    expect(await usage(db, "qloo:month")).toEqual(expect.objectContaining({ cap: 32_000, used: 0 }));
    expect(await usage(db, "qloo:day:offline")).toEqual(expect.objectContaining({ cap: 300, used: 0 }));
  });

  it("preview lists candidates in rank order and writes no run", async () => {
    const outcome = await seedShow(db, fakeSeedAgent(fakeFeeds().feeds, ownPodcasts()), SHOW, undefined);

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
    // The runner adds the flip as part of the run, right before its done event.
    const events = (await listEventsAfter(db, outcome.runId, 0)).map((event) => event.event);
    expect(events.indexOf("without_qloo")).toBe(events.indexOf("done") - 1);
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
        why: `Synthetic Guest ${index + 1} suits ${SHOW} listeners.`,
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

describe("guesses (the Without Qloo backfill)", () => {
  const OUTSIDER = "00000000-0000-4000-8000-000000000899";
  const FEED = `<?xml version="1.0"?><rss><channel><title>${SHOW}</title><item><title>Talking with Synthetic Outsider</title></item></channel></rss>`;

  // A done run stored the way the runner stores one, before the flip existed.
  async function doneRunWithoutFlip(opts: { sameShowFeeds?: number } = {}): Promise<string> {
    const runId = await createRun(db, { show: SHOW, exclude: [] });
    await setRunStatus(db, runId, "running");
    const candidate = (n: number) => ({
      appleId: String(1000 + n),
      name: "Synthetic Show Directory Name",
      publisher: "Synthetic Publisher",
      feedHandleSource: "directory" as const,
      feedUrl: `https://feeds.example/show-${n}.xml`,
      qlooId: "00000000-0000-4000-8000-000000000500",
      qlooName: SHOW,
    });
    await putCandidates(db, runId, Array.from({ length: opts.sameShowFeeds ?? 1 }, (_, i) => candidate(i + 1)));
    await putBoard(db, runId, SEVEN_GUESTS);
    await finishRun(db, runId, "done", { name: "done", data: { guests: 7 } });
    return runId;
  }

  function guessingAgent(guests: unknown) {
    const { model: scripted } = fakeModel(BRIEF_DRAFT);
    const asked: string[] = [];
    const model: ModelClient = {
      ...scripted,
      async structured<T>(params: { system: string; user: string; schema: ZodType<T>; maxTokens: number }, options?: ModelCallOptions): Promise<T> {
        if (params.system !== WITHOUT_QLOO_SYSTEM) return scripted.structured(params, options);
        asked.push(params.user);
        const parsed = params.schema.safeParse({ guests });
        if (!parsed.success) throw new AgentError("AGENT_BAD_PROSE");
        return parsed.data;
      },
    };
    const ops: QlooOperation[] = [];
    const people: Record<string, unknown[]> = {
      "Synthetic Guest 1": [{ entity_id: SEVEN_GUESTS[0]!.personId, name: "Synthetic Guest 1" }],
      "Synthetic Outsider": [{ entity_id: OUTSIDER, name: "Synthetic Outsider", popularity: 0.3 }],
    };
    const fits: Record<string, number> = { [SEVEN_GUESTS[0]!.personId]: 0.6, [OUTSIDER]: 0.2 };
    const qloo: MeteredQloo = {
      async call<T>(op: QlooOperation): Promise<{ data: T; fromCache: boolean }> {
        ops.push(op);
        if (op.op === "search") return { data: (people[op.query] ?? []) as T, fromCache: false };
        if (op.op === "insights") {
          const rows = (op.resultEntities ?? []).map((wanted) => ({ entity_id: wanted, name: "ignored", query: { affinity: fits[wanted] } }));
          return { data: rows as T, fromCache: false };
        }
        throw new Error(`no fake answer for ${op.op}`);
      },
      stats: () => ({ calls: ops.length, cacheHits: 0 }),
    };
    const { feeds, fetched } = fakeFeeds({ feed: FEED });
    const agent: SeedAgent = seedAgentFrom(db, { qloo, harness: harnessFrom(qloo).harness, model, feeds, trends: false });
    return { agent, asked, ops, fetched };
  }

  it("adds the flip to a done run that has none, from its stored show, its feed and its board, and does nothing once it has one", async () => {
    const runId = await doneRunWithoutFlip();
    const { agent, asked, ops, fetched } = guessingAgent(["Synthetic Guest 1", "Synthetic Outsider"]);

    // The plan takes no agent, so the command without --yes cannot spend.
    expect(await planGuesses(db, runId)).toEqual({ kind: "ready", runId, showName: SHOW, guests: 7 });

    const added = await addGuesses(db, agent, runId);

    const flip = {
      status: "done",
      guesses: [
        { name: "Synthetic Guest 1", fit: 0.6, fitKnown: true, reach: "none", pastGuest: false, host: false, onBoard: true },
        { name: "Synthetic Outsider", fit: 0.2, fitKnown: true, reach: "none", pastGuest: true, host: false, onBoard: false },
      ],
      unresolved: 0,
    };
    expect(added).toEqual({ kind: "added", runId, flip });
    // The public view shows no reach label for "none".
    expect(await getWithoutQloo(db, runId)).toEqual({ ...flip, guesses: flip.guesses.map((guess) => ({ ...guess, reach: null })) });
    expect((await listEventsAfter(db, runId, 0)).at(-1)).toMatchObject({ event: "without_qloo", data: flip });
    expect(fetched.map((url) => url.href)).toEqual(["https://feeds.example/show-1.xml"]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('Show: "Synthetic Show"');
    expect(asked[0]).toContain('Publisher: "Synthetic Publisher"');
    expect(ops.map((op) => op.op)).toEqual(["search", "search", "insights"]);
    expect((await getRun(db, runId))?.status).toBe("done");

    const eventsBefore = await listEventsAfter(db, runId, 0);
    expect(await planGuesses(db, runId)).toEqual({ kind: "has", runId });
    expect(await addGuesses(db, agent, runId)).toEqual({ kind: "has", runId });
    expect(await listEventsAfter(db, runId, 0)).toEqual(eventsBefore);
    expect(asked).toHaveLength(1);
    expect(ops).toHaveLength(3);
    expect(fetched).toHaveLength(1);
  });

  // Several feeds can share one Qloo show (DOAC, Lex Fridman and Armchair Expert
  // did on 24 Oct), and a run does not record which one it continued with, so
  // the operator names the rank the seed used and nothing is guessed.
  it("refuses a run whose candidates share the show unless the rank is given, then uses that rank's feed", async () => {
    const runId = await doneRunWithoutFlip({ sameShowFeeds: 2 });
    expect(await planGuesses(db, runId)).toEqual({ kind: "refused", runId, code: "GUESSES_NO_SHOW" });
    expect(await planGuesses(db, runId, 3)).toEqual({ kind: "refused", runId, code: "GUESSES_NO_SHOW" });
    expect(await planGuesses(db, runId, 1)).toEqual({ kind: "ready", runId, showName: SHOW, guests: 7 });

    const { agent, fetched } = guessingAgent(["Synthetic Outsider"]);
    expect(await addGuesses(db, agent, runId, 2)).toMatchObject({ kind: "added", flip: { status: "done" } });
    expect(fetched.map((url) => url.href)).toEqual(["https://feeds.example/show-2.xml"]);
  });

  it("readArgs takes --pick for guesses as the candidate rank", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(readArgs(["guesses", id, "--pick", "1", "--yes"])).toMatchObject({ command: { name: "guesses", runId: id, yes: true, pick: 1 } });
    expect(readArgs(["guesses", id])).toMatchObject({ command: { name: "guesses", pick: undefined } });
  });

  it("stores an unavailable flip when the model fails, which a later run of the command may replace", async () => {
    const runId = await doneRunWithoutFlip();

    expect(await addGuesses(db, guessingAgent([]).agent, runId)).toEqual({ kind: "added", runId, flip: { status: "unavailable" } });
    expect(await planGuesses(db, runId)).toMatchObject({ kind: "ready" });
    expect(await addGuesses(db, guessingAgent(["Synthetic Outsider"]).agent, runId)).toMatchObject({ kind: "added", flip: { status: "done" } });
    expect(await planGuesses(db, runId)).toEqual({ kind: "has", runId });
  });

  it("refuses a run that is not done, has no board, or whose show cannot be found, spending nothing", async () => {
    const open = await createRun(db, { show: SHOW, exclude: [] });
    const empty = await createRun(db, { show: SHOW, exclude: [] });
    await setRunStatus(db, empty, "running");
    await finishRun(db, empty, "done", { name: "done", data: { guests: 0 } });
    const lost = await createRun(db, { show: SHOW, exclude: [] });
    await setRunStatus(db, lost, "running");
    await putBoard(db, lost, SEVEN_GUESTS);
    await finishRun(db, lost, "done", { name: "done", data: { guests: 7 } });
    const { agent, asked, ops } = guessingAgent(["Synthetic Outsider"]);

    for (const [runId, code] of [
      [open, "GUESSES_NOT_DONE"],
      [crypto.randomUUID(), "GUESSES_NOT_DONE"],
      [empty, "GUESSES_NO_BOARD"],
      [lost, "GUESSES_NO_SHOW"],
    ] as const) {
      expect(await planGuesses(db, runId), code).toEqual({ kind: "refused", runId, code });
      expect(await addGuesses(db, agent, runId), code).toEqual({ kind: "refused", runId, code });
    }
    expect(asked).toEqual([]);
    expect(ops).toEqual([]);
  });
});

describe("the seed's --archive file (C2.9)", () => {
  it("reads title | description lines, splitting at the last bar, skipping blank lines and a byte-order mark", () => {
    const archive = parseArchive("\uFEFFE436: Stewart Butterfield | Slack's founder\r\nE12 | Part two | \n\n  Ep 3: solo  |  \n");
    expect(archive).toEqual({ titles: ["E436: Stewart Butterfield", "E12 | Part two", "Ep 3: solo"], descriptions: ["Slack's founder"] });
    expect(parseArchive("")).toEqual({ titles: [], descriptions: [] });
  });

  it("takes 10,000 lines of 1,000 characters and refuses the whole file at 10,001 lines or a 1,001-character line", () => {
    const line = (n: number) => `Episode ${n} | ${"d".repeat(1_000 - `Episode ${n} | `.length)}`;
    const full = Array.from({ length: 10_000 }, (_, n) => line(n)).join("\n");
    expect([...line(9_999)]).toHaveLength(1_000);
    expect(parseArchive(full).titles).toHaveLength(10_000);
    expect(() => parseArchive(`${full}\nOne more | `)).toThrow(new ArchiveError("ARCHIVE_TOO_MANY_LINES"));
    const long = `First | \nSecond | ${"\u{1F600}".repeat(992)}`;
    expect([...long.split("\n")[1]!]).toHaveLength(1_001);
    expect(() => parseArchive(long)).toThrow(expect.objectContaining({ code: "ARCHIVE_LINE_TOO_LONG", line: 2 }));
  });

  it("refuses the whole file for a line with no bar or no title, naming the line and none of its text", () => {
    for (const [text, line] of [
      ["Fine | ok\nStewart Butterfield on Slack\nAlso fine | ", 2],
      ["Fine | \n  | only a description", 2],
    ] as const) {
      let caught: unknown;
      try {
        parseArchive(text);
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "ARCHIVE_MALFORMED", line });
      expect((caught as Error).message).not.toMatch(/Butterfield|only a/);
    }
  });

  it("refuses a file that is not UTF-8 or cannot be read, and reads one that is", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "vasal-archive-"));
    try {
      const good = path.join(dir, "good.txt");
      await writeFile(good, "Synthetic Person 1 on the early days | \n", "utf8");
      expect(await readArchive(good)).toEqual({ titles: ["Synthetic Person 1 on the early days"], descriptions: [] });
      const latin = path.join(dir, "latin.txt");
      await writeFile(latin, Buffer.from([0x45, 0x70, 0x20, 0xe9, 0x20, 0x7c, 0x0a]));
      await expect(readArchive(latin)).rejects.toMatchObject({ code: "ARCHIVE_NOT_UTF8" });
      await expect(readArchive(path.join(dir, "missing.txt"))).rejects.toMatchObject({ code: "ARCHIVE_UNREADABLE" });
      await expect(readArchive(dir)).rejects.toMatchObject({ code: "ARCHIVE_UNREADABLE" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves off the board a past guest only an archive line names, and records only the line count", async () => {
    const plain = await seedShow(db, fakeSeedAgent(), SHOW, 1);
    if (plain.kind !== "done") throw new Error(`expected done, got ${JSON.stringify(plain)}`);
    const plainNames = (await listBoard(db, plain.runId)).map((row) => (row.data as { name: string }).name);
    expect(plainNames).toContain("Synthetic Person 1");

    const archive = parseArchive("E1: Synthetic Person 1 on the early days | \nE2: a solo show | with Nobody Real\n");
    const { qloo } = fakeQloo();
    const agent = seedAgentFrom(db, {
      qloo,
      harness: harnessFrom(qloo).harness,
      model: droppingOnRetry(1),
      feeds: fakeFeeds().feeds,
      trends: false,
      operator: { archive },
    });
    const outcome = await seedShow(db, agent, SHOW, 1);

    if (outcome.kind !== "done") throw new Error(`expected done, got ${JSON.stringify(outcome)}`);
    expect((await listBoard(db, outcome.runId)).map((row) => (row.data as { name: string }).name)).toEqual([2, 3, 4].map((n) => `Synthetic Person ${n}`));
    expect(outcome.pastGuests).toEqual({ checked: true, skipped: 1 });
    const events = await listEventsAfter(db, outcome.runId, 0);
    expect(events.find((event) => event.event === "board")?.data).toMatchObject({ pastGuests: { titles: 2, archiveTitles: 2 } });
    expect(JSON.stringify(events)).not.toContain("early days");
  });
});

describe("ops.ts seed arguments", () => {
  it("readArgs accepts and refuses seed arguments", () => {
    const plain = { hosts: [], archive: undefined };
    expect(readArgs(["seed", "X"])).toEqual({ dev: false, tunnelPort: undefined, command: { name: "seed", show: "X", pick: undefined, ...plain } });
    expect(readArgs(["seed", "X", "--pick", "2"])).toEqual({ dev: false, tunnelPort: undefined, command: { name: "seed", show: "X", pick: 2, ...plain } });
    expect(readArgs(["--tunnel", "55432", "seed", "X", "--pick", "1"])).toEqual({
      dev: false,
      tunnelPort: 55432,
      command: { name: "seed", show: "X", pick: 1, ...plain },
    });
    expect(readArgs(["seed", "TWiST", "--pick", "1", "--host", " Jason Calacanis ", "--host", "Molly Wood", "--archive", "old.txt"])).toEqual({
      dev: false,
      tunnelPort: undefined,
      command: { name: "seed", show: "TWiST", pick: 1, hosts: ["Jason Calacanis", "Molly Wood"], archive: "old.txt" },
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
      ["seed", "X", "--host", "  "],
      ["seed", "X", "--host", "h".repeat(201)],
      ["seed", "X", ...Array.from({ length: 11 }, (_, n) => ["--host", `Host ${n}`]).flat()],
      ["seed", "X", "--archive", " "],
      ["seed", "X", "--archive"],
      ["guesses", "00000000-0000-4000-8000-000000000700", "--host", "Ann Lee"],
      ["briefs", "00000000-0000-4000-8000-000000000700", "--archive", "old.txt"],
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

  it("readArgs accepts guesses with a run id, an optional --yes and an optional --pick, and refuses anything else", () => {
    const runId = "00000000-0000-4000-8000-000000000700";
    expect(readArgs(["guesses", runId])).toEqual({ dev: false, tunnelPort: undefined, command: { name: "guesses", runId, yes: false, pick: undefined } });
    expect(readArgs(["--tunnel", "55432", "guesses", runId, "--yes"])).toEqual({
      dev: false,
      tunnelPort: 55432,
      command: { name: "guesses", runId, yes: true, pick: undefined },
    });

    for (const argv of [["guesses"], ["guesses", runId, "extra"], ["guesses", runId, "--apply"], ["guesses", runId, "--pick", "0"], ["guesses", runId, "--pick", "x"]]) {
      expect(readArgs(argv), argv.join(" ")).toBeUndefined();
    }
  });

  it("readArgs accepts recheck with a run id and the seed's --host and --archive, and refuses anything else", () => {
    const runId = "00000000-0000-4000-8000-000000000700";
    expect(readArgs(["recheck", runId])).toEqual({ dev: false, tunnelPort: undefined, command: { name: "recheck", runId, hosts: [], archive: undefined } });
    expect(readArgs(["--dev", "recheck", runId, "--host", "Ann Lee", "--archive", "old.txt"])).toEqual({
      dev: true,
      tunnelPort: undefined,
      command: { name: "recheck", runId, hosts: ["Ann Lee"], archive: "old.txt" },
    });
    for (const argv of [["recheck"], ["recheck", runId, "extra"], ["recheck", runId, "--yes"], ["recheck", runId, "--pick", "1"], ["recheck", runId, "--apply"]]) {
      expect(readArgs(argv), argv.join(" ")).toBeUndefined();
    }
  });
});
