// Covers the agent runner end to end on a migrated PGlite database, with a
// scripted fake model, a fake directory and feed fetcher, the real feed
// parser, and a fake metered Qloo holding synthetic data. It also covers
// finishRun, the run-store step the runner ends every run with. It does not
// cover the HTTP routes (server-app), the real network, the real model, or
// races between database connections (PGlite has one).
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import { AgentError } from "../src/agent/errors.js";
import type { ModelClient } from "../src/agent/model.js";
import { createAgentRunner, type AgentFeeds } from "../src/agent/runner.js";
import { FeedError } from "../src/feeds/errors.js";
import type { ShowCandidate } from "../src/feeds/lookup.js";
import { parseFeed } from "../src/feeds/rss.js";
import { QlooError } from "../src/qloo/errors.js";
import type { MeteredQloo } from "../src/qloo/metered.js";
import type { QlooOperation } from "../src/qloo/request.js";
import { ServerError } from "../src/server/errors.js";
import {
  claimBrief,
  claimRunStatus,
  createRun,
  finishRun,
  getBrief,
  getRun,
  listBoard,
  listCandidates,
  listEventsAfter,
  setRunStatus,
  type RunInput,
} from "../src/server/runs.js";
import type { Db } from "../src/store/db.js";
import { migratedPglite } from "./helpers/pglite.js";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const MARKER = "MARKER-ru11";
const PODCAST_ID = "00000000-0000-4000-8000-000000000500";
const personId = (n: number) => `00000000-0000-4000-8000-0000000002${String(n).padStart(2, "0")}`;
const PICKS = [1, 2, 3, 4];
const RSS = `<?xml version="1.0"?><rss><channel><title>Synthetic Show</title>
<item><title>Episode one with a past guest</title><pubDate>Mon, 12 Oct 2026 08:00:00 GMT</pubDate></item>
<item><title>Episode two</title><pubDate>Mon, 05 Oct 2026 08:00:00 GMT</pubDate></item>
</channel></rss>`;

let db: Db;

beforeEach(async () => {
  db = await migratedPglite();
});

afterEach(async () => {
  await db.close();
});

const show = (n: number): ShowCandidate => ({
  appleId: String(1000 + n),
  name: `Synthetic Show ${n}`,
  publisher: `Synthetic Publisher ${n}`,
  feedUrl: new URL(`https://feeds.example/show-${n}.xml?token=${MARKER}`),
  genre: null,
});

function fakeFeeds(opts: { shows?: ShowCandidate[]; feed?: string | Error } = {}) {
  const fetched: URL[] = [];
  const feeds: AgentFeeds = {
    searchShows: async () => opts.shows ?? [1, 2, 3, 4, 5].map(show),
    lookupShow: async () => null,
    safeFetch: async (url) => {
      fetched.push(url);
      if (opts.feed instanceof Error) throw opts.feed;
      return { body: opts.feed ?? RSS };
    },
    parseFeed,
  };
  return { feeds, fetched };
}

const fitScores: Record<string, number> = { [personId(1)]: 0.41, [personId(2)]: 0.77, [personId(3)]: 0.55 };

function synthResponse(op: QlooOperation): unknown {
  switch (op.op) {
    case "search":
      return [{ entity_id: PODCAST_ID, name: op.query }];
    case "insights":
      if (op.resultEntities !== undefined) {
        return op.resultEntities.filter((id) => id in fitScores).map((id) => ({ entity_id: id, name: "ignored", query: { affinity: fitScores[id] } }));
      }
      return PICKS.map((n) => ({ entity_id: personId(n), name: `Synthetic Person ${n}`, popularity: 0.5, query: { affinity: 0.9 } }));
    case "demographics":
      return [{ entity_id: op.signalEntities[0], query: { age: { "25_to_29": op.signalEntities[0] === PODCAST_ID ? -0.2 : 0.4 }, gender: {} } }];
    case "trending":
      return Array.from({ length: 12 }, (_, week) => ({
        date: new Date(Date.UTC(2026, 9, 11) - week * 7 * 86_400_000).toISOString().slice(0, 10),
        population_percentile: week < 4 ? 70 : 60,
      }));
    case "compare":
      return [{ tag_id: "urn:tag:synthetic:1", name: "synthetic taste", query: { score: 0.5 } }];
    default:
      return [];
  }
}

function fakeQloo(fail?: (op: QlooOperation) => QlooError | null) {
  const ops: QlooOperation[] = [];
  const qloo: MeteredQloo = {
    async call<T>(op: QlooOperation): Promise<{ data: T; fromCache: boolean }> {
      ops.push(op);
      const error = fail?.(op) ?? null;
      if (error !== null) throw error;
      return { data: synthResponse(op) as T, fromCache: false };
    },
    stats: () => ({ calls: ops.length, cacheHits: 0 }),
  };
  return { qloo, ops };
}

const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input, caller: { type: "direct" } });
const reply = (content: unknown[]) =>
  ({
    id: "msg_synthetic",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content,
    stop_reason: "tool_use",
    stop_sequence: null,
    stop_details: null,
    container: null,
    diagnostics: null,
    usage: { input_tokens: 100, output_tokens: 50 },
  }) as unknown as Anthropic.Message;

function fakeModel(briefDraft?: unknown) {
  const turns: Array<Parameters<ModelClient["turn"]>[0]> = [];
  const model: ModelClient = {
    async turn(params) {
      turns.push(structuredClone(params));
      if (turns.length === 1) return reply([toolUse("p", "people_for_show", { reach: "any" }), toolUse("t", "recent_episode_titles", {})]);
      return reply([
        toolUse("f", "finish_board", { picks: PICKS.map((n) => ({ personId: personId(n), angle: "Their fans already love this kind of talk." })) }),
      ]);
    },
    async structured<T>(params: { system: string; user: string; schema: ZodType<T>; maxTokens: number }): Promise<T> {
      const parsed = params.schema.safeParse(briefDraft);
      if (!parsed.success) throw new AgentError("AGENT_BAD_PROSE");
      return parsed.data;
    },
  };
  return { model, turns };
}

// Records which transaction each statement ran in, so a test can show two
// writes were committed together.
function trackingDb(inner: Db) {
  const log: Array<{ tx: number | null; text: string; params: unknown[] }> = [];
  let opened = 0;
  const wrap = (target: Db, tx: number | null): Db => ({
    query: <R = Record<string, unknown>>(text: string, params?: unknown[]) => {
      log.push({ tx, text, params: params ?? [] });
      return target.query<R>(text, params);
    },
    transaction: <T>(fn: (handle: Db) => Promise<T>) => target.transaction((handle) => fn(wrap(handle, tx ?? (opened += 1)))),
    close: () => target.close(),
  });
  return { db: wrap(inner, null), log };
}

async function setup(opts: { input?: RunInput; feed?: string | Error; fail?: (op: QlooOperation) => QlooError | null; database?: Db } = {}) {
  const input = opts.input ?? { show: "Synthetic Show", exclude: [] };
  const target = opts.database ?? db;
  const runId = await createRun(db, input, NOW);
  const { feeds, fetched } = fakeFeeds(opts.feed === undefined ? {} : { feed: opts.feed });
  const { qloo, ops } = fakeQloo(opts.fail);
  const { model, turns } = fakeModel(BRIEF);
  const agent = createAgentRunner({ db: target, model, qloo, feeds, now: () => NOW });
  return { runId, input, agent, fetched, ops, turns };
}

// What the confirm route does before it calls continueRun.
async function confirmFirst(runId: string): Promise<string> {
  const [first] = await listCandidates(db, runId);
  expect(await claimRunStatus(db, runId, "awaiting_confirm", "running", NOW)).toBe(true);
  return first!.id;
}

const BRIEF = {
  why: "{{guest}} has {{fit}} with {{show}} listeners. See https://evil.example now.",
  angle: "A talk about {{tag1}}.",
  questions: ["One?", "Two?", "Three?", "Four?", "Five?"],
  pitch_subject: "{{show}} would love to have {{guest}}",
  pitch_body: "Hi team, could {{guest}} join {{show}} this month?",
};

describe("startRun (C6.2)", () => {
  it("stores ranked candidates and ends awaiting_confirm with a candidates event that has no URL", async () => {
    const { runId, input, agent, ops } = await setup();

    await agent.startRun(runId, input);

    expect((await getRun(db, runId))?.status).toBe("awaiting_confirm");
    const listed = await listCandidates(db, runId);
    expect(listed.map((item) => (item.data as { name: string }).name)).toEqual([1, 2, 3, 4, 5].map((n) => `Synthetic Show ${n}`));
    expect(listed[0]!.data).toMatchObject({ feedUrl: `https://feeds.example/show-1.xml?token=${MARKER}`, qlooId: PODCAST_ID });

    const events = await listEventsAfter(db, runId, 0);
    expect(events.map((event) => event.event)).toEqual(["candidates"]);
    expect(events[0]!.data).toEqual({
      candidates: listed.map((item, index) => ({
        id: item.id,
        appleId: String(1001 + index),
        name: `Synthetic Show ${index + 1}`,
        publisher: `Synthetic Publisher ${index + 1}`,
        qlooName: `Synthetic Show ${index + 1}`,
      })),
    });
    const text = JSON.stringify(events);
    for (const fragment of ["http", "feeds.example", MARKER]) expect(text).not.toContain(fragment);
    expect(ops.every((op) => op.op === "search")).toBe(true);
  });

  it("fails the run with only the code when no show is found", async () => {
    const runId = await createRun(db, { show: "Nothing", exclude: [] }, NOW);
    const { feeds } = fakeFeeds({ shows: [] });
    const agent = createAgentRunner({ db, model: fakeModel().model, qloo: fakeQloo().qloo, feeds, now: () => NOW });

    await agent.startRun(runId, { show: "Nothing", exclude: [] });

    expect(await getRun(db, runId)).toMatchObject({ status: "failed", errorCode: "SHOW_NOT_FOUND" });
    expect(await listEventsAfter(db, runId, 0)).toEqual([{ seq: 1, event: "failed", data: { code: "SHOW_NOT_FOUND" } }]);
  });
});

describe("continueRun (C1.5, C6.4)", () => {
  it("builds the board from one fit call carrying every pick, with exclusions applied in code", async () => {
    const { runId, input, agent, ops, turns, fetched } = await setup({
      input: { show: "Synthetic Show", exclude: ["  synthetic  PERSON 4 "] },
    });
    await agent.startRun(runId, input);
    const candidateId = await confirmFirst(runId);

    await agent.continueRun(runId, candidateId);

    expect((await getRun(db, runId))?.status).toBe("done");
    const fitCalls = ops.filter((op) => op.op === "insights" && op.resultEntities !== undefined);
    expect(fitCalls).toEqual([
      {
        op: "insights",
        filterType: "urn:entity:person",
        signalEntities: [PODCAST_ID],
        resultEntities: PICKS.map(personId),
        take: 4,
      },
    ]);
    const board = (await listBoard(db, runId)).map((item) => item.data as Record<string, unknown>);
    expect(board.map((entry) => [entry["personId"], entry["fit"], entry["fitKnown"], entry["fitRank"]])).toEqual([
      [personId(2), 0.77, true, 1],
      [personId(3), 0.55, true, 2],
      [personId(1), 0.41, true, 3],
    ]);
    expect(board[0]).toMatchObject({
      rising: { state: "rising" },
      bringsNew: { label: "listeners 25 to 29" },
      sharedTags: ["synthetic taste"],
      showName: "Synthetic Show 1",
    });

    expect(fetched.map((url) => url.href)).toEqual([`https://feeds.example/show-1.xml?token=${MARKER}`]);
    const sentToModel = JSON.stringify(turns);
    expect(sentToModel).not.toContain("synthetic  PERSON 4");
    expect(sentToModel).not.toContain("feeds.example");
    expect(sentToModel).toContain("Episode one with a past guest");
    expect(turns[0]!.tools.some((tool) => /fetch|url|feed/i.test(tool.name))).toBe(false);

    const events = await listEventsAfter(db, runId, 0);
    expect(events.at(-1)).toEqual({ seq: events.length, event: "done", data: { guests: 3 } });
    const boardEvent = events.find((event) => event.event === "board")?.data as { guests: Array<Record<string, unknown>> };
    expect(boardEvent.guests.map((guest) => [guest["name"], guest["fitRank"]])).toEqual([
      ["Synthetic Person 2", 1],
      ["Synthetic Person 3", 2],
      ["Synthetic Person 1", 3],
    ]);
  });

  it("still finishes when the feed cannot be fetched", async () => {
    const { runId, input, agent, turns } = await setup({ feed: new FeedError("FEED_TIMEOUT") });
    await agent.startRun(runId, input);

    await agent.continueRun(runId, await confirmFirst(runId));

    expect((await getRun(db, runId))?.status).toBe("done");
    const events = await listEventsAfter(db, runId, 0);
    expect(events.find((event) => event.event === "step")?.data).toEqual({
      tool: "feed",
      ok: false,
      label: "Could not read the show's feed, so past guests are not checked",
    });
    expect(JSON.stringify(turns)).not.toContain("Episode one");
  });

  it("gives a person Qloo returns no fit for fit 0 and fitKnown false", async () => {
    const { runId, input, agent } = await setup();
    await agent.startRun(runId, input);

    await agent.continueRun(runId, await confirmFirst(runId));

    const board = (await listBoard(db, runId)).map((item) => item.data as Record<string, unknown>);
    expect(board.at(-1)).toMatchObject({ personId: personId(4), fit: 0, fitKnown: false, fitRank: 4 });
  });

  it("fails a board under 3 guests with AGENT_BOARD_TOO_SMALL, the status and failed event in one transaction", async () => {
    const tracking = trackingDb(db);
    const { runId, input, agent, ops } = await setup({
      input: { show: "Synthetic Show", exclude: ["Synthetic Person 1", "Synthetic Person 2"] },
      database: tracking.db,
    });
    await agent.startRun(runId, input);

    await agent.continueRun(runId, await confirmFirst(runId));

    expect(await getRun(db, runId)).toMatchObject({ status: "failed", errorCode: "AGENT_BOARD_TOO_SMALL" });
    const events = await listEventsAfter(db, runId, 0);
    expect(events.at(-1)).toEqual({ seq: events.length, event: "failed", data: { code: "AGENT_BOARD_TOO_SMALL" } });
    expect(await listBoard(db, runId)).toEqual([]);
    expect(ops.some((op) => op.op === "insights" && op.resultEntities !== undefined)).toBe(false);

    const statusWrite = tracking.log.find((entry) => entry.text.includes("UPDATE runs SET status") && entry.params[1] === "failed");
    const eventWrite = tracking.log.find((entry) => entry.text.includes("INSERT INTO run_events") && entry.params[2] === "failed");
    expect(statusWrite?.tx).not.toBeNull();
    expect(statusWrite?.tx).toBe(eventWrite?.tx);
  });

  it("fails the run with only the code of a Qloo error mid-run", async () => {
    const { runId, input, agent } = await setup({
      fail: (op) => (op.op === "insights" && op.resultEntities !== undefined ? new QlooError("QLOO_BUDGET") : null),
    });
    await agent.startRun(runId, input);

    await agent.continueRun(runId, await confirmFirst(runId));

    expect(await getRun(db, runId)).toMatchObject({ status: "failed", errorCode: "QLOO_BUDGET" });
    const events = await listEventsAfter(db, runId, 0);
    expect(events.at(-1)).toEqual({ seq: events.length, event: "failed", data: { code: "QLOO_BUDGET" } });
    expect(await listBoard(db, runId)).toEqual([]);
  });

  it("refuses a candidate id this run never stored", async () => {
    const { runId, input, agent, fetched } = await setup();
    await agent.startRun(runId, input);
    await confirmFirst(runId);

    await agent.continueRun(runId, crypto.randomUUID());

    expect(await getRun(db, runId)).toMatchObject({ status: "failed", errorCode: "SHOW_NOT_FOUND" });
    expect(fetched).toHaveLength(0);
  });
});

describe("writeBrief", () => {
  it("stores the filled brief for a board guest and logs the removed link", async () => {
    const { runId, input, agent } = await setup();
    await agent.startRun(runId, input);
    await agent.continueRun(runId, await confirmFirst(runId));
    const [first] = await listBoard(db, runId);
    expect(await claimBrief(db, runId, first!.id, 5, NOW)).toBe("claimed");

    await agent.writeBrief(runId, first!.id);

    expect(await getBrief(db, runId, first!.id)).toMatchObject({
      why: "Synthetic Person 2 has 77% fit with Synthetic Show 1 listeners. See now.",
      pitch_subject: "Synthetic Show 1 would love to have Synthetic Person 2",
      removed: { links: 1, emails: 0 },
    });
    const events = await listEventsAfter(db, runId, 0);
    expect(events.slice(-2).map((event) => event.data)).toEqual([
      { tool: "brief", ok: true, label: "Removed 1 link and 0 email addresses from the draft" },
      { guestId: first!.id, ok: true },
    ]);
  });
});

describe("finishRun", () => {
  it("refuses a mismatched event, a bad code and a finished run, changing nothing", async () => {
    const runId = await createRun(db, { show: "x", exclude: [] }, NOW);
    const codeOf = async (promise: Promise<unknown>) => promise.then(() => "ok", (error: unknown) => (error instanceof ServerError ? error.code : String(error)));

    expect(await codeOf(finishRun(db, runId, "done", { name: "failed", data: {} }))).toBe("SRV_BAD_INPUT");
    expect(await codeOf(finishRun(db, runId, "done", { name: "done", data: {} }, "QLOO_BUDGET"))).toBe("SRV_BAD_INPUT");
    expect(await codeOf(finishRun(db, runId, "failed", { name: "failed", data: {} }, `${MARKER} text`))).toBe("SRV_BAD_INPUT");
    expect(await codeOf(finishRun(db, crypto.randomUUID(), "done", { name: "done", data: {} }))).toBe("SRV_NOT_FOUND");
    expect(await listEventsAfter(db, runId, 0)).toEqual([]);

    await setRunStatus(db, runId, "running", undefined, NOW);
    await finishRun(db, runId, "failed", { name: "failed", data: { code: "AGENT_LIMIT" } }, "AGENT_LIMIT", NOW);
    expect(await codeOf(finishRun(db, runId, "done", { name: "done", data: {} }))).toBe("SRV_NOT_FOUND");
    expect(await getRun(db, runId)).toMatchObject({ status: "failed", errorCode: "AGENT_LIMIT", finishedAt: NOW });
    expect(await listEventsAfter(db, runId, 0)).toEqual([{ seq: 1, event: "failed", data: { code: "AGENT_LIMIT" } }]);
  });
});
