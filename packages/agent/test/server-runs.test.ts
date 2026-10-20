// Covers the run store on PGlite: ids, status rules, events, candidates, the
// board, briefs, brief claims and their one retry, the restart sweeps for
// runs and brief claims, the home-page showcase, including the app role's
// grants on showcase_runs and run_brief_claims (roles.sql applied to
// PGlite), and the surface a
// run is charged to with the reads that act only for the key that made a
// run. It does not cover races between separate
// connections (PGlite has one), the other vasal_app grants, the shapes of
// candidate and brief data (the routes and the agent own those), or the HTTP
// routes that call these functions.
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueToken } from "../src/mcp/tokens.js";
import { ServerError } from "../src/server/errors.js";
import {
  appendEvent,
  claimBrief,
  createRun,
  failInterruptedRuns,
  failStaleBriefClaims,
  getBoardGuest,
  getBrief,
  getBriefClaim,
  getCandidate,
  getCandidateForToken,
  getRun,
  getRunForToken,
  listEventsAfter,
  listShowcase,
  markBriefDone,
  markBriefFailed,
  parseBoardGuest,
  putBoard,
  putBrief,
  putCandidates,
  setRunStatus,
  type RunEventName,
  type RunInput,
  type RunOrigin,
  type RunStatus,
} from "../src/server/runs.js";
import type { Db } from "../src/store/db.js";
import { StoreError } from "../src/store/errors.js";
import { migratedPglite } from "./helpers/pglite.js";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const LATER = new Date("2026-10-19T12:05:00.000Z");
const INPUT: RunInput = { show: "Lex Fridman Podcast", exclude: ["Elon Musk"] };
const MARKER = "MARKER-51c0de";
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let db: Db;

beforeEach(async () => {
  db = await migratedPglite();
});

afterEach(async () => {
  await db.close();
});

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ServerError) {
      expect(error.message).not.toContain(MARKER);
      return error.code;
    }
    return String(error);
  }
  return undefined;
}

async function runIn(status: RunStatus): Promise<string> {
  const id = await createRun(db, INPUT, NOW);
  if (status === "queued") return id;
  if (status === "done" || status === "failed") {
    await setRunStatus(db, id, "running", undefined, NOW);
  }
  await setRunStatus(db, id, status, status === "failed" ? "QLOO_LIMIT" : undefined, NOW);
  return id;
}

async function rowCount(table: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0]!.n;
}

function recordingDb(): { db: Db; calls: string[] } {
  const calls: string[] = [];
  const self: Db = {
    query: async (text) => {
      calls.push(text);
      return { rows: [] };
    },
    transaction: (fn) => fn(self),
    close: async () => {},
  };
  return { db: self, calls };
}

describe("createRun and getRun", () => {
  it("issues a random v4 id and reads the run back (C6.1)", async () => {
    const id = await createRun(db, INPUT, NOW);
    const other = await createRun(db, INPUT, NOW);

    expect(id).toMatch(V4);
    expect(other).toMatch(V4);
    expect(other).not.toBe(id);
    expect(await getRun(db, id)).toEqual({
      id,
      status: "queued",
      input: INPUT,
      errorCode: null,
      createdAt: NOW,
      finishedAt: null,
      surface: "web",
      tokenId: null,
    });
  });

  it("stores hostile show text as data, never as SQL (C6.6)", async () => {
    const show = `${MARKER}'); DROP TABLE runs; --`;
    const id = await createRun(db, { show, exclude: ["$1", "' OR '1'='1"] }, NOW);

    expect((await getRun(db, id))?.input).toEqual({ show, exclude: ["$1", "' OR '1'='1"] });
    expect(await rowCount("runs")).toBe(1);
  });

  it("refuses input outside its limits and writes nothing", async () => {
    for (const input of [
      { show: "", exclude: [] },
      { show: "x".repeat(301), exclude: [] },
      { show: "x", exclude: Array.from({ length: 26 }, () => "y") },
      { show: "x", exclude: ["y".repeat(101)] },
      { show: "x", exclude: [""] },
      { show: "x", exclude: [], url: "http://127.0.0.1/" },
      { show: 5, exclude: [] },
      { show: "x" },
    ]) {
      expect(await codeOf(createRun(db, input as unknown as RunInput, NOW))).toBe("SRV_BAD_INPUT");
    }
    expect(await createRun(db, { show: "x".repeat(300), exclude: Array.from({ length: 25 }, () => "y".repeat(100)) }, NOW)).toMatch(V4);
    expect(await rowCount("runs")).toBe(1);
  });

  it("gives null for a non-UUID id without querying", async () => {
    const { db: recording, calls } = recordingDb();
    for (const id of ["", "1", "abc", `${MARKER}' OR 1=1 --`, "00000000-0000-0000-0000-00000000000g"]) {
      expect(await getRun(recording, id)).toBeNull();
    }
    expect(calls).toHaveLength(0);
  });

  it("gives null for an id never issued and for another spelling of a real one", async () => {
    const id = await createRun(db, INPUT, NOW);

    expect(await getRun(db, "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b")).toBeNull();
    expect(await getRun(db, id.toUpperCase())).toBeNull();
    expect(await getRun(db, `{${id}}`)).toBeNull();
  });

  it("reads a row that fails the run schema as missing (C6.5)", async () => {
    const insert = `INSERT INTO runs (id, status, input, error_code, created_at, finished_at)
                    VALUES ($1::uuid, $2, $3::text::json, $4, $5::timestamptz, $6::timestamptz)`;
    const cases: Array<[string, string, string | null, string | null]> = [
      ["queued", '{"show":5,"exclude":[]}', null, null],
      ["queued", '{"show":"x","exclude":[],"url":"http://127.0.0.1/"}', null, null],
      ["done", '{"show":"x","exclude":[]}', null, null],
      ["running", '{"show":"x","exclude":[]}', null, NOW.toISOString()],
      ["queued", '{"show":"x","exclude":[]}', "QLOO_LIMIT", null],
      ["failed", '{"show":"x","exclude":[]}', `${MARKER} free text`, NOW.toISOString()],
    ];
    for (const [status, input, errorCode, finishedAt] of cases) {
      const id = crypto.randomUUID();
      await db.query(insert, [id, status, input, errorCode, NOW.toISOString(), finishedAt]);
      expect(await getRun(db, id)).toBeNull();
    }
  });

  it("reports a database failure as SRV_UNAVAILABLE with a fixed message", async () => {
    const failing: Db = {
      query: () => Promise.reject(new Error(MARKER)),
      transaction: () => Promise.reject(new Error(MARKER)),
      close: async () => {},
    };
    expect(await codeOf(createRun(failing, INPUT, NOW))).toBe("SRV_UNAVAILABLE");
    expect(await codeOf(getRun(failing, crypto.randomUUID()))).toBe("SRV_UNAVAILABLE");
    expect(await codeOf(appendEvent(failing, crypto.randomUUID(), "step", {}, NOW))).toBe("SRV_UNAVAILABLE");
  });
});

describe("setRunStatus", () => {
  it("moves an open run and sets finished_at only on done or failed", async () => {
    const id = await createRun(db, INPUT, NOW);

    await setRunStatus(db, id, "awaiting_confirm", undefined, LATER);
    expect(await getRun(db, id)).toMatchObject({ status: "awaiting_confirm", finishedAt: null });

    await setRunStatus(db, id, "running", undefined, LATER);
    await setRunStatus(db, id, "done", undefined, LATER);
    expect(await getRun(db, id)).toMatchObject({ status: "done", errorCode: null, finishedAt: LATER });

    const failed = await createRun(db, INPUT, NOW);
    await setRunStatus(db, failed, "failed", "TURN_CAP", LATER);
    expect(await getRun(db, failed)).toMatchObject({ status: "failed", errorCode: "TURN_CAP", finishedAt: LATER });
  });

  it("never changes a terminal run again", async () => {
    const done = await runIn("done");
    const failed = await runIn("failed");

    for (const status of ["queued", "awaiting_confirm", "running", "done", "failed"] as const) {
      expect(await codeOf(setRunStatus(db, done, status, undefined, LATER))).toBe("SRV_NOT_FOUND");
      expect(await codeOf(setRunStatus(db, failed, status, undefined, LATER))).toBe("SRV_NOT_FOUND");
    }
    expect(await getRun(db, done)).toMatchObject({ status: "done", errorCode: null, finishedAt: NOW });
    expect(await getRun(db, failed)).toMatchObject({ status: "failed", errorCode: "QLOO_LIMIT", finishedAt: NOW });
  });

  it("refuses bad ids, statuses and error codes", async () => {
    const id = await createRun(db, INPUT, NOW);

    expect(await codeOf(setRunStatus(db, "nope", "done"))).toBe("SRV_BAD_INPUT");
    expect(await codeOf(setRunStatus(db, id, "paused" as RunStatus))).toBe("SRV_BAD_INPUT");
    expect(await codeOf(setRunStatus(db, id, "done", "QLOO_LIMIT"))).toBe("SRV_BAD_INPUT");
    expect(await codeOf(setRunStatus(db, id, "failed", `${MARKER} <b>text</b>`))).toBe("SRV_BAD_INPUT");
    expect(await codeOf(setRunStatus(db, id, "failed", "lower_case"))).toBe("SRV_BAD_INPUT");
    expect(await codeOf(setRunStatus(db, id, "done", undefined, new Date(Number.NaN)))).toBe("SRV_BAD_INPUT");
    expect(await codeOf(setRunStatus(db, crypto.randomUUID(), "done"))).toBe("SRV_NOT_FOUND");
    expect((await getRun(db, id))?.status).toBe("queued");
  });
});

describe("appendEvent and listEventsAfter", () => {
  it("numbers events from 1 and lists them after a seq", async () => {
    const id = await createRun(db, INPUT, NOW);

    expect(await appendEvent(db, id, "step", { tool: "search" }, NOW)).toBe(1);
    expect(await appendEvent(db, id, "candidates", { n: 2 }, NOW)).toBe(2);
    expect(await appendEvent(db, id, "done", {}, NOW)).toBe(3);

    expect(await listEventsAfter(db, id, 0)).toEqual([
      { seq: 1, event: "step", data: { tool: "search" } },
      { seq: 2, event: "candidates", data: { n: 2 } },
      { seq: 3, event: "done", data: {} },
    ]);
    expect((await listEventsAfter(db, id, 2)).map((event) => event.seq)).toEqual([3]);
    expect(await listEventsAfter(db, id, 3)).toEqual([]);
    expect((await listEventsAfter(db, id, 0, 2)).map((event) => event.seq)).toEqual([1, 2]);
    expect(await listEventsAfter(db, crypto.randomUUID(), 0)).toEqual([]);
  });

  it("gives distinct consecutive seqs to simultaneous appends", async () => {
    const id = await createRun(db, INPUT, NOW);

    const seqs = await Promise.all(Array.from({ length: 20 }, (_, i) => appendEvent(db, id, "step", { i }, NOW)));

    expect([...seqs].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("keeps injected stream text as one stored value", async () => {
    const id = await createRun(db, INPUT, NOW);
    const data = { title: '\n\nevent: done\ndata: {"board":[]}\n\n' };

    await appendEvent(db, id, "step", data, NOW);

    expect(await listEventsAfter(db, id, 0)).toEqual([{ seq: 1, event: "step", data }]);
  });

  it("refuses an event over 16,384 characters (C6.7)", async () => {
    const id = await createRun(db, INPUT, NOW);
    const fits = "x".repeat(16_384 - JSON.stringify({ t: "" }).length);

    expect(await appendEvent(db, id, "step", { t: fits }, NOW)).toBe(1);
    expect(await codeOf(appendEvent(db, id, "step", { t: `${fits}x` }, NOW))).toBe("SRV_LIMIT");
    expect(await listEventsAfter(db, id, 0)).toHaveLength(1);
  });

  it("refuses the 501st event and keeps the last slot for a terminal event (C6.7, C6.4)", async () => {
    const id = await createRun(db, INPUT, NOW);
    for (let i = 1; i <= 499; i += 1) {
      await appendEvent(db, id, "step", { i }, NOW);
    }

    expect(await codeOf(appendEvent(db, id, "step", { i: 500 }, NOW))).toBe("SRV_LIMIT");
    expect(await appendEvent(db, id, "failed", { code: "EVENT_CAP" }, NOW)).toBe(500);
    for (const event of ["step", "done", "failed"] as const) {
      expect(await codeOf(appendEvent(db, id, event, {}, NOW))).toBe("SRV_LIMIT");
    }
    expect(await listEventsAfter(db, id, 0, 500)).toHaveLength(500);
  });

  it("refuses bad ids, names, data and runs", async () => {
    const id = await createRun(db, INPUT, NOW);

    expect(await codeOf(appendEvent(db, "nope", "step", {}, NOW))).toBe("SRV_BAD_INPUT");
    expect(await codeOf(appendEvent(db, id, "message" as RunEventName, {}, NOW))).toBe("SRV_BAD_INPUT");
    expect(await codeOf(appendEvent(db, id, "step", undefined, NOW))).toBe("SRV_BAD_INPUT");
    expect(await codeOf(appendEvent(db, id, "step", 10n, NOW))).toBe("SRV_BAD_INPUT");
    expect(await codeOf(appendEvent(db, crypto.randomUUID(), "step", {}, NOW))).toBe("SRV_NOT_FOUND");
    expect(await rowCount("run_events")).toBe(0);
  });

  it("refuses bad list arguments and defaults to 100 events a page", async () => {
    const id = await createRun(db, INPUT, NOW);
    for (let i = 0; i < 120; i += 1) await appendEvent(db, id, "step", { i }, NOW);

    expect(await listEventsAfter(db, id, 0)).toHaveLength(100);
    expect(await listEventsAfter(db, id, 0, 500)).toHaveLength(120);
    for (const [after, limit] of [
      [-1, 10],
      [1.5, 10],
      [Number.NaN, 10],
      [0, 0],
      [0, 501],
      [0, 2.5],
    ] as const) {
      expect(await codeOf(listEventsAfter(db, id, after, limit))).toBe("SRV_BAD_INPUT");
    }
    expect(await codeOf(listEventsAfter(db, "nope", 0))).toBe("SRV_BAD_INPUT");
  });

  it("skips a stored event that fails the event schema (C6.5)", async () => {
    const id = await createRun(db, INPUT, NOW);
    await appendEvent(db, id, "step", { ok: 1 }, NOW);
    await db.query(
      `INSERT INTO run_events (run_id, seq, event, data, created_at)
       VALUES ($1::uuid, 2, 'message', '{}'::json, now()), ($1::uuid, 3, 'step', $2::text::json, now())`,
      [id, JSON.stringify({ t: "x".repeat(16_400) })],
    );
    await appendEvent(db, id, "done", {}, NOW);

    expect((await listEventsAfter(db, id, 0)).map((event) => event.seq)).toEqual([1, 4]);
  });
});

describe("candidates and the board (C6.2)", () => {
  it("issues one id per candidate and matches on both the run and the candidate", async () => {
    const run = await createRun(db, INPUT, NOW);
    const other = await createRun(db, INPUT, NOW);
    const ids = await putCandidates(db, run, [{ name: "A" }, { name: "B" }, { name: "C" }]);
    const [otherId] = await putCandidates(db, other, [{ name: "Z" }]);

    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(V4);
    expect(await getCandidate(db, run, ids[1]!)).toEqual({ name: "B" });

    expect(await getCandidate(db, run, otherId!)).toBeNull();
    expect(await getCandidate(db, other, ids[0]!)).toBeNull();
    expect(await getCandidate(db, run, crypto.randomUUID())).toBeNull();
    expect(await getCandidate(db, run, "https://evil.example/feed.xml")).toBeNull();
    expect(await getCandidate(db, run, ids[0]!.toUpperCase())).toBeNull();
    expect(await getCandidate(db, "nope", ids[0]!)).toBeNull();
  });

  it("allows one candidate list of at most 10 per run", async () => {
    const run = await createRun(db, INPUT, NOW);

    expect(await codeOf(putCandidates(db, run, Array.from({ length: 11 }, (_, i) => ({ i }))))).toBe("SRV_LIMIT");
    expect(await putCandidates(db, run, Array.from({ length: 10 }, (_, i) => ({ i })))).toHaveLength(10);
    expect(await codeOf(putCandidates(db, run, [{ i: 11 }]))).toBe("SRV_LIMIT");
    expect(await codeOf(putCandidates(db, run, [{ t: "x".repeat(16_400) }]))).toBe("SRV_LIMIT");
    expect(await codeOf(putCandidates(db, crypto.randomUUID(), [{ i: 1 }]))).toBe("SRV_NOT_FOUND");
    expect(await codeOf(putCandidates(db, "nope", [{ i: 1 }]))).toBe("SRV_BAD_INPUT");
    expect(await codeOf(putCandidates(db, run, "x" as unknown as unknown[]))).toBe("SRV_BAD_INPUT");
    expect(await rowCount("run_candidates")).toBe(10);
  });

  it("ranks the board 1 to n in order and matches guests on both ids", async () => {
    const run = await createRun(db, INPUT, NOW);
    const other = await createRun(db, INPUT, NOW);
    const guests = await putBoard(db, run, [{ name: "First" }, { name: "Second" }, { name: "Third" }]);
    const [otherGuest] = await putBoard(db, other, [{ name: "Elsewhere" }]);

    const { rows } = await db.query<{ guest_id: string; rank: number }>(
      "SELECT guest_id::text AS guest_id, rank FROM run_board WHERE run_id = $1::uuid ORDER BY rank",
      [run],
    );
    expect(rows).toEqual(guests.map((guest_id, i) => ({ guest_id, rank: i + 1 })));
    expect(await getBoardGuest(db, run, guests[2]!)).toEqual({ name: "Third" });

    expect(await getBoardGuest(db, run, otherGuest!)).toBeNull();
    expect(await getBoardGuest(db, run, crypto.randomUUID())).toBeNull();
    expect(await getBoardGuest(db, run, "Second")).toBeNull();
    expect(await getBoardGuest(db, "nope", guests[0]!)).toBeNull();
  });

  it("allows one board of at most 50 guests per run", async () => {
    const run = await createRun(db, INPUT, NOW);

    expect(await codeOf(putBoard(db, run, Array.from({ length: 51 }, (_, i) => ({ i }))))).toBe("SRV_LIMIT");
    expect(await putBoard(db, run, Array.from({ length: 50 }, (_, i) => ({ i })))).toHaveLength(50);
    expect(await codeOf(putBoard(db, run, [{ i: 51 }]))).toBe("SRV_LIMIT");
    expect(await rowCount("run_board")).toBe(50);
  });

  it("reads a stored item that is not JSON within its limit as missing (C6.5)", async () => {
    const run = await createRun(db, INPUT, NOW);
    const id = crypto.randomUUID();
    await db.query("INSERT INTO run_candidates (run_id, candidate_id, rank, data) VALUES ($1::uuid, $2::uuid, 1, $3::text::json)", [
      run,
      id,
      JSON.stringify({ t: "x".repeat(16_400) }),
    ]);

    expect(await getCandidate(db, run, id)).toBeNull();
  });
});

describe("briefs (C5.8)", () => {
  it("stores one brief per guest per run and keeps the first", async () => {
    const run = await createRun(db, INPUT, NOW);
    const [guest] = await putBoard(db, run, [{ name: "Guest" }]);

    expect(await getBrief(db, run, guest!)).toBeNull();
    expect(await putBrief(db, run, guest!, { text: "first" }, NOW)).toBe(true);
    expect(await putBrief(db, run, guest!, { text: "second" }, LATER)).toBe(false);
    expect(await getBrief(db, run, guest!)).toEqual({ text: "first" });
    expect(await rowCount("run_briefs")).toBe(1);
  });

  it("gives one winner when the same brief is stored twice at once", async () => {
    const run = await createRun(db, INPUT, NOW);
    const [guest] = await putBoard(db, run, [{ name: "Guest" }]);

    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => putBrief(db, run, guest!, { i }, NOW)));

    expect(results.filter((stored) => stored)).toHaveLength(1);
    expect(await rowCount("run_briefs")).toBe(1);
  });

  it("refuses a guest that is not on that run's board", async () => {
    const run = await createRun(db, INPUT, NOW);
    const other = await createRun(db, INPUT, NOW);
    await putBoard(db, run, [{ name: "Guest" }]);
    const [elsewhere] = await putBoard(db, other, [{ name: "Elsewhere" }]);

    expect(await codeOf(putBrief(db, run, elsewhere!, { text: "x" }, NOW))).toBe("SRV_NOT_FOUND");
    expect(await codeOf(putBrief(db, run, crypto.randomUUID(), { text: "x" }, NOW))).toBe("SRV_NOT_FOUND");
    expect(await codeOf(putBrief(db, run, "Guest", { text: "x" }, NOW))).toBe("SRV_BAD_INPUT");
    expect(await getBrief(db, run, elsewhere!)).toBeNull();
    expect(await rowCount("run_briefs")).toBe(0);
  });

  it("refuses a brief over 65,536 characters", async () => {
    const run = await createRun(db, INPUT, NOW);
    const [guest] = await putBoard(db, run, [{ name: "Guest" }]);

    expect(await codeOf(putBrief(db, run, guest!, { t: "x".repeat(65_536) }, NOW))).toBe("SRV_LIMIT");
    expect(await getBrief(db, run, guest!)).toBeNull();
  });
});

describe("brief claims (C5.8)", () => {
  async function claimRow(run: string, guest: string) {
    const { rows } = await db.query(
      "SELECT status, attempts, error_code FROM run_brief_claims WHERE run_id = $1::uuid AND guest_id = $2::uuid",
      [run, guest],
    );
    return rows[0];
  }

  it("claims a guest once, pending with attempts 1, and keeps a done claim done", async () => {
    const run = await createRun(db, INPUT, NOW);
    const [guest] = await putBoard(db, run, [{ name: "Guest" }]);

    expect(await getBriefClaim(db, run, guest!)).toBeNull();
    expect(await claimBrief(db, run, guest!, 5, NOW)).toBe("claimed");
    expect(await claimRow(run, guest!)).toEqual({ status: "pending", attempts: 1, error_code: null });
    expect(await claimBrief(db, run, guest!, 5, NOW)).toBe("exists");

    expect(await markBriefDone(db, run, guest!)).toBe(true);
    expect(await getBriefClaim(db, run, guest!)).toEqual({ status: "done", attempts: 1, errorCode: null });
    expect(await claimBrief(db, run, guest!, 5, NOW)).toBe("exists");
    expect(await markBriefDone(db, run, guest!)).toBe(false);
    expect(await markBriefFailed(db, run, guest!, "MODEL_TIMEOUT")).toBe(false);
    expect((await getBriefClaim(db, run, guest!))?.status).toBe("done");
  });

  it("allows one retry of a failed brief, then answers failed for good", async () => {
    const run = await createRun(db, INPUT, NOW);
    const [guest] = await putBoard(db, run, [{ name: "Guest" }]);
    await claimBrief(db, run, guest!, 5, NOW);

    expect(await markBriefFailed(db, run, guest!, "MODEL_TIMEOUT")).toBe(true);
    expect(await getBriefClaim(db, run, guest!)).toEqual({ status: "failed", attempts: 1, errorCode: "MODEL_TIMEOUT" });

    expect(await claimBrief(db, run, guest!, 5, NOW)).toBe("claimed");
    expect(await claimRow(run, guest!)).toEqual({ status: "pending", attempts: 2, error_code: null });
    expect(await claimBrief(db, run, guest!, 5, NOW)).toBe("exists");

    expect(await markBriefFailed(db, run, guest!, "AGENT_BAD_PROSE")).toBe(true);
    for (let i = 0; i < 3; i += 1) expect(await claimBrief(db, run, guest!, 5, NOW)).toBe("failed");
    expect(await getBriefClaim(db, run, guest!)).toEqual({ status: "failed", attempts: 2, errorCode: "AGENT_BAD_PROSE" });
    expect(await rowCount("run_brief_claims")).toBe(1);
  });

  it("times a retried claim from when it was retried, not from the first attempt", async () => {
    const run = await createRun(db, INPUT, NOW);
    const [guest] = await putBoard(db, run, [{ name: "Guest" }]);
    await claimBrief(db, run, guest!, 5, NOW);
    await markBriefFailed(db, run, guest!, "MODEL_TIMEOUT");

    expect(await claimBrief(db, run, guest!, 5, LATER)).toBe("claimed");

    const { rows } = await db.query<{ created_at: Date }>(
      "SELECT created_at FROM run_brief_claims WHERE run_id = $1::uuid AND guest_id = $2::uuid",
      [run, guest],
    );
    expect(new Date(rows[0]!.created_at)).toEqual(LATER);
  });

  it("gives one winner when a failed brief is re-claimed twice at once", async () => {
    const run = await createRun(db, INPUT, NOW);
    const [guest] = await putBoard(db, run, [{ name: "Guest" }]);
    await claimBrief(db, run, guest!, 5, NOW);
    await markBriefFailed(db, run, guest!, "MODEL_UPSTREAM");

    const results = await Promise.all(Array.from({ length: 4 }, () => claimBrief(db, run, guest!, 5, NOW)));

    expect([...results].sort()).toEqual(["claimed", "exists", "exists", "exists"]);
    expect(await claimRow(run, guest!)).toEqual({ status: "pending", attempts: 2, error_code: null });
  });

  it("counts a retried claim once against the per-run limit", async () => {
    const run = await createRun(db, INPUT, NOW);
    const [first, second] = await putBoard(db, run, [{ name: "First" }, { name: "Second" }]);
    await claimBrief(db, run, first!, 1, NOW);
    await markBriefFailed(db, run, first!, "QLOO_BUDGET");

    expect(await claimBrief(db, run, second!, 1, NOW)).toBe("limit");
    expect(await claimBrief(db, run, first!, 1, NOW)).toBe("claimed");
    expect(await claimBrief(db, run, second!, 1, NOW)).toBe("limit");
  });

  it("refuses free-text codes and bad ids, and moves nothing that is not pending", async () => {
    const run = await createRun(db, INPUT, NOW);
    const [guest, unclaimed] = await putBoard(db, run, [{ name: "Guest" }, { name: "Unclaimed" }]);
    await claimBrief(db, run, guest!, 5, NOW);

    for (const code of [`${MARKER} text`, "lower_case", "", "A".repeat(65)]) {
      expect(await codeOf(markBriefFailed(db, run, guest!, code))).toBe("SRV_BAD_INPUT");
    }
    expect(await codeOf(markBriefDone(db, "nope", guest!))).toBe("SRV_BAD_INPUT");
    expect(await codeOf(markBriefFailed(db, run, "Guest", "MODEL_TIMEOUT"))).toBe("SRV_BAD_INPUT");
    expect(await markBriefFailed(db, run, unclaimed!, "MODEL_TIMEOUT")).toBe(false);
    expect(await markBriefDone(db, run, unclaimed!)).toBe(false);
    expect(await claimRow(run, guest!)).toEqual({ status: "pending", attempts: 1, error_code: null });
    expect(await rowCount("run_brief_claims")).toBe(1);
  });

  it("refuses a third attempt or an unknown status in the table, and reads a bad row as missing without spending (C6.5)", async () => {
    const run = await createRun(db, INPUT, NOW);
    const [guest, odd] = await putBoard(db, run, [{ name: "Guest" }, { name: "Odd" }]);
    const insert = `INSERT INTO run_brief_claims (run_id, guest_id, status, attempts, error_code, created_at)
                    VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::timestamptz)`;

    await expect(db.query(insert, [run, guest, "failed", 3, "X", NOW.toISOString()])).rejects.toThrow();
    await expect(db.query(insert, [run, guest, "retrying", 1, null, NOW.toISOString()])).rejects.toThrow();

    await db.query(insert, [run, odd, "failed", 1, null, NOW.toISOString()]);
    expect(await getBriefClaim(db, run, odd!)).toBeNull();
    expect(await claimBrief(db, run, odd!, 5, NOW)).toBe("exists");
    expect(await claimRow(run, odd!)).toEqual({ status: "failed", attempts: 1, error_code: null });

    const { db: recording, calls } = recordingDb();
    expect(await getBriefClaim(recording, "nope", guest!)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("failInterruptedRuns (C6.4)", () => {
  it("fails every open run with SERVER_RESTART and a failed event, and leaves ended runs alone", async () => {
    const queued = await runIn("queued");
    const awaiting = await runIn("awaiting_confirm");
    const running = await runIn("running");
    const done = await runIn("done");
    const failed = await runIn("failed");
    await appendEvent(db, running, "step", { tool: "search" }, NOW);
    await appendEvent(db, running, "step", { tool: "feed" }, NOW);
    await appendEvent(db, done, "done", {}, NOW);

    expect(await failInterruptedRuns(db, LATER)).toBe(3);

    for (const id of [queued, awaiting, running]) {
      expect(await getRun(db, id)).toMatchObject({ status: "failed", errorCode: "SERVER_RESTART", finishedAt: LATER });
      const events = await listEventsAfter(db, id, 0);
      expect(events.at(-1)).toEqual({ seq: events.length, event: "failed", data: { code: "SERVER_RESTART" } });
    }
    expect((await listEventsAfter(db, running, 0)).map((event) => event.event)).toEqual(["step", "step", "failed"]);

    expect(await getRun(db, done)).toMatchObject({ status: "done", errorCode: null, finishedAt: NOW });
    expect((await listEventsAfter(db, done, 0)).map((event) => event.event)).toEqual(["done"]);
    expect(await getRun(db, failed)).toMatchObject({ status: "failed", errorCode: "QLOO_LIMIT", finishedAt: NOW });
    expect(await listEventsAfter(db, failed, 0)).toEqual([]);

    expect(await codeOf(setRunStatus(db, running, "done", undefined, LATER))).toBe("SRV_NOT_FOUND");
    expect((await getRun(db, running))?.status).toBe("failed");
    expect(await failInterruptedRuns(db, LATER)).toBe(0);
  });

  it("adds no event past 500 to a run whose slots are all used", async () => {
    const id = await createRun(db, INPUT, NOW);
    for (let i = 1; i <= 499; i += 1) await appendEvent(db, id, "step", { i }, NOW);
    await appendEvent(db, id, "done", {}, NOW);

    expect(await failInterruptedRuns(db, LATER)).toBe(1);

    expect(await getRun(db, id)).toMatchObject({ status: "failed", errorCode: "SERVER_RESTART" });
    expect(await rowCount("run_events")).toBe(500);
  });
});

describe("failStaleBriefClaims (C6.4)", () => {
  const MINUTE = 60_000;
  const ago = (ms: number) => new Date(NOW.getTime() - ms);

  it("fails only pending claims created before the cutoff, with SERVER_RESTART, and leaves their retry open", async () => {
    const run = await createRun(db, INPUT, NOW);
    const [old, atLimit, recent, doneOld, failedOld] = await putBoard(db, run, [1, 2, 3, 4, 5].map((n) => ({ n })));
    await claimBrief(db, run, old!, 10, ago(10 * MINUTE));
    await claimBrief(db, run, atLimit!, 10, ago(5 * MINUTE));
    await claimBrief(db, run, recent!, 10, ago(MINUTE));
    await claimBrief(db, run, doneOld!, 10, ago(10 * MINUTE));
    await markBriefDone(db, run, doneOld!);
    await claimBrief(db, run, failedOld!, 10, ago(10 * MINUTE));
    await markBriefFailed(db, run, failedOld!, "MODEL_TIMEOUT");

    expect(await failStaleBriefClaims(db, 5 * MINUTE, NOW)).toBe(1);

    expect(await getBriefClaim(db, run, old!)).toEqual({ status: "failed", attempts: 1, errorCode: "SERVER_RESTART" });
    expect(await getBriefClaim(db, run, atLimit!)).toEqual({ status: "pending", attempts: 1, errorCode: null });
    expect(await getBriefClaim(db, run, recent!)).toEqual({ status: "pending", attempts: 1, errorCode: null });
    expect(await getBriefClaim(db, run, doneOld!)).toEqual({ status: "done", attempts: 1, errorCode: null });
    expect(await getBriefClaim(db, run, failedOld!)).toEqual({ status: "failed", attempts: 1, errorCode: "MODEL_TIMEOUT" });
    expect(await failStaleBriefClaims(db, 5 * MINUTE, NOW)).toBe(0);
    expect(await claimBrief(db, run, old!, 10, NOW)).toBe("claimed");
  });

  it("spares a retry claimed 10 seconds ago and fails a first claim older than a minute", async () => {
    const run = await createRun(db, INPUT, NOW);
    const [retried, stale] = await putBoard(db, run, [{ n: 1 }, { n: 2 }]);
    await claimBrief(db, run, retried!, 10, NOW);
    await markBriefFailed(db, run, retried!, "MODEL_TIMEOUT");
    await claimBrief(db, run, stale!, 10, NOW);
    expect(await claimBrief(db, run, retried!, 10, new Date(LATER.getTime() - 10_000))).toBe("claimed");

    expect(await failStaleBriefClaims(db, 60_000, LATER)).toBe(1);

    expect(await getBriefClaim(db, run, retried!)).toEqual({ status: "pending", attempts: 2, errorCode: null });
    expect(await getBriefClaim(db, run, stale!)).toEqual({ status: "failed", attempts: 1, errorCode: "SERVER_RESTART" });
  });

  it("refuses a bad age or date and changes nothing", async () => {
    const run = await createRun(db, INPUT, NOW);
    const [guest] = await putBoard(db, run, [{ name: "Guest" }]);
    await claimBrief(db, run, guest!, 5, ago(10 * MINUTE));

    for (const ms of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) {
      expect(await codeOf(failStaleBriefClaims(db, ms, NOW)), String(ms)).toBe("SRV_BAD_INPUT");
    }
    expect(await codeOf(failStaleBriefClaims(db, MINUTE, new Date(Number.NaN)))).toBe("SRV_BAD_INPUT");
    expect((await getBriefClaim(db, run, guest!))?.status).toBe("pending");
  });
});

describe("listShowcase (C6.3, C6.5)", () => {
  // Synthetic guests in the shape the agent runner stores (C7.3).
  const guest = (n: number, overrides: Record<string, unknown> = {}) => ({
    personId: `00000000-0000-4000-8000-0000000003${String(n).padStart(2, "0")}`,
    name: `Synthetic Guest ${n}`,
    fit: n / 100,
    fitKnown: n % 3 !== 0,
    fitRank: n,
    reach: "bookable",
    rising: { state: "rising", points: 3.5 },
    bringsNew: n % 2 === 0 ? { segment: "age", label: "listeners 25 to 29", gap: 0.4 } : null,
    sharedTags: ["synthetic taste"],
    angle: "Their fans already love this kind of talk.",
    showName: "Synthetic Show",
    ...overrides,
  });
  const shownGuest = (id: string, n: number) => ({
    id,
    name: `Synthetic Guest ${n}`,
    fit: n / 100,
    fitKnown: n % 3 !== 0,
    reach: "bookable",
    rising: "rising",
    bringsNew: n % 2 === 0 ? "listeners 25 to 29" : null,
  });

  async function endedRun(status: "done" | "failed", guests: unknown[]): Promise<{ runId: string; guestIds: string[] }> {
    const runId = await createRun(db, INPUT, NOW);
    await setRunStatus(db, runId, "running", undefined, NOW);
    const guestIds = await putBoard(db, runId, guests);
    await setRunStatus(db, runId, status, status === "failed" ? "QLOO_LIMIT" : undefined, LATER);
    return { runId, guestIds };
  }

  // Straight into the table as the owner, the way the promote command writes,
  // so these tests can place runs that promoteRun itself would refuse.
  async function promote(runId: string, position: number): Promise<void> {
    await db.query("INSERT INTO showcase_runs (run_id, position, promoted_at) VALUES ($1::uuid, $2, $3::timestamptz)", [
      runId,
      position,
      LATER.toISOString(),
    ]);
  }

  it("lists promoted done runs by position with their top 3 guests, and skips every run it cannot show whole", async () => {
    const four = await endedRun("done", [guest(1), guest(2), guest(3), guest(4)]);
    const three = await endedRun("done", [guest(5), guest(6), guest(7)]);
    const failed = await endedRun("failed", [guest(8), guest(9), guest(10)]);
    const two = await endedRun("done", [guest(11), guest(12)]);
    const badGuest = await endedRun("done", [guest(13), guest(14, { name: "" }), guest(15), guest(16)]);
    const extraField = await endedRun("done", [guest(17), guest(18), guest(19, { url: "https://evil.example" })]);
    const twoShows = await endedRun("done", [guest(20), guest(21, { showName: "Another Show" }), guest(22)]);
    const unpromoted = await endedRun("done", [guest(23), guest(24), guest(25)]);
    const badRun = crypto.randomUUID();
    await db.query(
      `INSERT INTO runs (id, status, input, error_code, created_at, finished_at)
       VALUES ($1::uuid, 'done', '{"show":5,"exclude":[]}'::json, NULL, $2::timestamptz, $2::timestamptz)`,
      [badRun, NOW.toISOString()],
    );
    await putBoard(db, badRun, [guest(26), guest(27), guest(28)]);

    await promote(four.runId, 7);
    await promote(three.runId, 2);
    await promote(failed.runId, 1);
    await promote(two.runId, 3);
    await promote(badGuest.runId, 4);
    await promote(extraField.runId, 5);
    await promote(twoShows.runId, 6);
    await promote(badRun, 12);

    expect(await listShowcase(db)).toEqual([
      {
        runId: three.runId,
        position: 2,
        showName: "Synthetic Show",
        finishedAt: LATER,
        guests: [shownGuest(three.guestIds[0]!, 5), shownGuest(three.guestIds[1]!, 6), shownGuest(three.guestIds[2]!, 7)],
      },
      {
        runId: four.runId,
        position: 7,
        showName: "Synthetic Show",
        finishedAt: LATER,
        guests: [shownGuest(four.guestIds[0]!, 1), shownGuest(four.guestIds[1]!, 2), shownGuest(four.guestIds[2]!, 3)],
      },
    ]);
    expect(JSON.stringify(await listShowcase(db))).not.toContain(unpromoted.runId);
  });

  it("parses a guest whose text fields are emoji at the runner's caps and refuses one more, guarding against a zod change in how string length is counted", () => {
    const emoji = "\u{1F600}";
    const row = guest(1, {
      name: emoji.repeat(200),
      bringsNew: { segment: emoji.repeat(100), label: emoji.repeat(100), gap: 0.4 },
      sharedTags: [emoji.repeat(40), emoji.repeat(200)],
      angle: emoji.repeat(400),
      showName: emoji.repeat(200),
    });

    expect(parseBoardGuest(JSON.stringify(row))).toEqual(row);
    for (const over of [
      { name: emoji.repeat(201) },
      { bringsNew: { segment: emoji.repeat(101), label: "x", gap: 0.4 } },
      { bringsNew: { segment: "x", label: emoji.repeat(101), gap: 0.4 } },
      { sharedTags: [emoji.repeat(201)] },
      { angle: emoji.repeat(401) },
      { showName: emoji.repeat(201) },
      { name: "" },
    ]) {
      expect(parseBoardGuest(JSON.stringify({ ...row, ...over })), JSON.stringify(Object.keys(over))).toBeNull();
    }
  });

  it("gives an empty list when nothing is promoted", async () => {
    await endedRun("done", [guest(1), guest(2), guest(3)]);

    expect(await listShowcase(db)).toEqual([]);
  });

  async function applyRoles(): Promise<void> {
    const sql = await readFile(new URL("../src/store/roles.sql", import.meta.url), "utf8");
    const statements = sql
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n")
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement !== "");
    for (const statement of statements) await db.query(statement);
  }

  it("lets the app role read the showcase and refuses it every write, and lets it retime a brief claim but never move its ids (C6.3, C6.6)", async () => {
    const shown = await endedRun("done", [guest(1), guest(2), guest(3)]);
    const other = await endedRun("done", [guest(4), guest(5), guest(6)]);
    await promote(shown.runId, 1);
    const claimed = shown.guestIds[0]!;
    await claimBrief(db, shown.runId, claimed, 5, NOW);
    await markBriefFailed(db, shown.runId, claimed, "MODEL_TIMEOUT");
    await applyRoles();
    const writes: Array<[string, unknown[]]> = [
      ["INSERT INTO showcase_runs (run_id, position, promoted_at) VALUES ($1::uuid, 2, now())", [other.runId]],
      ["UPDATE showcase_runs SET position = 5 WHERE run_id = $1::uuid", [shown.runId]],
      ["DELETE FROM showcase_runs WHERE run_id = $1::uuid", [shown.runId]],
      ["TRUNCATE showcase_runs", []],
    ];

    await db.query("SET ROLE vasal_app");
    expect((await db.query<{ who: string }>("SELECT current_user AS who")).rows).toEqual([{ who: "vasal_app" }]);
    for (const [text, params] of writes) {
      await expect(db.query(text, params), text).rejects.toThrow(StoreError);
    }
    expect((await listShowcase(db)).map((run) => [run.runId, run.position])).toEqual([[shown.runId, 1]]);
    // The retry is the app's own write of created_at.
    expect(await claimBrief(db, shown.runId, claimed, 5, LATER)).toBe("claimed");
    const claimIdWrites: Array<[string, unknown[]]> = [
      ["UPDATE run_brief_claims SET run_id = $2::uuid WHERE run_id = $1::uuid", [shown.runId, other.runId]],
      ["UPDATE run_brief_claims SET guest_id = $2::uuid WHERE run_id = $1::uuid", [shown.runId, crypto.randomUUID()]],
    ];
    for (const [text, params] of claimIdWrites) {
      await expect(db.query(text, params), text).rejects.toThrow(StoreError);
    }
    await db.query("RESET ROLE");
    const claim = await db.query<{ run_id: string; guest_id: string; created_at: Date }>(
      "SELECT run_id::text AS run_id, guest_id::text AS guest_id, created_at FROM run_brief_claims",
    );
    expect(claim.rows.map((row) => [row.run_id, row.guest_id, new Date(row.created_at)])).toEqual([[shown.runId, claimed, LATER]]);
    for (const [text, params] of claimIdWrites) await db.query(text, params);

    // The same statements work for the owner, so each refusal above was the grant, not the SQL.
    const owner = await db.query<{ runId: string; position: number }>(
      'SELECT run_id::text AS "runId", position FROM showcase_runs',
    );
    expect(owner.rows).toEqual([{ runId: shown.runId, position: 1 }]);
    for (const [text, params] of writes) await db.query(text, params);
    expect(await rowCount("showcase_runs")).toBe(0);
  });
});

describe("the surface a run is charged to, and reads for one key only (D3.2, D4.1)", () => {
  const HOUR_MS = 60 * 60 * 1_000;

  it("stores the origin with the run and reads it back, with website runs as the default", async () => {
    const { id: tokenId } = await issueToken(db);
    const plain = await createRun(db, INPUT, NOW);
    const web = await createRun(db, INPUT, NOW, { surface: "web" });
    const mcp = await createRun(db, INPUT, NOW, { surface: "mcp", tokenId });

    expect(await getRun(db, plain)).toMatchObject({ surface: "web", tokenId: null });
    expect(await getRun(db, web)).toMatchObject({ surface: "web", tokenId: null });
    expect(await getRun(db, mcp)).toMatchObject({ surface: "mcp", tokenId });
  });

  it("refuses an origin that is not exactly one of the two shapes, and a key row that does not exist, writing nothing", async () => {
    const { id: tokenId } = await issueToken(db);
    for (const origin of [
      { surface: "mcp" },
      { surface: "mcp", tokenId: "x" },
      { surface: "mcp", tokenId: tokenId.toUpperCase() },
      { surface: "web", tokenId },
      { surface: "site" },
      null,
      "mcp",
    ]) {
      expect(await codeOf(createRun(db, INPUT, NOW, origin as unknown as RunOrigin)), JSON.stringify(origin)).toBe("SRV_BAD_INPUT");
    }
    expect(await codeOf(createRun(db, INPUT, NOW, { surface: "mcp", tokenId: crypto.randomUUID() }))).toBe("SRV_UNAVAILABLE");
    expect(await rowCount("runs")).toBe(0);

    // The table holds the same rule, so no other writer can store a mixed row.
    await expect(
      db.query("INSERT INTO runs (id, status, input, created_at, surface) VALUES ($1::uuid, 'queued', '{}', now(), 'mcp')", [
        crypto.randomUUID(),
      ]),
    ).rejects.toThrow(StoreError);
  });

  it("getRunForToken gives a run only to the key that made it, never a website run", async () => {
    const mine = await issueToken(db);
    const theirs = await issueToken(db);
    const run = await createRun(db, INPUT, NOW, { surface: "mcp", tokenId: mine.id });
    const webRun = await createRun(db, INPUT, NOW);

    expect(await getRunForToken(db, run, mine.id)).toMatchObject({ id: run, surface: "mcp", tokenId: mine.id });
    expect(await getRunForToken(db, run, theirs.id)).toBeNull();
    expect(await getRunForToken(db, webRun, mine.id)).toBeNull();
    expect(await getRunForToken(db, crypto.randomUUID(), mine.id)).toBeNull();

    const { db: recording, calls } = recordingDb();
    expect(await getRunForToken(recording, run.toUpperCase(), mine.id)).toBeNull();
    expect(await getRunForToken(recording, run, `${mine.id}'--`)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("getCandidateForToken matches the exact id on the key's own run, and only within its life", async () => {
    const mine = await issueToken(db);
    const theirs = await issueToken(db);
    const run = await createRun(db, INPUT, NOW, { surface: "mcp", tokenId: mine.id });
    const [candidateId] = await putCandidates(db, run, [{ name: "synthetic" }]);
    const webRun = await createRun(db, INPUT, NOW);
    const [webCandidate] = await putCandidates(db, webRun, [{ name: "web" }]);
    const fresh = new Date(NOW.getTime() + HOUR_MS - 1);

    expect(await getCandidateForToken(db, candidateId!, mine.id, HOUR_MS, fresh)).toEqual({ runId: run, data: { name: "synthetic" } });
    expect(await getCandidateForToken(db, candidateId!, theirs.id, HOUR_MS, fresh)).toBeNull();
    expect(await getCandidateForToken(db, webCandidate!, mine.id, HOUR_MS, fresh)).toBeNull();
    expect(await getCandidateForToken(db, crypto.randomUUID(), mine.id, HOUR_MS, fresh)).toBeNull();
    expect(await getCandidateForToken(db, run, mine.id, HOUR_MS, fresh)).toBeNull();
    expect(await getCandidateForToken(db, candidateId!, mine.id, HOUR_MS, new Date(NOW.getTime() + HOUR_MS))).toBeNull();
    expect(await getCandidateForToken(db, candidateId!, mine.id, HOUR_MS, new Date(NOW.getTime() + 2 * HOUR_MS))).toBeNull();

    const { db: recording, calls } = recordingDb();
    expect(await getCandidateForToken(recording, candidateId!.toUpperCase(), mine.id, HOUR_MS, fresh)).toBeNull();
    expect(calls).toEqual([]);
    for (const maxAgeMs of [0, -1, 1.5, 86_400_001, Number.NaN]) {
      expect(await codeOf(getCandidateForToken(db, candidateId!, mine.id, maxAgeMs, fresh))).toBe("SRV_BAD_INPUT");
    }
    expect(await codeOf(getCandidateForToken(db, candidateId!, mine.id, HOUR_MS, new Date(Number.NaN)))).toBe("SRV_BAD_INPUT");
  });
});
