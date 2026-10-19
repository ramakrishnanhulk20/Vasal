// Covers the run store on PGlite: ids, status rules, events, candidates, the
// board, briefs and the restart sweep. It does not cover races between
// separate connections (PGlite has one), the vasal_app grants in roles.sql,
// the shapes of candidate, guest and brief data (the routes and the agent
// own those), or the HTTP routes that call these functions.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServerError } from "../src/server/errors.js";
import {
  appendEvent,
  createRun,
  failInterruptedRuns,
  getBoardGuest,
  getBrief,
  getCandidate,
  getRun,
  listEventsAfter,
  putBoard,
  putBrief,
  putCandidates,
  setRunStatus,
  type RunEventName,
  type RunInput,
  type RunStatus,
} from "../src/server/runs.js";
import type { Db } from "../src/store/db.js";
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
