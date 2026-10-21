// Covers the four MCP tools (tools.ts) on a migrated PGlite database. Most
// tests call them through the SDK's own Client over an in-memory transport,
// which also checks every result against the listed output schema; a few go
// through the /mcp route to show what a caller over HTTP gets. The agent is a
// fake that writes to the run store the way the runner does, and once the
// real runner with fake directories, Qloo and model. It does not cover the
// checks before the SDK (mcp-server.test.ts), the result builders in detail
// (mcp-results.test.ts), the real network or model, or races between
// separate database connections (PGlite has one).
import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZodType } from "zod";
import { AgentError } from "../src/agent/errors.js";
import type { ModelClient } from "../src/agent/model.js";
import { createAgentRunner, reserveSurfaceTokens, waitForSurfaceQlooSlot, type AgentFeeds } from "../src/agent/runner.js";
import type { ShowCandidate } from "../src/feeds/lookup.js";
import { parseFeed } from "../src/feeds/rss.js";
import { ERROR_CODES, SOURCE } from "../src/mcp/results.js";
import { createMcpRoute } from "../src/mcp/server.js";
import { issueToken, MCP_ENABLED_FLAG } from "../src/mcp/tokens.js";
import { registerTools, TOOL_NAMES } from "../src/mcp/tools.js";
import { QlooError } from "../src/qloo/errors.js";
import type { MeteredQloo } from "../src/qloo/metered.js";
import type { QlooOperation } from "../src/qloo/request.js";
import { createUnavailableAgent, type AgentPort } from "../src/server/agent-port.js";
import { createApp } from "../src/server/app.js";
import { acquireInflightSlot } from "../src/server/caps.js";
import type { ServerConfig } from "../src/server/config.js";
import {
  claimRunStatus,
  createRun,
  finishRun,
  getRun,
  listBoard,
  listCandidates,
  listEventsAfter,
  markBriefDone,
  markBriefFailed,
  putBoard,
  putBrief,
  putCandidates,
  setRunStatus,
  type RunInput,
  type RunSurface,
} from "../src/server/runs.js";
import type { Db } from "../src/store/db.js";
import { StoreError } from "../src/store/errors.js";
import { setFlag } from "../src/store/flags.js";
import { setBucket, usage } from "../src/store/meter.js";
import { migratedPglite } from "./helpers/pglite.js";
import { SETTLE } from "./helpers/settle.js";

const APP_ORIGIN = "http://localhost:3000";
const IP_HEADER = "x-test-client-ip";
const MARKER = "MARKER-t001s";
const INTERNAL_HOST = "db.internal.vasal:5432";
const PERSON_MARKER = "qloo-person-marker";
const CONFIG: ServerConfig = {
  production: false,
  port: 8787,
  appOrigin: APP_ORIGIN,
  databaseUrl: null,
  visitorHashSecret: "v".repeat(32),
  turnstileSecret: "test-secret",
  clientIpHeader: IP_HEADER,
  runsPerVisitorPerDay: 5,
  maxInflightRuns: 3,
  anthropicApiKey: null,
  model: "claude-haiku-5-5",
  effort: "medium",
  anthropicTokensPerDay: 2_000_000,
};
const QUICK = { book: 3_000, brief: 3_000 };

let db: Db;
let tokenId: string;
let token: string;
const open: Client[] = [];

beforeEach(async () => {
  db = await migratedPglite();
  await setFlag(db, MCP_ENABLED_FLAG, true);
  await setFlag(db, "live_runs", true);
  ({ id: tokenId, token } = await issueToken(db));
});

afterEach(async () => {
  for (const client of open.splice(0)) await client.close();
  vi.restoreAllMocks();
  await vi.waitFor(async () => expect(await slots()).toEqual({ mcp: 0, runs: 0 }), SETTLE);
  await db.close();
});

const candidateRow = (n: number) => ({
  appleId: String(1000 + n),
  name: `Synthetic Show ${n}`,
  publisher: `Synthetic Publisher ${n}`,
  feedHandleSource: "directory",
  feedUrl: `https://feeds.example/show-${n}.xml`,
  qlooId: `qloo-show-marker-000${n}`,
  qlooName: `Synthetic Show ${n}`,
});

const boardRow = (n: number) => ({
  personId: `${PERSON_MARKER}-000${n}`,
  name: `Synthetic Person ${n}`,
  fit: 0.9 - n / 10,
  fitKnown: true,
  fitRank: n,
  reach: "bookable",
  rising: { state: "steady", points: 0.5 },
  bringsNew: null,
  sharedTags: ["synthetic taste"],
  angle: "Their fans already love long conversations.",
  showName: "Synthetic Show 1",
});

const storedBrief = {
  why: "They share a dry sense of humour with the show.",
  angle: "Ask about the early years.",
  questions: ["One?", "Two?", "Three?", "Four?", "Five?"],
  pitch_subject: "A guest idea",
  pitch_body: "Hello,\n\nWe would love to have you on.",
  removed: { links: 0, emails: 0 },
};

// Writes to the run store the way the real runner does, so the tools read
// back exactly what they would in production.
function fakeAgent(overrides: Partial<AgentPort> = {}) {
  return {
    startRun: vi.fn<AgentPort["startRun"]>(
      overrides.startRun ??
        (async (runId) => {
          await setRunStatus(db, runId, "running");
          await putCandidates(db, runId, [candidateRow(1), candidateRow(2)]);
          await claimRunStatus(db, runId, "running", "awaiting_confirm");
        }),
    ),
    continueRun: vi.fn<AgentPort["continueRun"]>(
      overrides.continueRun ??
        (async (runId) => {
          await putBoard(db, runId, [1, 2, 3].map(boardRow));
          await finishRun(db, runId, "done", { name: "done", data: { guests: 3 } });
        }),
    ),
    writeBrief: vi.fn<AgentPort["writeBrief"]>(
      overrides.writeBrief ??
        (async (runId, guestId) => {
          await putBrief(db, runId, guestId, storedBrief);
          await markBriefDone(db, runId, guestId);
        }),
    ),
  };
}

const failsWith = (code: string) => async (runId: string) => {
  await setRunStatus(db, runId, "running");
  await finishRun(db, runId, "failed", { name: "failed", data: { code } }, code);
};

async function connect(opts: { agent?: AgentPort; tokenId?: string; waitMs?: { book: number; brief: number }; db?: Db } = {}) {
  const server = new McpServer({ name: "vasal", version: "test" }, { capabilities: { tools: {} } });
  registerTools(server, {
    db: opts.db ?? db,
    agent: opts.agent ?? fakeAgent(),
    config: CONFIG,
    now: () => new Date(),
    waitMs: opts.waitMs ?? QUICK,
    tokenId: opts.tokenId ?? tokenId,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "vasal-test", version: "1" });
  await client.connect(clientSide);
  // Listing first arms the client's own check of every result against the
  // listed output schema.
  await client.listTools();
  open.push(client);
  return client;
}

async function call(client: Client, name: string, args?: Record<string, unknown>): Promise<CallToolResult> {
  return (await client.callTool({ name, ...(args === undefined ? {} : { arguments: args }) })) as CallToolResult;
}

const out = (result: CallToolResult) => result.structuredContent as Record<string, unknown>;
const textOf = (result: CallToolResult) => (result.content[0] as { text: string }).text;

async function slots(): Promise<Record<string, number>> {
  const { rows } = await db.query<{ slot: string; n: number }>("SELECT slot, n FROM inflight ORDER BY slot");
  return Object.fromEntries(rows.map((row) => [row.slot, row.n]));
}

async function counts(id = tokenId): Promise<{ runs: number; finds: number; briefs: number }> {
  const { rows } = await db.query<{ runs: number; finds: number; briefs: number }>(
    "SELECT coalesce(sum(runs), 0)::int AS runs, coalesce(sum(finds), 0)::int AS finds, coalesce(sum(briefs), 0)::int AS briefs FROM mcp_token_daily WHERE token_id = $1::uuid",
    [id],
  );
  return rows[0]!;
}

async function presetCount(kind: "runs" | "finds" | "briefs", value: number): Promise<void> {
  await db.query(
    `INSERT INTO mcp_token_daily (token_id, day, ${kind}) VALUES ($1::uuid, $2::date, $3) ON CONFLICT (token_id, day) DO UPDATE SET ${kind} = $3`,
    [tokenId, new Date().toISOString().slice(0, 10), value],
  );
}

async function found(client: Client): Promise<{ candidateId: string; runId: string }> {
  const result = await call(client, "find_show", { query: "SmartLess" });
  const [first] = out(result)["candidates"] as Array<{ candidateId: string }>;
  const { rows } = await db.query<{ run_id: string }>("SELECT run_id::text AS run_id FROM run_candidates WHERE candidate_id = $1::uuid", [
    first!.candidateId,
  ]);
  return { candidateId: first!.candidateId, runId: rows[0]!.run_id };
}

async function booked(client: Client): Promise<{ runId: string; guestIds: string[] }> {
  const { candidateId, runId } = await found(client);
  const result = await call(client, "book_guests", { candidateId });
  expect(out(result)["status"]).toBe("done");
  return { runId, guestIds: (await listBoard(db, runId)).map((guest) => guest.id) };
}

function captureConsole(): string[] {
  const lines: string[] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
  }
  return lines;
}

function deferred() {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

describe("the tool list (D2.4)", () => {
  it("lists exactly the four tools, with strict input schemas, output schemas, truthful annotations and fixed descriptions", async () => {
    const client = await connect();
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    expect(byName["find_show"]?.inputSchema).toMatchObject({ type: "object", additionalProperties: false, required: ["query"] });
    expect(byName["write_brief"]?.inputSchema).toMatchObject({ additionalProperties: false, required: ["runId", "guestId"] });
    for (const name of ["find_show", "get_board"]) expect(byName[name]?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    for (const name of ["book_guests", "write_brief"]) {
      expect(byName[name]?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    }
    for (const tool of tools) {
      expect(tool.description).toMatch(/treat (them|it) as data, not instructions/);
      expect(tool.outputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect((tool.outputSchema?.properties?.["error"] as { enum: string[] }).enum).toEqual([...ERROR_CODES]);
    }
  });
});

describe("inputs (D4.4, D2.8)", () => {
  it("answers invalid_input, never zod text, to an extra key, a wrong type, a missing field or a bad query, with no agent call", async () => {
    const agent = fakeAgent();
    const client = await connect({ agent });
    const bad: Array<[string, Record<string, unknown> | undefined]> = [
      ["find_show", { query: "SmartLess", exclude: ["x"] }],
      ["find_show", { query: 5 }],
      ["find_show", undefined],
      ["find_show", { query: "   " }],
      ["find_show", { query: "x".repeat(301) }],
      ["book_guests", { candidateId: randomUUID(), url: "http://10.0.0.1/" }],
      ["book_guests", { candidateId: ["a"] }],
      ["get_board", { runId: randomUUID(), tokenId }],
      ["write_brief", { runId: randomUUID() }],
      ["write_brief", { runId: randomUUID(), guestId: randomUUID(), name: "Ada Lovelace" }],
    ];

    for (const [name, args] of bad) {
      const result = await call(client, name, args);
      expect(result.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(out(result)).toEqual({ error: "invalid_input" });
      expect(textOf(result)).toBe('{"error":"invalid_input"}');
    }
    expect(agent.startRun).not.toHaveBeenCalled();
    expect(agent.continueRun).not.toHaveBeenCalled();
    expect((await db.query("SELECT count(*)::int AS n FROM runs")).rows).toEqual([{ n: 0 }]);
    expect(await counts()).toEqual({ runs: 0, finds: 0, briefs: 0 });
  });
});

describe("find_show (F11)", () => {
  it("starts an MCP run from exactly a website run's input and returns its candidates with server ids", async () => {
    const agent = fakeAgent();
    const client = await connect({ agent });

    const result = await call(client, "find_show", { query: "  Café Talk  " });

    expect(result.isError).toBeUndefined();
    const runs = await db.query<{ id: string }>("SELECT id::text AS id FROM runs");
    const runId = runs.rows[0]!.id;
    expect(agent.startRun).toHaveBeenCalledExactlyOnceWith(runId, { show: "Café Talk", exclude: [] });
    expect(await getRun(db, runId)).toMatchObject({ surface: "mcp", tokenId, status: "awaiting_confirm" });
    const stored = await listCandidates(db, runId);
    expect(out(result)).toEqual({
      candidates: stored.map((item, index) => ({
        candidateId: item.id,
        name: `Synthetic Show ${index + 1}`,
        publisher: `Synthetic Publisher ${index + 1}`,
        qlooName: `Synthetic Show ${index + 1}`,
        appleUrl: `https://podcasts.apple.com/podcast/id${1001 + index}`,
      })),
      source: SOURCE,
    });
    expect(textOf(result)).not.toContain("qloo-show-marker");
    expect(textOf(result)).not.toContain("feeds.example");
    expect(await counts()).toEqual({ runs: 0, finds: 1, briefs: 0 });
  });

  it("classifies the query with the website's own resolver: a name is searched, an Apple link is looked up by id (D4.4)", async () => {
    const searched: string[] = [];
    const looked: string[] = [];
    const feeds: AgentFeeds = {
      searchShows: async (term) => {
        searched.push(term);
        return [directoryShow(1)];
      },
      lookupShow: async (appleId) => {
        looked.push(appleId);
        return directoryShow(2);
      },
      safeFetch: async () => {
        throw new Error("no fetch expected");
      },
      parseFeed,
    };
    const agent = createAgentRunner({ db, qlooFor: () => syntheticQloo(), modelFor: () => syntheticModel(), feeds });
    const client = await connect({ agent });

    const byName = await call(client, "find_show", { query: "Synthetic Show" });
    const byLink = await call(client, "find_show", { query: "https://podcasts.apple.com/us/podcast/synthetic/id1521578868" });

    expect(searched).toEqual(["Synthetic Show"]);
    expect(looked).toEqual(["1521578868"]);
    expect((out(byName)["candidates"] as Array<{ name: string }>)[0]?.name).toBe("Synthetic Show 1");
    expect((out(byLink)["candidates"] as Array<{ name: string }>)[0]?.name).toBe("Synthetic Show 2");
  });

  it("maps a failed run's code: no show is not_found, unusable text is invalid_input, anything else upstream_failed", async () => {
    const cases: Array<[string, string]> = [
      ["SHOW_NOT_FOUND", "not_found"],
      ["SHOW_NO_QLOO_MATCH", "not_found"],
      ["FEED_BAD_INPUT", "invalid_input"],
      ["QLOO_LIMIT", "upstream_failed"],
      ["AGENT_NOT_READY", "upstream_failed"],
    ];
    for (const [code, answer] of cases) {
      const client = await connect({ agent: fakeAgent({ startRun: failsWith(code) }) });
      const result = await call(client, "find_show", { query: "SmartLess" });
      expect(out(result), code).toEqual({ error: answer });
      expect(result.isError).toBe(true);
    }
  });

  it("marks a run failed with AGENT_ERROR when startRun rejects without ending it, and keeps the agent's own ending otherwise (C6.4, D2.8)", async () => {
    const lines = captureConsole();
    const hostile = new Error(`${MARKER} could not reach ${INTERNAL_HOST}`);
    const rejecting = await connect({
      agent: fakeAgent({
        startRun: async (runId) => {
          await setRunStatus(db, runId, "running");
          throw hostile;
        },
      }),
    });

    const lost = await call(rejecting, "find_show", { query: "SmartLess" });

    expect(out(lost)).toEqual({ error: "upstream_failed" });
    const [first] = (await db.query<{ id: string }>("SELECT id::text AS id FROM runs")).rows;
    expect(await getRun(db, first!.id)).toMatchObject({ status: "failed", errorCode: "AGENT_ERROR" });
    expect((await listEventsAfter(db, first!.id, 0)).map((event) => [event.event, event.data])).toEqual([["failed", { code: "AGENT_ERROR" }]]);

    const ended = await connect({
      agent: fakeAgent({
        startRun: async (runId) => {
          await failsWith("SHOW_NOT_FOUND")(runId);
          throw hostile;
        },
      }),
    });
    const notFound = await call(ended, "find_show", { query: "SmartLess" });
    expect(out(notFound)).toEqual({ error: "not_found" });
    const second = (await db.query<{ id: string }>("SELECT id::text AS id FROM runs WHERE id <> $1::uuid", [first!.id])).rows[0]!;
    expect(await getRun(db, second.id)).toMatchObject({ status: "failed", errorCode: "SHOW_NOT_FOUND" });

    const everything = JSON.stringify([lost, notFound]) + lines.join("\n");
    expect(everything).not.toContain(MARKER);
    expect(everything).not.toContain(INTERNAL_HOST);
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { level: "error", route: "/mcp", tool: "find_show", code: "UNEXPECTED" },
      { level: "error", route: "/mcp", tool: "find_show", code: "UNEXPECTED" },
    ]);
  });

  it("marks a run failed with AGENT_ERROR when startRun resolves but leaves it unfinished (C6.4)", async () => {
    const quiet = await connect({ agent: fakeAgent({ startRun: (runId) => setRunStatus(db, runId, "running") }) });

    expect(out(await call(quiet, "find_show", { query: "SmartLess" }))).toEqual({ error: "upstream_failed" });
    const [run] = (await db.query<{ id: string }>("SELECT id::text AS id FROM runs")).rows;
    expect(await getRun(db, run!.id)).toMatchObject({ status: "failed", errorCode: "AGENT_ERROR" });
  });
});

describe("book_guests (F12, D3.3, D3.4)", () => {
  it("continues the run once, waits for the board, and returns it with the run link built from the app origin", async () => {
    const agent = fakeAgent();
    const client = await connect({ agent });
    const { candidateId, runId } = await found(client);

    const result = await call(client, "book_guests", { candidateId });

    expect(agent.continueRun).toHaveBeenCalledExactlyOnceWith(runId, candidateId);
    const board = await listBoard(db, runId);
    expect(out(result)).toMatchObject({ status: "done", runId, runUrl: `${APP_ORIGIN}/runs/${runId}`, showName: "Synthetic Show 1", source: SOURCE });
    expect((out(result)["guests"] as Array<{ guestId: string }>).map((guest) => guest.guestId)).toEqual(board.map((guest) => guest.id));
    expect(textOf(result)).not.toContain(PERSON_MARKER);
    expect(await counts()).toEqual({ runs: 1, finds: 1, briefs: 0 });
    await vi.waitFor(async () => expect(await slots()).toEqual({ mcp: 0, runs: 0 }), SETTLE);

    const again = await call(client, "book_guests", { candidateId });
    expect(out(again)).toEqual(out(result));
    expect(agent.continueRun).toHaveBeenCalledOnce();
    expect(await counts()).toEqual({ runs: 1, finds: 1, briefs: 0 });
  });

  it("starts one run from 10 parallel calls with one candidate, counting one daily run (D3.4)", async () => {
    const agent = fakeAgent();
    const client = await connect({ agent });
    const { candidateId, runId } = await found(client);

    const results = await Promise.all(Array.from({ length: 10 }, () => call(client, "book_guests", { candidateId })));

    expect(agent.continueRun).toHaveBeenCalledOnce();
    expect(await counts()).toMatchObject({ runs: 1 });
    // A call that finds MCP's one slot taken is told busy at once, with no
    // queue (D3.3); every other call sees the one run.
    const boards = results.filter((result) => result.isError !== true);
    expect(boards.length).toBeGreaterThan(0);
    for (const result of boards) expect(out(result)).toMatchObject({ status: "done", runId });
    for (const result of results.filter((entry) => entry.isError === true)) expect(out(result)).toEqual({ error: "busy" });
  });

  it("answers busy at once while MCP's slot is held, spending nothing, and a website run still starts (D3.3)", async () => {
    const agent = fakeAgent();
    const client = await connect({ agent });
    const { candidateId, runId } = await found(client);
    expect(await acquireInflightSlot(db, 1, "mcp")).toBe(true);

    const startedAt = performance.now();
    const result = await call(client, "book_guests", { candidateId });

    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(out(result)).toEqual({ error: "busy" });
    expect(agent.continueRun).not.toHaveBeenCalled();
    expect((await getRun(db, runId))?.status).toBe("awaiting_confirm");
    expect(await counts()).toMatchObject({ runs: 0 });

    const website = createApp({ db, config: CONFIG, verifyTurnstile: async () => true, agent: fakeAgent({ startRun: async () => {} }), socketAddress: () => null });
    const res = await website.request("/runs", {
      method: "POST",
      headers: { origin: APP_ORIGIN, "content-type": "application/json", [IP_HEADER]: "203.0.113.7" },
      body: JSON.stringify({ show: "SmartLess", turnstileToken: "tok" }),
    });
    expect(res.status).toBe(202);
    await db.query("UPDATE inflight SET n = 0 WHERE slot = 'mcp'");
  });

  it("refuses a fourth daily run with budget_exhausted, moving the claim back and giving both slots back (D3.6)", async () => {
    const agent = fakeAgent();
    const client = await connect({ agent });
    const { candidateId, runId } = await found(client);
    await presetCount("runs", 3);

    const result = await call(client, "book_guests", { candidateId });

    expect(out(result)).toEqual({ error: "budget_exhausted" });
    expect((await getRun(db, runId))?.status).toBe("awaiting_confirm");
    expect(agent.continueRun).not.toHaveBeenCalled();
    expect(await slots()).toEqual({ mcp: 0, runs: 0 });

    await presetCount("runs", 2);
    expect(out(await call(client, "book_guests", { candidateId }))).toMatchObject({ status: "done", runId });
    expect(await counts()).toMatchObject({ runs: 3 });
  });

  it("moves the claim back too when the daily count cannot be read, and answers upstream_failed", async () => {
    captureConsole();
    const agent = fakeAgent();
    const countFails: Db = {
      query: (text, params) => (text.includes("runs = d.runs + 1") ? Promise.reject(new StoreError("STORE_UNAVAILABLE")) : db.query(text, params)),
      transaction: (fn) => db.transaction(fn),
      close: async () => {},
    };
    const { candidateId, runId } = await found(await connect({ agent }));

    const result = await call(await connect({ agent, db: countFails }), "book_guests", { candidateId });

    expect(out(result)).toEqual({ error: "upstream_failed" });
    expect((await getRun(db, runId))?.status).toBe("awaiting_confirm");
    expect(agent.continueRun).not.toHaveBeenCalled();
    expect(await slots()).toEqual({ mcp: 0, runs: 0 });
  });

  it("marks the run failed with AGENT_ERROR when continueRun rejects without ending it, and keeps the agent's ending otherwise (C6.4)", async () => {
    captureConsole();
    const rejecting = await connect({
      agent: fakeAgent({
        continueRun: async () => {
          throw new Error(`${MARKER} ${INTERNAL_HOST}`);
        },
      }),
    });
    const lost = await found(rejecting);
    const lostResult = await call(rejecting, "book_guests", { candidateId: lost.candidateId });
    expect(out(lostResult)).toEqual({ error: "upstream_failed" });
    expect(await getRun(db, lost.runId)).toMatchObject({ status: "failed", errorCode: "AGENT_ERROR" });
    expect(textOf(lostResult)).not.toContain(MARKER);

    const ended = await connect({
      agent: fakeAgent({
        continueRun: async (runId) => {
          await finishRun(db, runId, "failed", { name: "failed", data: { code: "SHOW_NOT_FOUND" } }, "SHOW_NOT_FOUND");
          throw new Error(MARKER);
        },
      }),
    });
    const kept = await found(ended);
    expect(out(await call(ended, "book_guests", { candidateId: kept.candidateId }))).toEqual({ error: "not_found" });
    expect(await getRun(db, kept.runId)).toMatchObject({ status: "failed", errorCode: "SHOW_NOT_FOUND" });
    await vi.waitFor(async () => expect(await slots()).toEqual({ mcp: 0, runs: 0 }), SETTLE);
  });

  it("returns the run id to poll when the board takes longer than the wait, and get_board shows the board once it lands", async () => {
    const { gate, release } = deferred();
    const agent = fakeAgent({
      continueRun: async (runId) => {
        await gate;
        await putBoard(db, runId, [1, 2, 3].map(boardRow));
        await finishRun(db, runId, "done", { name: "done", data: { guests: 3 } });
      },
    });
    const client = await connect({ agent, waitMs: { book: 200, brief: 200 } });
    const { candidateId, runId } = await found(client);

    const waiting = await call(client, "book_guests", { candidateId });
    expect(out(waiting)).toEqual({ status: "running", runId, retryAfterSeconds: 30, source: SOURCE });
    expect(out(await call(client, "get_board", { runId }))).toEqual({ status: "running", runId, retryAfterSeconds: 30, source: SOURCE });
    expect(await slots()).toEqual({ mcp: 1, runs: 1 });

    release();
    await vi.waitFor(async () => expect((await getRun(db, runId))?.status).toBe("done"), SETTLE);
    expect(out(await call(client, "get_board", { runId }))).toMatchObject({ status: "done", runId });
    expect(agent.continueRun).toHaveBeenCalledOnce();
  });
});

describe("get_board (F13)", () => {
  it("reports each status from storage alone, the failure as a caller code, and works while live runs are off", async () => {
    const client = await connect();
    const waiting = await found(client);
    const failed = await createRun(db, { show: "x", exclude: [] }, new Date(), { surface: "mcp", tokenId });
    await failsWith("QLOO_LIMIT")(failed);

    await setFlag(db, "live_runs", false);
    expect(out(await call(client, "get_board", { runId: waiting.runId }))).toEqual({ status: "awaiting_confirm", runId: waiting.runId, source: SOURCE });
    expect(out(await call(client, "get_board", { runId: failed }))).toEqual({ status: "failed", runId: failed, reason: "upstream_failed", source: SOURCE });

    await claimRunStatus(db, waiting.runId, "awaiting_confirm", "running");
    await putBoard(db, waiting.runId, [1, 2, 3].map(boardRow));
    await finishRun(db, waiting.runId, "done", { name: "done", data: { guests: 3 } });
    const board = await call(client, "get_board", { runId: waiting.runId });
    expect(out(board)).toMatchObject({ status: "done", runId: waiting.runId, runUrl: `${APP_ORIGIN}/runs/${waiting.runId}` });
    expect(out(board)["guests"]).toHaveLength(3);
  });
});

describe("write_brief (F13, D3.5)", () => {
  it("writes one brief, returns it, and serves it from storage after that without counting again", async () => {
    const agent = fakeAgent();
    const client = await connect({ agent });
    const { runId, guestIds } = await booked(client);

    const first = await call(client, "write_brief", { runId, guestId: guestIds[0]! });
    const again = await call(client, "write_brief", { runId, guestId: guestIds[0]! });

    expect(out(first)).toEqual({
      status: "done",
      runId,
      guestId: guestIds[0],
      brief: {
        why: storedBrief.why,
        angle: storedBrief.angle,
        questions: storedBrief.questions,
        pitchSubject: storedBrief.pitch_subject,
        pitchBody: storedBrief.pitch_body,
      },
      source: SOURCE,
    });
    expect(out(again)).toEqual(out(first));
    expect(agent.writeBrief).toHaveBeenCalledExactlyOnceWith(runId, guestIds[0]);
    expect(await counts()).toMatchObject({ briefs: 1 });
  });

  it("makes one model call from 10 parallel calls for one guest (D3.5)", async () => {
    const agent = fakeAgent();
    const client = await connect({ agent });
    const { runId, guestIds } = await booked(client);

    const results = await Promise.all(Array.from({ length: 10 }, () => call(client, "write_brief", { runId, guestId: guestIds[1]! })));

    expect(agent.writeBrief).toHaveBeenCalledOnce();
    for (const result of results) expect(out(result)).toMatchObject({ status: "done", guestId: guestIds[1] });
  });

  it("answers pending while the brief is written, and asking again neither counts nor claims a second brief", async () => {
    const { gate, release } = deferred();
    const agent = fakeAgent({
      writeBrief: async (runId, guestId) => {
        await gate;
        await putBrief(db, runId, guestId, storedBrief);
        await markBriefDone(db, runId, guestId);
      },
    });
    const client = await connect({ agent, waitMs: { book: 3_000, brief: 200 } });
    const { runId, guestIds } = await booked(client);
    const guestId = guestIds[0]!;

    expect(out(await call(client, "write_brief", { runId, guestId }))).toEqual({ status: "pending", source: SOURCE });
    expect(out(await call(client, "write_brief", { runId, guestId }))).toEqual({ status: "pending", source: SOURCE });
    expect(await counts()).toMatchObject({ briefs: 1 });
    expect(agent.writeBrief).toHaveBeenCalledOnce();

    release();
    await vi.waitFor(async () => expect(out(await call(client, "write_brief", { runId, guestId }))).toMatchObject({ status: "done" }), SETTLE);
    expect(await counts()).toMatchObject({ briefs: 1 });
  });

  it("allows one retry after a failed brief, then answers upstream_failed for good", async () => {
    const agent = fakeAgent({
      writeBrief: async (runId, guestId) => {
        await markBriefFailed(db, runId, guestId, "MODEL_TIMEOUT");
      },
    });
    const client = await connect({ agent });
    const { runId, guestIds } = await booked(client);
    const guestId = guestIds[2]!;

    expect(out(await call(client, "write_brief", { runId, guestId }))).toEqual({ error: "upstream_failed" });
    expect(out(await call(client, "write_brief", { runId, guestId }))).toEqual({ error: "upstream_failed" });
    expect(out(await call(client, "write_brief", { runId, guestId }))).toEqual({ error: "upstream_failed" });
    expect(agent.writeBrief).toHaveBeenCalledTimes(2);
    expect(await counts()).toMatchObject({ briefs: 2 });
  });

  it("refuses a brief for a run that is not done, or a guest not on its board, before spending", async () => {
    const agent = fakeAgent();
    const client = await connect({ agent });
    const waiting = await found(client);
    const { runId } = await booked(client);

    expect(out(await call(client, "write_brief", { runId: waiting.runId, guestId: randomUUID() }))).toEqual({ error: "invalid_input" });
    expect(out(await call(client, "write_brief", { runId, guestId: randomUUID() }))).toEqual({ error: "not_found" });
    expect(agent.writeBrief).not.toHaveBeenCalled();
    expect(await counts()).toMatchObject({ briefs: 0 });
  });

  it("holds the daily brief cap and the per-run cap with budget_exhausted, claiming nothing (D3.6)", async () => {
    const agent = fakeAgent();
    const client = await connect({ agent });
    const { runId, guestIds } = await booked(client);

    await presetCount("briefs", 15);
    expect(out(await call(client, "write_brief", { runId, guestId: guestIds[0]! }))).toEqual({ error: "budget_exhausted" });
    expect((await db.query("SELECT count(*)::int AS n FROM run_brief_claims")).rows).toEqual([{ n: 0 }]);
    expect(agent.writeBrief).not.toHaveBeenCalled();

    await presetCount("briefs", 0);
    const sixGuests = await createRun(db, { show: "x", exclude: [] }, new Date(), { surface: "mcp", tokenId });
    await setRunStatus(db, sixGuests, "running");
    const ids = await putBoard(db, sixGuests, [1, 2, 3, 4, 5, 6].map(boardRow));
    await finishRun(db, sixGuests, "done", { name: "done", data: { guests: 6 } });
    for (const guestId of ids.slice(0, 5)) expect(out(await call(client, "write_brief", { runId: sixGuests, guestId }))).toMatchObject({ status: "done" });
    expect(out(await call(client, "write_brief", { runId: sixGuests, guestId: ids[5]! }))).toEqual({ error: "budget_exhausted" });
  });

  it("with the unavailable agent, answers upstream_failed every time without counting the key's briefs or claiming (C5.8)", async () => {
    const { runId, guestIds } = await booked(await connect());
    const client = await connect({ agent: createUnavailableAgent(db) });

    for (let i = 0; i < 3; i += 1) {
      expect(out(await call(client, "write_brief", { runId, guestId: guestIds[0]! }))).toEqual({ error: "upstream_failed" });
    }

    expect(await counts()).toMatchObject({ briefs: 0 });
    expect((await db.query("SELECT count(*)::int AS n FROM run_brief_claims")).rows).toEqual([{ n: 0 }]);
  });
});

describe("per-key caps (D3.6)", () => {
  it("completes exactly 20 of 25 parallel find_show calls against the daily cap of 20", async () => {
    const agent = fakeAgent();
    const client = await connect({ agent });

    const results = await Promise.all(Array.from({ length: 25 }, () => call(client, "find_show", { query: "SmartLess" })));

    expect(results.filter((result) => result.isError !== true)).toHaveLength(20);
    expect(results.filter((result) => out(result)["error"] === "budget_exhausted")).toHaveLength(5);
    expect(agent.startRun).toHaveBeenCalledTimes(20);
    expect(await counts()).toMatchObject({ finds: 20 });
  });
});

describe("ownership (D4.1, D4.2)", () => {
  it("answers not_found, with no agent call, for another key's ids, a website run, an unknown id, a foreign guest and an expired candidate", async () => {
    const agent = fakeAgent();
    const mine = await connect({ agent });
    const other = await issueToken(db);
    const theirs = await connect({ agent, tokenId: other.id });
    const { candidateId } = await found(theirs);
    const { runId: theirRun, guestIds: theirGuests } = await booked(theirs);
    const { runId: myRun } = await booked(mine);
    const website = await createRun(db, { show: "SmartLess", exclude: [] });
    await setRunStatus(db, website, "running");
    await putBoard(db, website, [1, 2, 3].map(boardRow));
    await finishRun(db, website, "done", { name: "done", data: {} });
    const old = await createRun(db, { show: "x", exclude: [] }, new Date(Date.now() - 2 * 60 * 60 * 1_000), { surface: "mcp", tokenId });
    await setRunStatus(db, old, "awaiting_confirm");
    const [expired] = await putCandidates(db, old, [candidateRow(1)]);
    agent.continueRun.mockClear();
    agent.writeBrief.mockClear();

    const refused: Array<[string, Record<string, unknown>]> = [
      ["book_guests", { candidateId }],
      ["book_guests", { candidateId: randomUUID() }],
      ["book_guests", { candidateId: expired! }],
      ["book_guests", { candidateId: candidateId.toUpperCase() }],
      ["get_board", { runId: theirRun }],
      ["get_board", { runId: website }],
      ["get_board", { runId: randomUUID() }],
      ["write_brief", { runId: theirRun, guestId: theirGuests[0]! }],
      ["write_brief", { runId: website, guestId: theirGuests[0]! }],
      ["write_brief", { runId: myRun, guestId: theirGuests[0]! }],
    ];
    for (const [name, args] of refused) expect(out(await call(mine, name, args)), `${name} ${JSON.stringify(args)}`).toEqual({ error: "not_found" });
    expect(agent.continueRun).not.toHaveBeenCalled();
    expect(agent.writeBrief).not.toHaveBeenCalled();
  });

  it("treats a candidate id that encodes a URL as an unknown id, fetching nothing (D4.2)", async () => {
    const fetched: URL[] = [];
    const feeds: AgentFeeds = {
      searchShows: async () => [directoryShow(1)],
      lookupShow: async () => null,
      safeFetch: async (url) => {
        fetched.push(url);
        return { body: "" };
      },
      parseFeed,
    };
    const agent = createAgentRunner({ db, qlooFor: () => syntheticQloo(), modelFor: () => syntheticModel(), feeds });
    const client = await connect({ agent });
    const crafted = Buffer.from("http://10.0.0.1/").toString("base64");

    for (const candidateId of [crafted, Buffer.from("http://10.0.0.1/").toString("base64url"), "http://10.0.0.1/"]) {
      expect(out(await call(client, "book_guests", { candidateId }))).toEqual({ error: "not_found" });
    }
    expect(fetched).toEqual([]);
    expect((await db.query("SELECT count(*)::int AS n FROM runs")).rows).toEqual([{ n: 0 }]);
  });
});

describe("which share MCP spends from (D3.1, D3.2)", () => {
  const FAR = new Date("2099-01-01T00:00:00.000Z");
  const BUCKETS = ["qloo:month", "qloo:day", "qloo:day:mcp", "qloo:month:mcp", "anthropic:day", "anthropic:day:mcp"] as const;

  it("charges a whole MCP flow only to the MCP buckets and the shared month, through the real runner", async () => {
    for (const key of BUCKETS) await setBucket(db, { key, cap: 1_000_000, windowEnd: FAR });
    const surfaces: RunSurface[] = [];
    const agent = createAgentRunner({
      db,
      qlooFor: (surface) => syntheticQloo(surface, surfaces),
      modelFor: (surface) => syntheticModel(surface, surfaces),
      feeds: { searchShows: async () => [directoryShow(1)], lookupShow: async () => null, safeFetch: async () => ({ body: RSS }), parseFeed },
    });
    const client = await connect({ agent, waitMs: { book: 20_000, brief: 20_000 } });

    const { runId, guestIds } = await booked(client);
    const brief = await call(client, "write_brief", { runId, guestId: guestIds[0]! });

    expect(out(brief)).toMatchObject({ status: "done" });
    expect(textOf(brief)).not.toContain("evil.example");
    expect(new Set(surfaces)).toEqual(new Set(["mcp"]));
    const used = Object.fromEntries(await Promise.all(BUCKETS.map(async (key) => [key, (await usage(db, key))?.used] as const)));
    expect(used["qloo:day"]).toBe(0);
    expect(used["anthropic:day"]).toBe(0);
    expect(used["qloo:day:mcp"]).toBeGreaterThan(0);
    expect(used["qloo:month:mcp"]).toBe(used["qloo:day:mcp"]);
    expect(used["qloo:month"]).toBe(used["qloo:day:mcp"]);
    expect(used["anthropic:day:mcp"]).toBeGreaterThan(0);
  }, 60_000);
});

describe("over HTTP through /mcp", () => {
  function route(agent: AgentPort = fakeAgent()) {
    const app = new Hono();
    app.route("/mcp", createMcpRoute({ db, agent, config: CONFIG, waitMs: QUICK }));
    return app;
  }

  const rpc = (app: Hono, key: string, body: unknown) =>
    app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
  const toolCall = (name: string, args: unknown, id: number | string = 1) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });

  it("lists exactly the four tools over HTTP (D2.4)", async () => {
    const res = await rpc(route(), token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("answers two keys sending tools/call with id 1 at once, 50 times, each with only its own run (D2.3)", async () => {
    const other = await issueToken(db);
    const mineRun = await createRun(db, { show: "a", exclude: [] }, new Date(), { surface: "mcp", tokenId });
    const theirRun = await createRun(db, { show: "b", exclude: [] }, new Date(), { surface: "mcp", tokenId: other.id });
    const app = route();

    for (let round = 0; round < 50; round += 1) {
      const [mine, theirs] = await Promise.all([
        rpc(app, token, toolCall("get_board", { runId: mineRun })),
        rpc(app, other.token, toolCall("get_board", { runId: theirRun })),
      ]);
      const mineBody = (await mine.json()) as { id: number; result: { structuredContent: { runId: string } } };
      const theirBody = (await theirs.json()) as { id: number; result: { structuredContent: { runId: string } } };
      expect(mineBody.id).toBe(1);
      expect(theirBody.id).toBe(1);
      expect(mineBody.result.structuredContent.runId).toBe(mineRun);
      expect(theirBody.result.structuredContent.runId).toBe(theirRun);
    }
  });

  it("keeps a thrown marker and an internal hostname out of the whole HTTP answer, and bad input is invalid_input (D2.8)", async () => {
    captureConsole();
    const app = route(
      fakeAgent({
        startRun: async () => {
          throw new Error(`${MARKER} at ${INTERNAL_HOST}`);
        },
      }),
    );

    const thrown = await (await rpc(app, token, toolCall("find_show", { query: "SmartLess" }))).text();
    const extra = await (await rpc(app, token, toolCall("find_show", { query: "SmartLess", admin: true }))).text();

    for (const text of [thrown, extra]) {
      expect(text).not.toContain(MARKER);
      expect(text).not.toContain(INTERNAL_HOST);
      expect(text).not.toMatch(/zod|Unrecognized|Invalid input|expected/i);
    }
    expect(JSON.parse(thrown)).toMatchObject({ result: { structuredContent: { error: "upstream_failed" }, isError: true } });
    expect(JSON.parse(extra)).toMatchObject({ result: { structuredContent: { error: "invalid_input" }, isError: true } });
  });

  it("refuses every tool with 503 when mcp_enabled is off, and with live runs off refuses new spending while get_board still works", async () => {
    const agent = fakeAgent();
    const app = route(agent);
    const client = await connect({ agent });
    const { candidateId, runId } = await found(client);
    const done = await booked(client);
    const calls = [
      toolCall("find_show", { query: "SmartLess" }),
      toolCall("book_guests", { candidateId }),
      toolCall("get_board", { runId: done.runId }),
      toolCall("write_brief", { runId: done.runId, guestId: done.guestIds[0] }),
    ];

    await setFlag(db, MCP_ENABLED_FLAG, false);
    for (const body of calls) {
      const res = await rpc(app, token, body);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "mcp_off" });
    }

    await setFlag(db, MCP_ENABLED_FLAG, true);
    await setFlag(db, "live_runs", false);
    const answers = [];
    for (const body of calls) answers.push(((await (await rpc(app, token, body)).json()) as { result: CallToolResult }).result);
    expect(answers.map((result) => out(result)["error"])).toEqual(["mcp_off", "mcp_off", undefined, "mcp_off"]);
    expect(out(answers[2]!)).toMatchObject({ status: "done", runId: done.runId });
    expect((await getRun(db, runId))?.status).toBe("awaiting_confirm");
  });
});

// Synthetic upstreams for the real runner, in the shapes agent-runner.test.ts uses.
const PODCAST_ID = "00000000-0000-4000-8000-000000000500";
const personId = (n: number) => `00000000-0000-4000-8000-0000000002${String(n).padStart(2, "0")}`;
const PICKS = [1, 2, 3, 4];
const RSS = `<?xml version="1.0"?><rss><channel><title>Synthetic Show</title>
<item><title>Episode one</title><pubDate>Mon, 12 Oct 2026 08:00:00 GMT</pubDate></item>
</channel></rss>`;
const BRIEF_DRAFT = {
  why: "{{guest}} has {{fit}} with {{show}} listeners. See https://evil.example now.",
  angle: "A talk about {{tag1}}.",
  questions: ["One?", "Two?", "Three?", "Four?", "Five?"],
  pitch_subject: "{{show}} would love to have {{guest}}",
  pitch_body: "Hi team, could {{guest}} join {{show}} this month?",
};

function directoryShow(n: number): ShowCandidate {
  return {
    appleId: String(1000 + n),
    name: `Synthetic Show ${n}`,
    publisher: `Synthetic Publisher ${n}`,
    feedUrl: new URL(`https://feeds.example/show-${n}.xml`),
    genre: null,
  };
}

function synthResponse(op: QlooOperation): unknown {
  switch (op.op) {
    case "search":
      return [{ entity_id: PODCAST_ID, name: op.query }];
    case "insights":
      if (op.resultEntities !== undefined) return op.resultEntities.map((id) => ({ entity_id: id, name: "ignored", query: { affinity: 0.6 } }));
      return PICKS.map((n) => ({ entity_id: personId(n), name: `Synthetic Person ${n}`, popularity: 0.5, query: { affinity: 0.9 } }));
    case "demographics":
      return [{ entity_id: op.signalEntities[0], query: { age: { "25_to_29": 0.4 }, gender: {} } }];
    case "trending":
      return Array.from({ length: 12 }, (_, week) => ({
        date: new Date(Date.UTC(2026, 9, 11) - week * 7 * 86_400_000).toISOString().slice(0, 10),
        population_percentile: 60,
      }));
    case "compare":
      return { tags: [{ tag_id: "urn:tag:synthetic:1", name: "synthetic taste", query: { score: 0.5 } }], a: [], b: [] };
    default:
      return [];
  }
}

// Spends through the same meter function main.ts gives the metered client,
// for the surface the runner picked from the run's row.
function syntheticQloo(surface?: RunSurface, surfaces?: RunSurface[]): MeteredQloo {
  let calls = 0;
  return {
    async call<T>(op: QlooOperation): Promise<{ data: T; fromCache: boolean }> {
      if (surface !== undefined) {
        if (!(await waitForSurfaceQlooSlot(db, surface))) throw new QlooError("QLOO_BUDGET");
        surfaces?.push(surface);
      }
      calls += 1;
      return { data: synthResponse(op) as T, fromCache: false };
    },
    stats: () => ({ calls, cacheHits: 0 }),
  };
}

const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input, caller: { type: "direct" } });
const modelReply = (content: unknown[]) =>
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

// Reserves model tokens from the surface's own bucket, as createAnthropicModel does.
function syntheticModel(surface?: RunSurface, surfaces?: RunSurface[]): ModelClient {
  let turns = 0;
  const spend = async (): Promise<void> => {
    if (surface === undefined) return;
    if (!(await reserveSurfaceTokens(db, surface, 150))) throw new AgentError("MODEL_BUDGET");
    surfaces?.push(surface);
  };
  return {
    async turn() {
      await spend();
      turns += 1;
      if (turns === 1) return modelReply([toolUse("p", "people_for_show", { reach: "any" })]);
      return modelReply([
        toolUse("f", "finish_board", { picks: PICKS.map((n) => ({ personId: personId(n), angle: "Their fans already love this kind of talk." })) }),
      ]);
    },
    async structured<T>(params: { schema: ZodType<T> }): Promise<T> {
      await spend();
      const parsed = params.schema.safeParse(BRIEF_DRAFT);
      if (!parsed.success) throw new AgentError("AGENT_BAD_PROSE");
      return parsed.data;
    },
  };
}
