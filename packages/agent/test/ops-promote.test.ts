// Covers the operator's showcase commands in src/ops/promote.ts on PGlite,
// which runs as its owner: the preview, promotion and its refusals including
// a missing brief, moving a run, unpromoting, the list, isPromoted, reading a
// run's briefs (a deferred claim written through seed's writeBriefs with a
// fake runner), and the terminal formatting. It does not cover the app role
// being refused writes (server-runs.test.ts), two operators promoting at once
// on hosted Postgres (PGlite has one connection, so the table lock never
// waits), or the argument parsing and exit codes of scripts/ops.ts (its
// --dev selftest runs those).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatBriefs,
  formatPreview,
  formatPromoted,
  isPromoted,
  isWritable,
  listPromoted,
  previewRun,
  PromoteError,
  promoteRun,
  readBriefs,
  unpromoteRun,
} from "../src/ops/promote.js";
import { writeBriefs } from "../src/ops/seed.js";
import {
  claimBrief,
  createRun,
  getBriefClaim,
  listShowcase,
  markBriefDone,
  markBriefFailed,
  putBoard,
  putBrief,
  setRunStatus,
  type RunStatus,
} from "../src/server/runs.js";
import type { Db } from "../src/store/db.js";
import { storeBriefs, syntheticBrief } from "./helpers/briefs.js";
import { migratedPglite } from "./helpers/pglite.js";

const NOW = new Date("2026-10-19T12:00:00.000Z");

let db: Db;

beforeEach(async () => {
  db = await migratedPglite();
});

afterEach(async () => {
  await db.close();
});

// Synthetic guests in the shape the agent runner stores (C7.3).
const guest = (n: number, overrides: Record<string, unknown> = {}) => ({
  personId: `00000000-0000-4000-8000-0000000005${String(n).padStart(2, "0")}`,
  name: `Synthetic Guest ${n}`,
  fit: n / 100,
  fitKnown: true,
  fitRank: n,
  reach: "bookable",
  rising: { state: "rising", points: 2.5 },
  bringsNew: { segment: "age", label: "listeners 25 to 29", gap: 0.3 },
  sharedTags: ["synthetic taste"],
  angle: "A synthetic angle.",
  showName: "Synthetic Show",
  ...overrides,
});

// Every guest gets a brief unless `briefs` says how many of the first ones do.
async function runWith(
  status: RunStatus,
  guests: unknown[],
  opts: { briefs?: number } = {},
): Promise<{ runId: string; guestIds: string[] }> {
  const runId = await createRun(db, { show: "Synthetic Show", exclude: [] }, NOW);
  await setRunStatus(db, runId, "running", undefined, NOW);
  const guestIds = await putBoard(db, runId, guests);
  await storeBriefs(db, runId, guestIds.slice(0, opts.briefs ?? guestIds.length));
  if (status === "done" || status === "failed") {
    await setRunStatus(db, runId, status, status === "failed" ? "QLOO_LIMIT" : undefined, NOW);
  }
  return { runId, guestIds };
}

async function showcaseRows(): Promise<Array<{ runId: string; position: number }>> {
  const { rows } = await db.query<{ runId: string; position: number }>(
    'SELECT run_id::text AS "runId", position FROM showcase_runs ORDER BY position',
  );
  return rows;
}

async function refusalOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof PromoteError ? error.code : String(error);
  }
  return undefined;
}

describe("previewRun", () => {
  it("shows the status, show and whole board, keeps an unreadable row in its place, and changes nothing", async () => {
    const { runId, guestIds } = await runWith("done", [guest(1), guest(2), guest(3), guest(4, { name: "" })]);

    const preview = await previewRun(db, runId);

    expect(preview).toMatchObject({ runId, status: "done", showName: "Synthetic Show", refusal: null });
    expect(preview.board.map((row) => [row.id, row.rank, row.guest?.name ?? null])).toEqual([
      [guestIds[0], 1, "Synthetic Guest 1"],
      [guestIds[1], 2, "Synthetic Guest 2"],
      [guestIds[2], 3, "Synthetic Guest 3"],
      [guestIds[3], 4, null],
    ]);
    expect(await showcaseRows()).toEqual([]);
  });

  it("gives the refusal promote would give, and refuses a missing run or a re-spelled id", async () => {
    const running = await runWith("running", [guest(1), guest(2), guest(3)]);
    const small = await runWith("done", [guest(1), guest(2)]);
    const gap = await runWith("done", [guest(1), guest(2, { showName: "" }), guest(3), guest(4)]);

    expect((await previewRun(db, running.runId)).refusal).toBe("PROMOTE_NOT_DONE");
    expect((await previewRun(db, small.runId)).refusal).toBe("PROMOTE_BOARD_TOO_SMALL");
    expect((await previewRun(db, gap.runId)).refusal).toBe("PROMOTE_BOARD_UNREADABLE");
    expect(await refusalOf(previewRun(db, crypto.randomUUID()))).toBe("PROMOTE_NOT_FOUND");
    expect(await refusalOf(previewRun(db, running.runId.toUpperCase()))).toBe("PROMOTE_BAD_RUN_ID");
    expect(await refusalOf(previewRun(db, "1; DROP TABLE runs"))).toBe("PROMOTE_BAD_RUN_ID");
  });
});

describe("promoteRun (C6.3)", () => {
  it("refuses a running run, a failed run, a run with 2 guests and a board whose top 3 do not read back, changing nothing", async () => {
    const running = await runWith("running", [guest(1), guest(2), guest(3)]);
    const failed = await runWith("failed", [guest(1), guest(2), guest(3)]);
    const two = await runWith("done", [guest(1), guest(2)]);
    const broken = await runWith("done", [guest(1), guest(2), guest(3, { extra: "field" })]);

    expect(await refusalOf(promoteRun(db, running.runId, 1))).toBe("PROMOTE_NOT_DONE");
    expect(await refusalOf(promoteRun(db, failed.runId, 1))).toBe("PROMOTE_NOT_DONE");
    expect(await refusalOf(promoteRun(db, two.runId, 1))).toBe("PROMOTE_BOARD_TOO_SMALL");
    expect(await refusalOf(promoteRun(db, broken.runId, 1))).toBe("PROMOTE_BOARD_UNREADABLE");
    expect(await refusalOf(promoteRun(db, crypto.randomUUID(), 1))).toBe("PROMOTE_NOT_FOUND");
    expect(await showcaseRows()).toEqual([]);
  });

  it("refuses a position outside 1 to 12 and accepts 12", async () => {
    const { runId } = await runWith("done", [guest(1), guest(2), guest(3)]);

    for (const position of [0, 13, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await refusalOf(promoteRun(db, runId, position)), String(position)).toBe("PROMOTE_BAD_POSITION");
    }
    expect(await showcaseRows()).toEqual([]);

    await promoteRun(db, runId, 12);
    expect(await showcaseRows()).toEqual([{ runId, position: 12 }]);
  });

  it("puts a done run on the home page and moves it to a new position", async () => {
    const { runId, guestIds } = await runWith("done", [guest(1), guest(2), guest(3), guest(4)]);

    await promoteRun(db, runId, 3);
    expect(await showcaseRows()).toEqual([{ runId, position: 3 }]);
    const [shown] = await listShowcase(db);
    expect(shown).toMatchObject({ runId, position: 3, showName: "Synthetic Show" });
    expect(shown?.guests.map((entry) => entry.id)).toEqual(guestIds.slice(0, 3));

    await promoteRun(db, runId, 1);
    expect(await showcaseRows()).toEqual([{ runId, position: 1 }]);
    await promoteRun(db, runId, 1);
    expect(await showcaseRows()).toEqual([{ runId, position: 1 }]);
  });

  it("refuses a run until every board guest has a brief that reads back, and names that in the preview", async () => {
    const { runId, guestIds } = await runWith("done", [guest(1), guest(2), guest(3)], { briefs: 1 });
    expect(await putBrief(db, runId, guestIds[1]!, { text: "not a brief" })).toBe(true);

    expect((await previewRun(db, runId)).refusal).toBe("PROMOTE_BRIEFS_MISSING");
    expect(await refusalOf(promoteRun(db, runId, 1))).toBe("PROMOTE_BRIEFS_MISSING");
    expect(await showcaseRows()).toEqual([]);
    const lines = formatPreview(await previewRun(db, runId));
    expect(lines.filter((line) => line.startsWith("       brief: "))).toEqual([
      "       brief: written",
      "       brief: not written",
      "       brief: not written",
    ]);
    expect(lines.at(-1)).toBe(
      "  This run cannot go on the home page. Every board guest needs a written brief first: run ops briefs on this run with --yes, read every brief it prints, then promote.",
    );

    const fixed = await runWith("done", [guest(1), guest(2), guest(3)], { briefs: 2 });
    expect(await refusalOf(promoteRun(db, fixed.runId, 1))).toBe("PROMOTE_BRIEFS_MISSING");
    await putBrief(db, fixed.runId, fixed.guestIds[2]!, syntheticBrief(3));
    await promoteRun(db, fixed.runId, 1);
    expect(await showcaseRows()).toEqual([{ runId: fixed.runId, position: 1 }]);
  });

  it("refuses a position another run holds and leaves that run where it is", async () => {
    const first = await runWith("done", [guest(1), guest(2), guest(3)]);
    const second = await runWith("done", [guest(4), guest(5), guest(6)]);
    await promoteRun(db, first.runId, 1);
    await promoteRun(db, second.runId, 2);

    expect(await refusalOf(promoteRun(db, second.runId, 1))).toBe("PROMOTE_POSITION_TAKEN");
    expect(await showcaseRows()).toEqual([
      { runId: first.runId, position: 1 },
      { runId: second.runId, position: 2 },
    ]);
  });
});

describe("unpromoteRun and listPromoted", () => {
  it("lists promoted runs by position, takes one off, and refuses a run that is not promoted", async () => {
    const first = await runWith("done", [guest(1), guest(2), guest(3)]);
    const second = await runWith("done", [guest(4), guest(5), guest(6)]);
    await promoteRun(db, second.runId, 2);
    await promoteRun(db, first.runId, 5);

    const promoted = await listPromoted(db);
    expect(promoted.map((run) => [run.runId, run.position])).toEqual([
      [second.runId, 2],
      [first.runId, 5],
    ]);
    for (const run of promoted) expect(Number.isFinite(run.promotedAt.getTime())).toBe(true);

    expect(await isPromoted(db, second.runId)).toBe(true);
    expect(await unpromoteRun(db, second.runId)).toBe(2);
    expect(await isPromoted(db, second.runId)).toBe(false);
    expect((await listPromoted(db)).map((run) => run.runId)).toEqual([first.runId]);
    expect((await listShowcase(db)).map((run) => run.runId)).toEqual([first.runId]);
    expect(await refusalOf(unpromoteRun(db, second.runId))).toBe("PROMOTE_NOT_PROMOTED");
    expect(await refusalOf(unpromoteRun(db, "not-a-uuid"))).toBe("PROMOTE_BAD_RUN_ID");
    expect(await listPromoted(db)).toHaveLength(1);
  });
});

describe("terminal formatting", () => {
  it("replaces control and direction characters in stored text, so a name cannot drive the terminal", async () => {
    const hostile = "Guest\u001b[2J\u001b]0;owned\u0007‮evil\u009b31m";
    const { runId } = await runWith("done", [guest(1, { name: hostile, angle: "line one\nline two" }), guest(2), guest(3)]);
    await promoteRun(db, runId, 1);

    const lines = [...formatPreview(await previewRun(db, runId)), ...formatPromoted(await listPromoted(db), await listShowcase(db))];

    const text = lines.join("\n");
    expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/u);
    expect(text).toContain("Guest�[2J");
    expect(text).toContain("line one�line two");
    expect(lines).toContain("  The home page would show the first 3.");
  });

  it("names the refusal and marks a promoted run the home page does not show", async () => {
    const small = await runWith("done", [guest(1), guest(2)]);
    expect(formatPreview(await previewRun(db, small.runId)).at(-1)).toBe(
      "  This run cannot go on the home page. Only a run whose board has at least 3 guests can go on the home page.",
    );

    await db.query("INSERT INTO showcase_runs (run_id, position, promoted_at) VALUES ($1::uuid, 4, $2::timestamptz)", [
      small.runId,
      NOW.toISOString(),
    ]);
    expect(formatPromoted(await listPromoted(db), await listShowcase(db))).toEqual([
      "Promoted runs, 1 of 12 positions used:",
      `    4. ${small.runId}  not shown: the run is not done or its top guests do not read back cleanly`,
    ]);
    expect(formatPromoted([], [])).toEqual(["Nothing is promoted, so the home page shows no example runs."]);
  });

  it("prints every brief in full with its labels, and why each missing one is missing, with control characters replaced", async () => {
    const hostile = "Guest\u001b[2J‮evil";
    const { runId, guestIds } = await runWith("done", [guest(1, { name: hostile }), guest(2), guest(3), guest(4), guest(5)], { briefs: 0 });
    const [written, none, retry, failed, pending] = guestIds as [string, string, string, string, string];
    await putBrief(db, runId, written, {
      ...syntheticBrief(1),
      why: "Why text\u001b]0;owned\u0007",
      pitch_body: "Line one\nLine two",
      removed: { links: 1, emails: 0 },
    });
    await claimBrief(db, runId, retry, 5, NOW);
    await markBriefFailed(db, runId, retry, "MODEL_TIMEOUT");
    await claimBrief(db, runId, failed, 5, NOW);
    await markBriefFailed(db, runId, failed, "MODEL_TIMEOUT");
    await claimBrief(db, runId, failed, 5, NOW);
    await markBriefFailed(db, runId, failed, "AGENT_BAD_PROSE");
    await claimBrief(db, runId, pending, 5, NOW);
    const briefs = await readBriefs(db, runId);
    expect(briefs.guests.find((entry) => entry.id === none)?.state).toEqual({ kind: "none" });

    const full = formatBriefs(briefs, { full: true });
    const listed = formatBriefs(briefs, { full: false });

    expect(full).toEqual([
      `Briefs for run ${runId}, Synthetic Show: 1 of 5 guests have a written brief.`,
      "     1. Guest�[2J�evil",
      "        Why: Why text�]0;owned�",
      "        Angle: A synthetic angle.",
      "        Questions:",
      "          1. One?",
      "          2. Two?",
      "          3. Three?",
      "          4. Four?",
      "          5. Five?",
      "        Pitch subject: A synthetic pitch",
      "        Pitch body:",
      "          Line one",
      "          Line two",
      "        Removed from the draft: 1 link and 0 email addresses.",
      "     2. Synthetic Guest 2: no brief yet.",
      "     3. Synthetic Guest 3: failed once with MODEL_TIMEOUT, so it has one attempt left.",
      "     4. Synthetic Guest 4: failed on both attempts, last with AGENT_BAD_PROSE, so this run can never get its brief.",
      "     5. Synthetic Guest 5: a writer holds its claim. If nothing is writing it, a restart of the agent server frees it.",
    ]);
    expect(listed).toEqual([full[0], ...full.slice(-4)]);
    expect(full.join("\n")).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/u);
  });
});

describe("a brief a budget refused (audit A1-9)", () => {
  it("reads a deferred claim as no brief yet, on attempt 1 or 2, and the briefs command writes it", async () => {
    const { runId, guestIds } = await runWith("done", [guest(1), guest(2), guest(3)], { briefs: 0 });
    const [firstTry, secondTry, untouched] = guestIds as [string, string, string];
    await claimBrief(db, runId, firstTry, 5, NOW);
    await markBriefFailed(db, runId, firstTry, "MODEL_BUDGET");
    await claimBrief(db, runId, secondTry, 5, NOW);
    await markBriefFailed(db, runId, secondTry, "MODEL_TIMEOUT");
    await claimBrief(db, runId, secondTry, 5, NOW);
    await markBriefFailed(db, runId, secondTry, "QLOO_BUDGET");

    const before = await readBriefs(db, runId);
    expect(before.guests.map((entry) => entry.state)).toEqual([{ kind: "none" }, { kind: "none" }, { kind: "none" }]);
    expect(before.guests.every((entry) => isWritable(entry.state))).toBe(true);
    expect(formatBriefs(before, { full: false }).slice(1)).toEqual([
      "     1. Synthetic Guest 1: no brief yet.",
      "     2. Synthetic Guest 2: no brief yet.",
      "     3. Synthetic Guest 3: no brief yet.",
    ]);

    const written: string[] = [];
    const runner = {
      ready: true,
      writeBrief: async (id: string, guestId: string) => {
        written.push(guestId);
        await putBrief(db, id, guestId, syntheticBrief(1));
        await markBriefDone(db, id, guestId);
      },
    };
    const after = await writeBriefs(db, runner, runId);

    expect([...written].sort()).toEqual([firstTry, secondTry, untouched].sort());
    expect(after.guests.map((entry) => entry.state.kind)).toEqual(["written", "written", "written"]);
    expect(await getBriefClaim(db, runId, firstTry)).toEqual({ status: "done", attempts: 1, errorCode: null });
    expect(await getBriefClaim(db, runId, secondTry)).toEqual({ status: "done", attempts: 2, errorCode: null });
  });
});
