// Covers the agent server's HTTP routes through app.request() on a migrated
// PGlite database, with a stub human check (and once the real verifier on a
// fake siteverify), a spy agent and a stub socket address, plus the run-store
// functions those routes added. It does not cover the real Turnstile call or
// a real socket (the live smoke does), races
// between separate database connections (PGlite has one), the vasal_app
// grants, the event stream (server-stream.test.ts), or the real agent loop.
import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { kolamFor, type Kolam } from "../src/kolam/kolam.js";
import { issueToken } from "../src/mcp/tokens.js";
import { promoteRun } from "../src/ops/promote.js";
import { createUnavailableAgent, type AgentPort } from "../src/server/agent-port.js";
import { createApp, type AppDeps } from "../src/server/app.js";
import type { ServerConfig } from "../src/server/config.js";
import { ServerError } from "../src/server/errors.js";
import {
  appendEvent,
  claimBrief,
  claimRunStatus,
  createRun,
  failInterruptedRuns,
  getBriefClaim,
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
} from "../src/server/runs.js";
import { createTurnstileVerifier, TURNSTILE_ACTIONS } from "../src/server/turnstile.js";
import type { Db } from "../src/store/db.js";
import { setFlag } from "../src/store/flags.js";
import { setBucket } from "../src/store/meter.js";
import { storeBriefs, syntheticBrief } from "./helpers/briefs.js";
import { migratedPglite } from "./helpers/pglite.js";
import { SETTLE } from "./helpers/settle.js";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const INPUT: RunInput = { show: "SmartLess", exclude: [] };
const APP_ORIGIN = "http://localhost:3000";
const IP_HEADER = "x-test-client-ip";
const VISITOR = "203.0.113.7";
const MARKER = "MARKER-55";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONFIG: ServerConfig = {
  production: false,
  port: 8787,
  appOrigin: APP_ORIGIN,
  databaseUrl: null,
  databaseNetwork: null,
  visitorHashSecret: "v".repeat(32),
  turnstileSecret: "test-secret",
  clientIpHeader: IP_HEADER,
  runsPerVisitorPerDay: 5,
  maxInflightRuns: 3,
  anthropicApiKey: null,
  model: "claude-haiku-5-5",
  effort: "medium",
  anthropicTokensPerDay: 2_000_000,
  trends: false,
};

let db: Db;

beforeEach(async () => {
  db = await migratedPglite();
  await setFlag(db, "live_runs", true);
  await setBucket(db, { key: "qloo:day", cap: 100, windowEnd: new Date(Date.now() + 86_400_000) });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.close();
});

function spyAgent(overrides: Partial<AgentPort> = {}) {
  return {
    startRun: vi.fn<AgentPort["startRun"]>(overrides.startRun ?? (async () => {})),
    continueRun: vi.fn<AgentPort["continueRun"]>(overrides.continueRun ?? (async () => {})),
    writeBrief: vi.fn<AgentPort["writeBrief"]>(overrides.writeBrief ?? (async () => {})),
  };
}

function build(
  opts: {
    config?: Partial<ServerConfig>;
    agent?: Partial<AgentPort>;
    verify?: AppDeps["verifyTurnstile"];
    db?: Db;
    socket?: string;
    now?: () => Date;
  } = {},
) {
  const agent = spyAgent(opts.agent);
  const verify = vi.fn<AppDeps["verifyTurnstile"]>(opts.verify ?? (async () => true));
  const app = createApp({
    db: opts.db ?? db,
    config: { ...CONFIG, ...opts.config },
    verifyTurnstile: verify,
    agent,
    socketAddress: () => opts.socket ?? null,
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });
  return { app, agent, verify };
}

async function postJson(
  app: Hono,
  path: string,
  body: unknown,
  headers: Record<string, string | null> = {},
): Promise<Response> {
  const merged = new Headers({ origin: APP_ORIGIN, "content-type": "application/json", [IP_HEADER]: VISITOR });
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) merged.delete(name);
    else merged.set(name, value);
  }
  return app.request(path, {
    method: "POST",
    headers: merged,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const start = (app: Hono, body: unknown = { show: "SmartLess", turnstileToken: "tok" }, headers = {}) =>
  postJson(app, "/runs", body, headers);

async function inflight(): Promise<number> {
  const { rows } = await db.query<{ n: number }>("SELECT n FROM inflight WHERE slot = 'runs'");
  return rows[0]!.n;
}

async function visitorRuns(): Promise<number> {
  const { rows } = await db.query<{ n: number }>("SELECT coalesce(sum(runs), 0)::int AS n FROM visitor_counters");
  return rows[0]!.n;
}

// Everything a request could spend or create, so "changed nothing" is one comparison.
async function snapshot(): Promise<string> {
  const tables = [
    "SELECT count(*)::int AS n FROM runs",
    "SELECT count(*)::int AS n FROM run_events",
    "SELECT count(*)::int AS n FROM run_brief_claims",
    "SELECT visitor_hash, runs FROM visitor_counters ORDER BY visitor_hash",
    "SELECT n FROM inflight",
    "SELECT key, cap, used FROM usage_buckets ORDER BY key",
    "SELECT run_id, position FROM showcase_runs ORDER BY position",
  ];
  const results = [];
  for (const text of tables) results.push((await db.query(text)).rows);
  return JSON.stringify(results);
}

async function settled(expected = 0): Promise<void> {
  await vi.waitFor(async () => expect(await inflight()).toBe(expected), SETTLE);
}

// Records every statement the app sends, so a test can count meter reads
// and writes exactly.
function countingDb(inner: Db) {
  const texts: string[] = [];
  const wrap = (target: Db): Db => ({
    query: <R = Record<string, unknown>>(text: string, params?: unknown[]) => {
      texts.push(text);
      return target.query<R>(text, params);
    },
    transaction: <T>(fn: (handle: Db) => Promise<T>) => target.transaction((handle) => fn(wrap(handle))),
    close: () => target.close(),
  });
  return { db: wrap(inner), texts };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof ServerError ? error.code : String(error);
  }
  return undefined;
}

async function runWithBoard(guests: unknown[]): Promise<{ runId: string; guestIds: string[] }> {
  const runId = await createRun(db, INPUT, NOW);
  await setRunStatus(db, runId, "running", undefined, NOW);
  const guestIds = await putBoard(db, runId, guests);
  await setRunStatus(db, runId, "done", undefined, NOW);
  return { runId, guestIds };
}

// A synthetic guest in the shape the agent runner stores (C7.3).
function storedGuest(n: number, sharedTags: string[], overrides: Record<string, unknown> = {}) {
  return {
    personId: `00000000-0000-4000-8000-0000000005${String(n).padStart(2, "0")}`,
    name: `Synthetic Guest ${n}`,
    fit: n / 100,
    fitKnown: true,
    fitRank: n,
    reach: "bookable",
    rising: { state: "steady", points: 0 },
    bringsNew: null,
    sharedTags,
    angle: "A synthetic angle.",
    showName: "Synthetic Show",
    ...overrides,
  };
}

// What the brief routes show for syntheticBrief(n): its five named fields only.
function shownBrief(n: number) {
  const { why, angle, questions, pitch_subject: pitchSubject, pitch_body: pitchBody } = syntheticBrief(n);
  return { why, angle, questions, pitchSubject, pitchBody };
}

describe("run store additions", () => {
  it("lists the board in rank order and the candidates with the ids that were issued", async () => {
    const { runId, guestIds } = await runWithBoard([{ name: "first" }, { name: "second" }, { name: "third" }]);
    expect(await listBoard(db, runId)).toEqual([
      { id: guestIds[0], data: { name: "first" } },
      { id: guestIds[1], data: { name: "second" } },
      { id: guestIds[2], data: { name: "third" } },
    ]);

    const other = await createRun(db, INPUT, NOW);
    const candidateIds = await putCandidates(db, other, [{ title: "a" }, { title: "b" }]);
    const listed = await listCandidates(db, other);
    expect(listed.map((item) => item.id).sort()).toEqual([...candidateIds].sort());
    expect(listed.find((item) => item.id === candidateIds[1])?.data).toEqual({ title: "b" });

    expect(await listCandidates(db, runId)).toEqual([]);
    expect(await listBoard(db, other)).toEqual([]);
    expect(await listBoard(db, "not-a-uuid")).toEqual([]);
    expect(await listBoard(db, randomUUID())).toEqual([]);
  });

  it("moves a run only from the stated status, once", async () => {
    const runId = await createRun(db, INPUT, NOW);
    await setRunStatus(db, runId, "awaiting_confirm", undefined, NOW);

    const [first, second] = await Promise.all([
      claimRunStatus(db, runId, "awaiting_confirm", "running", NOW),
      claimRunStatus(db, runId, "awaiting_confirm", "running", NOW),
    ]);
    expect([first, second].sort()).toEqual([false, true]);
    expect((await getRun(db, runId))?.status).toBe("running");
    expect(await claimRunStatus(db, runId, "awaiting_confirm", "running", NOW)).toBe(false);
    expect(await claimRunStatus(db, randomUUID(), "queued", "running", NOW)).toBe(false);

    expect(await claimRunStatus(db, runId, "running", "done", NOW)).toBe(true);
    const done = await getRun(db, runId);
    expect(done?.status).toBe("done");
    expect(done?.finishedAt?.toISOString()).toBe(NOW.toISOString());

    expect(await codeOf(claimRunStatus(db, runId, "done", "running", NOW))).toBe("SRV_BAD_INPUT");
    expect(await codeOf(claimRunStatus(db, runId, "running", "running", NOW))).toBe("SRV_BAD_INPUT");
    expect(await codeOf(claimRunStatus(db, "not-a-uuid", "queued", "running", NOW))).toBe("SRV_BAD_INPUT");
  });

  it("claims one brief per guest, caps claims per run, and refuses guests off the board (C5.8, C6.2)", async () => {
    const guests = Array.from({ length: 7 }, (_, i) => ({ name: `guest ${i}` }));
    const { runId, guestIds } = await runWithBoard(guests);

    const [a, b] = await Promise.all([
      claimBrief(db, runId, guestIds[0]!, 5, NOW),
      claimBrief(db, runId, guestIds[0]!, 5, NOW),
    ]);
    expect([a, b].sort()).toEqual(["claimed", "exists"]);

    for (let i = 1; i < 5; i += 1) expect(await claimBrief(db, runId, guestIds[i]!, 5, NOW)).toBe("claimed");
    expect(await claimBrief(db, runId, guestIds[5]!, 5, NOW)).toBe("limit");
    expect(await claimBrief(db, runId, guestIds[2]!, 5, NOW)).toBe("exists");

    const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM run_brief_claims");
    expect(rows[0]!.n).toBe(5);

    expect(await codeOf(claimBrief(db, runId, randomUUID(), 5, NOW))).toBe("SRV_NOT_FOUND");
    const { guestIds: otherGuests } = await runWithBoard([{ name: "elsewhere" }]);
    expect(await codeOf(claimBrief(db, runId, otherGuests[0]!, 5, NOW))).toBe("SRV_NOT_FOUND");
    expect(await codeOf(claimBrief(db, randomUUID(), guestIds[6]!, 5, NOW))).toBe("SRV_NOT_FOUND");
    expect(await codeOf(claimBrief(db, runId, guestIds[6]!, 0, NOW))).toBe("SRV_BAD_INPUT");
  });
});

describe("GET /health", () => {
  it("reports the kill switch without spending", async () => {
    const { app } = build();
    const before = await snapshot();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, liveRuns: true });
    await setFlag(db, "live_runs", false);
    expect(await (await app.request("/health")).json()).toEqual({ ok: true, liveRuns: false });
    await setFlag(db, "live_runs", true);
    expect(await snapshot()).toBe(before);
  });

  it("answers 503 { ok: false } when the database query rejects, with nothing of the error (audit A3-N3)", async () => {
    const down: Db = {
      query: () => Promise.reject(new Error(MARKER)),
      transaction: () => Promise.reject(new Error(MARKER)),
      close: async () => {},
    };
    const res = await build({ db: down }).app.request("/health");
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: false });
    expect(text).not.toContain(MARKER);
  });

  it("answers 503 { ok: false } when the database has not answered within 2 seconds", async () => {
    const hung: Db = {
      query: () => new Promise(() => {}),
      transaction: () => new Promise(() => {}),
      close: async () => {},
    };
    const startedAt = performance.now();
    const res = await build({ db: hung }).app.request("/health");
    const took = performance.now() - startedAt;
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false });
    expect(took).toBeGreaterThanOrEqual(1_900);
    expect(took).toBeLessThan(5_000);
  });
});

describe("POST /runs", () => {
  it("starts a run for a checked visitor and hands the agent only the checked input", async () => {
    const { app, agent, verify } = build();
    const res = await start(app, { show: "  Café Society  ", exclude: [" Kevin  "], turnstileToken: "tok-1" });
    expect(res.status).toBe(202);
    const { runId } = (await res.json()) as { runId: string };
    expect(runId).toMatch(UUID);

    expect(verify).toHaveBeenCalledExactlyOnceWith("tok-1", VISITOR, TURNSTILE_ACTIONS.runStart);
    expect(agent.startRun).toHaveBeenCalledExactlyOnceWith(runId, { show: "Café Society", exclude: ["Kevin"] });
    expect((await getRun(db, runId))?.input).toEqual({ show: "Café Society", exclude: ["Kevin"] });
    expect(await visitorRuns()).toBe(1);
    await settled(0);
  });

  it("refuses other origins, a missing Origin and non-JSON content types, changing nothing (C5.5)", async () => {
    const { app, agent, verify } = build();
    const before = await snapshot();
    const cases: Array<Record<string, string | null>> = [
      { origin: "https://evil.example" },
      { origin: null },
      { "content-type": "text/plain" },
      { origin: "null" },
      { origin: "http://localhost:3000.evil.example" },
      { "content-type": null },
    ];
    for (const headers of cases) {
      const res = await start(app, undefined, headers);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "FORBIDDEN_ORIGIN" });
    }
    expect(await snapshot()).toBe(before);
    expect(verify).not.toHaveBeenCalled();
    expect(agent.startRun).not.toHaveBeenCalled();
  });

  it("caps the body and rejects anything outside the strict schema before any work (C8.1)", async () => {
    const { app, agent, verify } = build();
    const before = await snapshot();

    const big = await start(app, { show: "a".repeat(9 * 1024), turnstileToken: "tok" });
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: "TOO_LARGE" });

    const bad: unknown[] = [
      { show: "SmartLess", turnstileToken: "tok", url: "http://169.254.169.254/" },
      { show: "a".repeat(301), turnstileToken: "tok" },
      { show: "   ", turnstileToken: "tok" },
      { show: "SmartLess", exclude: Array.from({ length: 26 }, (_, i) => `name ${i}`), turnstileToken: "tok" },
      { show: "SmartLess", exclude: ["  "], turnstileToken: "tok" },
      { show: "SmartLess", exclude: ["x".repeat(101)], turnstileToken: "tok" },
      { show: "SmartLess", turnstileToken: "" },
      { show: "SmartLess" },
      { show: 7, turnstileToken: "tok" },
      ["SmartLess"],
      "{not json",
      "",
    ];
    for (const body of bad) {
      const res = await start(app, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "BAD_INPUT" });
    }
    expect(await snapshot()).toBe(before);
    expect(verify).not.toHaveBeenCalled();
    expect(agent.startRun).not.toHaveBeenCalled();

    const edge = await start(app, {
      show: ` ${"a".repeat(300)} `,
      exclude: Array.from({ length: 25 }, (_, i) => `${i}`.padEnd(100, "x")),
      turnstileToken: "t".repeat(2048),
    });
    expect(edge.status).toBe(202);
    await settled(0);
  });

  it("refuses when live runs are off or the flag cannot be read (C5.7)", async () => {
    await setFlag(db, "live_runs", false);
    const off = build();
    const before = await snapshot();
    const res = await start(off.app);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "LIVE_RUNS_OFF" });
    expect(await snapshot()).toBe(before);
    expect(off.verify).not.toHaveBeenCalled();

    await setFlag(db, "live_runs", true);
    const broken: Db = {
      query: (text, params) => (text.includes("app_flags") ? Promise.reject(new Error(MARKER)) : db.query(text, params)),
      transaction: (fn) => db.transaction(fn),
      close: async () => {},
    };
    const unreadable = build({ db: broken });
    const refused = await start(unreadable.app);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: "LIVE_RUNS_OFF" });
    expect(await snapshot()).toBe(before);
    expect(unreadable.verify).not.toHaveBeenCalled();
  });

  it("refuses a failed or broken human check without counting the visitor", async () => {
    const before = await snapshot();
    for (const verify of [async () => false, async () => Promise.reject(new Error(MARKER))]) {
      const { app, agent } = build({ verify });
      const res = await start(app);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "HUMAN_CHECK_FAILED" });
      expect(agent.startRun).not.toHaveBeenCalled();
    }
    expect(await visitorRuns()).toBe(0);
    expect(await snapshot()).toBe(before);
  });

  it("starts a run only for an answer solved on this site for run start, and creates no run otherwise (C5.9)", async () => {
    const answering = (reply: () => Promise<Response>) =>
      createTurnstileVerifier({
        secret: "0x4AAAAAAA-real-looking-secret",
        expectedHostname: new URL(APP_ORIGIN).hostname,
        fetchImpl: (async () => reply()) as typeof fetch,
        timeoutMs: 50,
      });
    const answer = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 });
    const before = await snapshot();

    const refused: Array<[string, () => Promise<Response>]> = [
      ["another hostname", answer({ success: true, hostname: "evil.example", action: TURNSTILE_ACTIONS.runStart })],
      ["the agent-key action", answer({ success: true, hostname: "localhost", action: TURNSTILE_ACTIONS.agentKey })],
      ["no action", answer({ success: true, hostname: "localhost" })],
      ["a siteverify timeout", () => new Promise<Response>(() => {})],
    ];
    for (const [label, reply] of refused) {
      const { app, agent } = build({ verify: answering(reply) });
      const res = await start(app);
      expect(res.status, label).toBe(403);
      expect(await res.json()).toEqual({ error: "HUMAN_CHECK_FAILED" });
      expect(agent.startRun).not.toHaveBeenCalled();
    }
    expect(await snapshot()).toBe(before);
    expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM runs")).rows).toEqual([{ n: 0 }]);

    const { app, agent } = build({
      verify: answering(answer({ success: true, hostname: "LocalHost", action: TURNSTILE_ACTIONS.runStart })),
    });
    const res = await start(app);
    expect(res.status).toBe(202);
    const { runId } = (await res.json()) as { runId: string };
    expect((await getRun(db, runId))?.status).toBe("queued");
    expect(agent.startRun).toHaveBeenCalledOnce();
    await settled(0);
  });

  it("counts only the one address the edge header gives, or the socket when no header is configured (C5.3)", async () => {
    const before = await snapshot();
    const header = build();
    for (const value of [null, "", "203.0.113.7, 198.51.100.1", "not an address"]) {
      const res = await start(header.app, undefined, { [IP_HEADER]: value });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "NO_CLIENT_ADDRESS" });
    }
    expect(header.verify).not.toHaveBeenCalled();

    const noSocket = build({ config: { clientIpHeader: null } });
    expect((await start(noSocket.app)).status).toBe(400);
    expect(await snapshot()).toBe(before);

    const socket = build({ config: { clientIpHeader: null }, socket: "198.51.100.4" });
    const res = await start(socket.app, undefined, { [IP_HEADER]: "192.0.2.99" });
    expect(res.status).toBe(202);
    expect(socket.verify).toHaveBeenCalledExactlyOnceWith("tok", "198.51.100.4", TURNSTILE_ACTIONS.runStart);
    await settled(0);
  });

  it("stops the third start from one visitor and gives the slot back", async () => {
    const { app, agent } = build({
      config: { runsPerVisitorPerDay: 2 },
      agent: { startRun: () => new Promise<void>(() => {}) },
    });
    expect((await start(app)).status).toBe(202);
    expect((await start(app)).status).toBe(202);
    expect(await inflight()).toBe(2);

    const third = await start(app);
    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({ error: "VISITOR_LIMIT" });
    expect(await inflight()).toBe(2);
    expect(agent.startRun).toHaveBeenCalledTimes(2);
  });

  it("refuses a visitor already at the cap with VISITOR_LIMIT before taking a place, sending nothing to inflight (C5.8)", async () => {
    const counting = countingDb(db);
    const { app, agent } = build({ db: counting.db, config: { runsPerVisitorPerDay: 2 } });
    expect((await start(app)).status).toBe(202);
    expect((await start(app)).status).toBe(202);
    await settled(0);
    const before = await snapshot();
    counting.texts.length = 0;

    const third = await start(app);

    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({ error: "VISITOR_LIMIT" });
    expect(counting.texts.filter((text) => /\binflight\b/i.test(text))).toEqual([]);
    expect(counting.texts.filter((text) => !/^\s*SELECT\b/i.test(text))).toEqual([]);
    expect(await snapshot()).toBe(before);
    expect(agent.startRun).toHaveBeenCalledTimes(2);
  });

  it("counts two IPv6 addresses in one /64 as one visitor", async () => {
    const { app } = build({ config: { runsPerVisitorPerDay: 2 } });
    expect((await start(app, undefined, { [IP_HEADER]: "2001:db8:1:2::1" })).status).toBe(202);
    expect((await start(app, undefined, { [IP_HEADER]: "2001:db8:1:2:ffff:ffff:ffff:9" })).status).toBe(202);
    await settled(0);
    const third = await start(app, undefined, { [IP_HEADER]: "2001:db8:1:2::abcd" });
    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({ error: "VISITOR_LIMIT" });
    expect(await inflight()).toBe(0);
    expect((await start(app, undefined, { [IP_HEADER]: "2001:db8:1:3::1" })).status).toBe(202);
    await settled(0);
  });

  it("holds a slot while a run is unsettled and frees it when the run settles (C5.8)", async () => {
    const settle: Array<() => void> = [];
    const { app, agent } = build({
      config: { maxInflightRuns: 2 },
      agent: { startRun: () => new Promise<void>((resolve) => settle.push(resolve)) },
    });
    expect((await start(app, undefined, { [IP_HEADER]: "198.51.100.1" })).status).toBe(202);
    expect((await start(app, undefined, { [IP_HEADER]: "198.51.100.2" })).status).toBe(202);

    const busy = await start(app, undefined, { [IP_HEADER]: "198.51.100.3" });
    expect(busy.status).toBe(429);
    expect(await busy.json()).toEqual({ error: "BUSY" });
    expect(await visitorRuns()).toBe(2);
    expect(agent.startRun).toHaveBeenCalledTimes(2);

    await vi.waitFor(() => expect(settle).toHaveLength(2), SETTLE);
    settle[0]!();
    await settled(1);
    expect((await start(app, undefined, { [IP_HEADER]: "198.51.100.3" })).status).toBe(202);
    expect(await inflight()).toBe(2);
  });

  it("marks a run failed with AGENT_ERROR when the agent rejects or throws, unless it already finished (C6.4)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failures: Array<AgentPort["startRun"]> = [
      async () => Promise.reject(new Error(MARKER)),
      () => {
        throw new Error(MARKER);
      },
    ];
    for (const [i, startRun] of failures.entries()) {
      const { app } = build({ agent: { startRun } });
      const res = await start(app, undefined, { [IP_HEADER]: `192.0.2.${i + 1}` });
      const { runId } = (await res.json()) as { runId: string };
      await settled(0);
      const run = await getRun(db, runId);
      expect(run?.status).toBe("failed");
      expect(run?.errorCode).toBe("AGENT_ERROR");
      expect(await listEventsAfter(db, runId, 0)).toEqual([{ seq: 1, event: "failed", data: { code: "AGENT_ERROR" } }]);
    }

    const finishedFirst = build({
      agent: {
        startRun: async (runId) => {
          await setRunStatus(db, runId, "failed", "QLOO_LIMIT");
          await appendEvent(db, runId, "failed", { code: "QLOO_LIMIT" });
          throw new Error(MARKER);
        },
      },
    });
    const { runId } = (await (await start(finishedFirst.app)).json()) as { runId: string };
    await settled(0);
    expect((await getRun(db, runId))?.errorCode).toBe("QLOO_LIMIT");
    expect(await listEventsAfter(db, runId, 0)).toEqual([{ seq: 1, event: "failed", data: { code: "QLOO_LIMIT" } }]);
  });
});

describe("GET /runs/:id", () => {
  it("returns the run with server ids on every item and shows a board only once the run is done", async () => {
    const { app } = build();
    const runId = await createRun(db, { show: "SmartLess", exclude: ["Jason"] }, NOW);
    const candidateIds = await putCandidates(db, runId, [
      {
        name: "SmartLess",
        publisher: "SmartLess Media",
        appleId: "1521578868",
        qlooName: "SmartLess",
        feedUrl: "https://feeds.example/smartless",
        feedHandleSource: "directory",
        id: "forged",
      },
    ]);
    await setRunStatus(db, runId, "running", undefined, NOW);
    const guestIds = await putBoard(db, runId, [{ name: "first" }, { name: "second" }]);

    const running = await app.request(`/runs/${runId}`);
    expect(running.status).toBe(200);
    expect(await running.json()).toEqual({
      id: runId,
      status: "running",
      createdAt: NOW.toISOString(),
      finishedAt: null,
      errorCode: null,
      // The stored feed URL and source never reach the page (C1.5); the
      // server-issued id replaces any id the stored data carried.
      candidates: [
        { id: candidateIds[0], appleId: "1521578868", name: "SmartLess", publisher: "SmartLess Media", qlooName: "SmartLess" },
      ],
      board: [],
      kolam: null,
      withoutQloo: null,
      pastGuests: null,
    });
    expect(JSON.stringify(await (await app.request(`/runs/${runId}`)).json())).not.toContain("feeds.example");

    await setRunStatus(db, runId, "done", undefined, NOW);
    const doneText = await (await app.request(`/runs/${runId}`)).text();
    const done = JSON.parse(doneText) as { board: unknown[]; finishedAt: string; kolam: unknown };
    // Neither row reads back as a runner's guest, so neither is shown and
    // there is nothing to draw (C6.5).
    expect(done.board).toEqual([]);
    expect(doneText).not.toContain(guestIds[0]);
    expect(doneText).not.toContain(guestIds[1]);
    expect(doneText).not.toContain("personId");
    expect(done.finishedAt).toBe(NOW.toISOString());
    expect(done.kolam).toBeNull();
  });

  it("shows only each board guest's public fields, and leaves out a row the runner could not have written (C6.5, D5.5)", async () => {
    const { app } = build();
    const person = "qloo-person-MARKER-a1";
    const missingAngle: Record<string, unknown> = storedGuest(3, ["film"]);
    delete missingAngle["angle"];
    const { runId, guestIds } = await runWithBoard([
      storedGuest(1, ["jazz"], {
        personId: person,
        rising: { state: "rising", points: 0.4242 },
        bringsNew: { segment: "MARKER-segment", label: "younger listeners", gap: 0.3131 },
      }),
      storedGuest(2, []),
      missingAngle,
    ]);

    const text = await (await app.request(`/runs/${runId}`)).text();
    const body = JSON.parse(text) as { board: unknown[] };
    const shown = { fitKnown: true, reach: null, angle: "A synthetic angle." };
    expect(body.board).toEqual([
      { ...shown, id: guestIds[0], name: "Synthetic Guest 1", fit: 0.01, fitRank: 1, rising: "rising", bringsNew: "younger listeners", sharedTags: ["jazz"] },
      { ...shown, id: guestIds[1], name: "Synthetic Guest 2", fit: 0.02, fitRank: 2, rising: "steady", bringsNew: null, sharedTags: [] },
    ]);
    for (const absent of ["personId", person, "00000000-0000-4000-8000-000000000502", "segment", "gap", "showName", "Synthetic Show", guestIds[2]!]) {
      expect(text, absent).not.toContain(absent);
    }
    // The kolam's rings carry their own "points", so only the board is searched for these.
    const board = JSON.stringify(body.board);
    for (const absent of ["points", "0.4242", "0.3131"]) expect(board, absent).not.toContain(absent);
  });

  it("carries a kolam of the board's ids and tag counts once the run is done, null before, and none of the board's text (C3.9)", async () => {
    const { app } = build();
    const runId = await createRun(db, INPUT, NOW);
    await setRunStatus(db, runId, "running", undefined, NOW);
    const guestIds = await putBoard(db, runId, [
      storedGuest(1, ["MARKER-k1", "late-night radio", "jazz"]),
      storedGuest(2, ["MARKER-k1"], { name: "MARKER-k2" }),
      storedGuest(3, []),
      { name: "a row the runner could not have written", sharedTags: ["one", "two"] },
    ]);

    const running = (await (await app.request(`/runs/${runId}`)).json()) as { kolam: unknown };
    expect(running.kolam).toBeNull();

    await setRunStatus(db, runId, "done", undefined, NOW);
    const text = await (await app.request(`/runs/${runId}`)).text();
    const body = JSON.parse(text) as { kolam: Kolam | null };
    const expected = kolamFor(runId, [
      { guestId: guestIds[0]!, fitRank: 1, tagCount: 3 },
      { guestId: guestIds[1]!, fitRank: 2, tagCount: 1 },
      { guestId: guestIds[2]!, fitRank: 3, tagCount: 0 },
    ]);
    expect(expected).not.toBeNull();
    expect(body.kolam).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(body.kolam?.rings.map((ring) => ring.guestId)).toEqual(guestIds.slice(0, 2));
    expect(body.kolam?.dots).toHaveLength(4);

    // The markers are on the page's board, so their absence below is the kolam's doing.
    expect(text).toContain("MARKER-k1");
    expect(text).toContain("MARKER-k2");
    const drawing = JSON.stringify(body.kolam);
    for (const absent of ["MARKER-k1", "MARKER-k2", "late-night radio", guestIds[2]!, guestIds[3]!]) {
      expect(drawing).not.toContain(absent);
    }
  });

  it("includes a done run's latest Without Qloo flip with only its allowlisted fields, and null for anything else (C6.5, D5.5)", async () => {
    const { app } = build();
    const flip = {
      status: "done",
      guesses: [
        { name: "Synthetic Guess 1", fit: 0.42, fitKnown: true, reach: "household name", pastGuest: true, host: false, onBoard: false },
        { name: "Synthetic Guess 2", fit: null, fitKnown: false, reach: "unknown", pastGuest: false, host: true, onBoard: true },
      ],
      unresolved: 3,
    };
    // A guess stored with an older reach label shows no label.
    const shownFlip = { ...flip, guesses: [flip.guesses[0]!, { ...flip.guesses[1]!, reach: null }] };
    const { runId } = await runWithBoard([storedGuest(1, [])]);
    const flipOf = async (id: string) => ((await (await app.request(`/runs/${id}`)).json()) as { withoutQloo: unknown }).withoutQloo;

    expect(await flipOf(runId)).toBeNull();
    await appendEvent(db, runId, "without_qloo", { status: "unavailable" }, NOW);
    expect(await flipOf(runId)).toEqual({ status: "unavailable" });
    await appendEvent(db, runId, "without_qloo", flip, NOW);
    expect(await flipOf(runId)).toEqual(shownFlip);
    // A flip stored before hosts were told apart has no host field, and shows none.
    const older = { ...flip, guesses: flip.guesses.map(({ host: _host, ...guess }) => guess) };
    await appendEvent(db, runId, "without_qloo", older, NOW);
    expect(await flipOf(runId)).toEqual({ ...shownFlip, guesses: shownFlip.guesses.map((guess) => ({ ...guess, host: false })) });

    // A later event that is not exactly the runner's shape hides the flip
    // rather than passing an extra field on.
    const [first] = flip.guesses;
    const unfit = [
      { ...flip, personIds: [MARKER] },
      { ...flip, guesses: [{ ...first, personId: MARKER }] },
      { ...flip, guesses: [{ ...first, fit: 0.5, fitKnown: false }] },
      { ...flip, guesses: [{ ...first, reach: MARKER }] },
      { ...flip, guesses: [{ ...first, host: true }] },
      { ...flip, guesses: [{ ...first, host: MARKER }] },
      { status: "done", guesses: flip.guesses },
      { status: "unavailable", reason: MARKER },
    ];
    for (const data of unfit) {
      await appendEvent(db, runId, "without_qloo", data, NOW);
      const text = await (await app.request(`/runs/${runId}`)).text();
      expect((JSON.parse(text) as { withoutQloo: unknown }).withoutQloo, JSON.stringify(data)).toBeNull();
      expect(text).not.toContain(MARKER);
    }

    // Like the board, a flip shows only once its run is done (C6.4).
    const running = await createRun(db, INPUT, NOW);
    await setRunStatus(db, running, "running", undefined, NOW);
    await appendEvent(db, running, "without_qloo", flip, NOW);
    expect(await flipOf(running)).toBeNull();
  });

  it("says how far a done run checked for past guests, and which kind of feed, never the feed itself (A2-6, C1.5)", async () => {
    const { app } = build();
    const runId = await createRun(db, INPUT, NOW);
    const [candidateId] = await putCandidates(db, runId, [
      {
        appleId: null,
        name: "Synthetic Show",
        publisher: "feeds.example",
        feedHandleSource: "visitor",
        feedUrl: `https://feeds.example/${MARKER}.xml`,
        qlooId: "00000000-0000-4000-8000-000000000500",
        qlooName: "Synthetic Show",
      },
    ]);
    await setRunStatus(db, runId, "running", undefined, NOW);
    await putBoard(db, runId, [storedGuest(1, [])]);
    const pastGuests = { checked: true, skipped: 3, titles: 312, since: "2019-09", source: "pasted", candidateId, archiveTitles: 2 };
    await appendEvent(db, runId, "board", { guests: [], pastGuests }, NOW);
    const shown = async () => ((await (await app.request(`/runs/${runId}`)).json()) as { pastGuests: unknown }).pastGuests;

    // Like the board, the check shows only once the run is done (C6.4).
    expect(await shown()).toBeNull();
    await setRunStatus(db, runId, "done", undefined, NOW);
    expect(await shown()).toEqual({
      checked: true,
      episodes: 312,
      since: "2019-09",
      source: "pasted",
      archiveTitles: 2,
      feedName: "Synthetic Show",
      feedPublisher: "feeds.example",
    });
    const text = await (await app.request(`/runs/${runId}`)).text();
    for (const hidden of [MARKER, "skipped", `"candidateId"`]) expect(text).not.toContain(hidden);

    // An event from before the check recorded its feed takes the stored candidate's source.
    await appendEvent(db, runId, "board", { guests: [], pastGuests: { checked: true, skipped: 0, titles: 40, since: null } }, NOW);
    expect(await shown()).toEqual({
      checked: true,
      episodes: 40,
      since: null,
      source: "pasted",
      archiveTitles: 0,
      feedName: "Synthetic Show",
      feedPublisher: "feeds.example",
    });
  });

  it("gives 404 for a non-UUID, an unknown id or a re-spelled id, and marks run responses noindex and no-store (C6.1, C3.8)", async () => {
    const { app } = build();
    const runId = await createRun(db, INPUT, NOW);
    for (const path of ["/runs/not-a-uuid", `/runs/${randomUUID()}`, `/runs/${runId.toUpperCase()}`]) {
      const res = await app.request(path);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "NOT_FOUND" });
      expect(res.headers.get("x-robots-tag")).toBe("noindex");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    const found = await app.request(`/runs/${runId}`);
    expect(found.headers.get("x-robots-tag")).toBe("noindex");
    expect(found.headers.get("cache-control")).toBe("no-store");
    const started = await start(app);
    expect(started.headers.get("x-robots-tag")).toBe("noindex");
    expect(started.headers.get("cache-control")).toBe("no-store");
    await settled(0);
  });
});

describe("reads never spend (C5.4)", () => {
  it("GET and HEAD on /health, /runs/:id and /runs/:id/events call no agent method, no human check, and change nothing", async () => {
    const { app, agent, verify } = build();
    const runId = await createRun(db, INPUT, NOW);
    await setRunStatus(db, runId, "running", undefined, NOW);
    await appendEvent(db, runId, "step", { tool: "search" }, NOW);
    await setRunStatus(db, runId, "failed", "QLOO_LIMIT", NOW);
    await appendEvent(db, runId, "failed", { code: "QLOO_LIMIT" }, NOW);
    const before = await snapshot();
    for (const method of ["GET", "HEAD"]) {
      for (const path of ["/health", `/runs/${runId}`, `/runs/${runId}/events`]) {
        const res = await app.request(path, { method, headers: { origin: APP_ORIGIN } });
        expect(res.status, `${method} ${path}`).toBe(200);
        const body = await res.text();
        if (method === "HEAD") expect(body).toBe("");
        if (method === "GET" && path.endsWith("/events")) expect(body).toContain("event: failed");
      }
    }
    expect(await snapshot()).toBe(before);
    expect(verify).not.toHaveBeenCalled();
    expect(agent.startRun).not.toHaveBeenCalled();
    expect(agent.continueRun).not.toHaveBeenCalled();
    expect(agent.writeBrief).not.toHaveBeenCalled();
  });
});

describe("GET /showcase (C5.4, C6.3)", () => {
  // Synthetic guests in the shape the agent runner stores (C7.3).
  const guest = (n: number) => ({
    personId: `00000000-0000-4000-8000-0000000004${String(n).padStart(2, "0")}`,
    name: `Synthetic Guest ${n}`,
    fit: n / 100,
    fitKnown: true,
    fitRank: n,
    reach: "well known",
    rising: { state: "steady", points: 0 },
    bringsNew: null,
    sharedTags: [],
    angle: "A synthetic angle.",
    showName: "Synthetic Show",
  });

  it("lists only promoted runs from storage alone, with the public cache header, no noindex, and no agent, Turnstile or meter call", async () => {
    const counting = countingDb(db);
    const { app, agent, verify } = build({ db: counting.db });
    const first = await runWithBoard([guest(1), guest(2), guest(3), guest(4)]);
    const second = await runWithBoard([guest(5), guest(6), guest(7)]);
    const unpromoted = await runWithBoard([guest(8), guest(9), guest(10)]);
    for (const [runId, position] of [
      [second.runId, 1],
      [first.runId, 2],
    ] as const) {
      await db.query("INSERT INTO showcase_runs (run_id, position, promoted_at) VALUES ($1::uuid, $2, $3::timestamptz)", [
        runId,
        position,
        NOW.toISOString(),
      ]);
    }
    const before = await snapshot();

    const res = await app.request("/showcase", { headers: { origin: APP_ORIGIN } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(res.headers.get("x-robots-tag")).toBeNull();
    const text = await res.text();
    const body = JSON.parse(text) as { runs: Array<{ runId: string; position: number; guests: Array<{ id: string }> }> };
    expect(body.runs.map((run) => [run.runId, run.position])).toEqual([
      [second.runId, 1],
      [first.runId, 2],
    ]);
    expect(body.runs[0]).toEqual({
      runId: second.runId,
      position: 1,
      showName: "Synthetic Show",
      finishedAt: NOW.toISOString(),
      guests: [5, 6, 7].map((n, i) => ({
        id: second.guestIds[i],
        name: `Synthetic Guest ${n}`,
        fit: n / 100,
        fitKnown: true,
        reach: null,
        rising: "steady",
        bringsNew: null,
        sharedTags: [],
      })),
      // No guest shares a tag, so there is nothing to draw.
      kolam: null,
      // This run has no board event, so there is no past-guest check to report.
      pastGuests: null,
    });
    expect(body.runs[1]!.guests.map((shown) => shown.id)).toEqual(first.guestIds.slice(0, 3));
    expect(text).not.toContain(unpromoted.runId);
    expect(text).not.toContain(first.guestIds[3]);

    const head = await app.request("/showcase", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("cache-control")).toBe("public, max-age=60");

    expect(await snapshot()).toBe(before);
    expect(agent.startRun).not.toHaveBeenCalled();
    expect(agent.continueRun).not.toHaveBeenCalled();
    expect(agent.writeBrief).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(counting.texts.length).toBeGreaterThan(0);
    expect(counting.texts.filter((query) => /usage_buckets|app_flags|inflight/.test(query))).toHaveLength(0);
    expect(counting.texts.filter((query) => !/^\s*SELECT\b/i.test(query))).toHaveLength(0);
  });

  it("gives each run its guests' shared tags and a kolam drawn from their ids and tag counts (C3.9)", async () => {
    const { app } = build();
    const tags = [["jazz", "MARKER-k1"], ["late-night radio"], ["film", "food", "travel", "books", "chess"]];
    const shown = await runWithBoard([...tags.map((sharedTags, k) => ({ ...guest(k + 1), sharedTags })), guest(4)]);
    await db.query("INSERT INTO showcase_runs (run_id, position, promoted_at) VALUES ($1::uuid, 1, $2::timestamptz)", [
      shown.runId,
      NOW.toISOString(),
    ]);

    const body = (await (await app.request("/showcase")).json()) as {
      runs: Array<{ runId: string; guests: Array<{ id: string; sharedTags: string[] }>; kolam: Kolam | null }>;
    };
    const [run] = body.runs;
    expect(run!.guests.map((entry) => entry.sharedTags)).toEqual(tags);
    const expected = kolamFor(
      shown.runId,
      shown.guestIds.slice(0, 3).map((guestId, k) => ({ guestId, fitRank: k + 1, tagCount: tags[k]!.length })),
    );
    expect(expected).not.toBeNull();
    expect(run!.kolam).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(run!.kolam?.rings.map((ring) => ring.guestId)).toEqual(shown.guestIds.slice(0, 3));
    expect(run!.kolam?.dots).toHaveLength(8);
    expect(JSON.stringify(run!.kolam)).not.toContain("MARKER-k1");
    expect(JSON.stringify(run!.kolam)).not.toContain(shown.guestIds[3]);
  });
});

describe("everything else", () => {
  it("gives 404 for every other path and method, with no list of runs (C6.1)", async () => {
    const { app } = build();
    const runId = await createRun(db, INPUT, NOW);
    const cases: Array<[string, string]> = [
      ["GET", "/runs"],
      ["GET", "/runs/"],
      ["PUT", `/runs/${runId}`],
      ["DELETE", `/runs/${runId}`],
      ["PATCH", "/runs"],
      ["POST", "/health"],
      ["GET", `/runs/${runId}/candidates`],
      ["GET", "/admin"],
      ["GET", "/"],
    ];
    for (const [method, path] of cases) {
      const res = await app.request(path, { method });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(await res.json()).toEqual({ error: "NOT_FOUND" });
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });

  it("allows cross-origin reads only from the app origin, with no credentials", async () => {
    const { app } = build();
    const preflight = await app.request("/runs", {
      method: "OPTIONS",
      headers: { origin: APP_ORIGIN, "access-control-request-method": "POST" },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET,POST");
    expect(preflight.headers.get("access-control-allow-headers")).toBe("Content-Type,Last-Event-ID");
    expect(preflight.headers.get("access-control-allow-credentials")).toBeNull();
    expect(preflight.headers.get("x-content-type-options")).toBe("nosniff");

    const evil = await app.request("/health", { headers: { origin: "https://evil.example" } });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    const ours = await app.request("/health", { headers: { origin: APP_ORIGIN } });
    expect(ours.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    expect(ours.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

describe("onError (C3.6)", () => {
  function captureLog(): string[] {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    return lines;
  }

  it("answers 500 INTERNAL and logs only the route pattern and a fixed code", async () => {
    const lines = captureLog();
    const { app } = build();
    app.get("/boom/:id", () => {
      throw new Error(`upstream said ${MARKER}`);
    });
    const res = await app.request("/boom/123");
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "INTERNAL" });
    expect(text).not.toContain(MARKER);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(MARKER);
    expect(JSON.parse(lines[0]!)).toEqual({ level: "error", route: "/boom/:id", code: "UNEXPECTED" });
  });

  it("logs a database failure by its code, never the driver message", async () => {
    const lines = captureLog();
    const failing: Db = {
      query: () => Promise.reject(new Error(MARKER)),
      transaction: () => Promise.reject(new Error(MARKER)),
      close: async () => {},
    };
    const { app } = build({ db: failing });
    const res = await app.request(`/runs/${randomUUID()}`);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain(MARKER);
    expect(JSON.parse(text)).toEqual({ error: "INTERNAL" });
    expect(lines.join("\n")).not.toContain(MARKER);
    expect(JSON.parse(lines[0]!)).toEqual({ level: "error", route: "/runs/:id", code: "SRV_UNAVAILABLE" });
  });
});

function captureConsole(): string[] {
  const lines: string[] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
  }
  return lines;
}

describe("refusal logs (6e, C3.6)", () => {
  it("writes exactly one line per refusal, holding only the level, the route pattern and the code", async () => {
    const lines = captureConsole();
    const { app } = build();
    const { runId, candidateIds } = await awaitingRun([{ title: "SmartLess" }]);
    const refusals: Array<[() => Promise<Response>, number, { level: string; route: string; code: string }]> = [
      [() => start(app, { show: "SmartLess", turnstileToken: "tok", note: MARKER }), 400, { level: "warn", route: "/runs", code: "BAD_INPUT" }],
      [
        () => postJson(app, `/runs/${runId}/confirm`, { candidateId: candidateIds[0] }, { origin: "https://evil.example" }),
        403,
        { level: "warn", route: "/runs/:id/confirm", code: "FORBIDDEN_ORIGIN" },
      ],
      [() => postJson(app, "/agent-keys", { turnstileToken: "tok", visitor: MARKER }), 400, { level: "warn", route: "/agent-keys", code: "BAD_INPUT" }],
    ];

    for (const [send, status, line] of refusals) {
      lines.length = 0;
      const res = await send();
      expect(res.status, line.route).toBe(status);
      expect(await res.json()).toEqual({ error: line.code });
      expect(lines.map((text) => JSON.parse(text) as unknown)).toEqual([line]);
    }
  });

  it("logs a 404 under the route pattern, never the path the caller sent", async () => {
    const lines = captureConsole();
    const { app } = build();
    const cases: Array<[string, string]> = [
      [`/admin/${MARKER}`, "unmatched"],
      [`/runs/${MARKER}`, "/runs/:id"],
      [`/runs/${MARKER}/briefs/${MARKER}`, "/runs/:id/briefs/:guestId"],
    ];

    for (const [path, route] of cases) {
      lines.length = 0;
      const res = await app.request(path, { headers: { [IP_HEADER]: VISITOR } });
      expect(res.status, path).toBe(404);
      expect(lines, path).toHaveLength(1);
      expect(lines[0]).not.toContain(MARKER);
      expect(lines[0]).not.toContain(VISITOR);
      expect(JSON.parse(lines[0]!)).toEqual({ level: "warn", route, code: "NOT_FOUND" });
    }
  });
});

// Made on the real clock by default, which the app also reads, so the run is
// well inside its confirm window.
async function awaitingRun(candidates: unknown[], createdAt = new Date()): Promise<{ runId: string; candidateIds: string[] }> {
  const runId = await createRun(db, INPUT, createdAt);
  await setRunStatus(db, runId, "awaiting_confirm", undefined, createdAt);
  return { runId, candidateIds: await putCandidates(db, runId, candidates) };
}

describe("POST /runs/:id/confirm", () => {
  it("continues only with a candidate this run issued, and only once (C6.2)", async () => {
    const { app, agent, verify } = build();
    const mine = await awaitingRun([{ title: "SmartLess" }, { title: "SmartLess Live" }]);
    const theirs = await awaitingRun([{ title: "Other" }]);
    const confirm = (runId: string, body: unknown, headers = {}) =>
      postJson(app, `/runs/${runId}/confirm`, body, headers);
    const before = await snapshot();

    const refusals: Array<[Promise<Response>, number, string]> = [
      [confirm(mine.runId, { candidateId: theirs.candidateIds[0] }), 404, "UNKNOWN_CANDIDATE"],
      [confirm(mine.runId, { candidateId: randomUUID() }), 404, "UNKNOWN_CANDIDATE"],
      [confirm(mine.runId, { candidateId: mine.candidateIds[0]!.toUpperCase() }), 404, "UNKNOWN_CANDIDATE"],
      [confirm(mine.runId, { candidateId: mine.candidateIds[0], url: "http://127.0.0.1/" }), 400, "BAD_INPUT"],
      [confirm(mine.runId, { candidateId: "SmartLess" }), 400, "BAD_INPUT"],
      [confirm(mine.runId, { candidateId: mine.candidateIds[0] }, { origin: "https://evil.example" }), 403, "FORBIDDEN_ORIGIN"],
      [confirm(randomUUID(), { candidateId: mine.candidateIds[0] }), 404, "NOT_FOUND"],
      [confirm("not-a-uuid", { candidateId: mine.candidateIds[0] }), 404, "NOT_FOUND"],
    ];
    for (const [pending, status, error] of refusals) {
      const res = await pending;
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error });
    }
    expect(agent.continueRun).not.toHaveBeenCalled();
    expect(await snapshot()).toBe(before);
    expect((await getRun(db, mine.runId))?.status).toBe("awaiting_confirm");

    const ok = await confirm(mine.runId, { candidateId: mine.candidateIds[1] });
    expect(ok.status).toBe(202);
    expect(await ok.json()).toEqual({ ok: true });
    expect(agent.continueRun).toHaveBeenCalledExactlyOnceWith(mine.runId, mine.candidateIds[1]);
    expect((await getRun(db, mine.runId))?.status).toBe("running");

    const again = await confirm(mine.runId, { candidateId: mine.candidateIds[0] });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "NOT_AWAITING" });

    const racing = await Promise.all([
      confirm(theirs.runId, { candidateId: theirs.candidateIds[0] }),
      confirm(theirs.runId, { candidateId: theirs.candidateIds[0] }),
    ]);
    expect(racing.map((res) => res.status).sort()).toEqual([202, 409]);
    expect(agent.continueRun).toHaveBeenCalledTimes(2);
    expect(verify).not.toHaveBeenCalled();
  });

  it("obeys the kill switch and the in-flight cap, and frees its slot when the run settles (C5.7, C5.8)", async () => {
    let finish: () => void = () => {};
    const { app, agent } = build({
      config: { maxInflightRuns: 1 },
      agent: { continueRun: () => new Promise<void>((resolve) => (finish = resolve)) },
    });
    const first = await awaitingRun([{ title: "SmartLess" }]);
    const second = await awaitingRun([{ title: "SmartLess" }]);
    const confirm = (run: { runId: string; candidateIds: string[] }) =>
      postJson(app, `/runs/${run.runId}/confirm`, { candidateId: run.candidateIds[0] });

    await setFlag(db, "live_runs", false);
    const off = await confirm(first);
    expect(off.status).toBe(503);
    expect(await off.json()).toEqual({ error: "LIVE_RUNS_OFF" });
    expect((await getRun(db, first.runId))?.status).toBe("awaiting_confirm");
    await setFlag(db, "live_runs", true);

    expect((await confirm(first)).status).toBe(202);
    const busy = await confirm(second);
    expect(busy.status).toBe(429);
    expect(await busy.json()).toEqual({ error: "BUSY" });
    expect((await getRun(db, second.runId))?.status).toBe("awaiting_confirm");

    finish();
    await vi.waitFor(async () => expect((await db.query("SELECT n FROM inflight WHERE slot = 'runs'")).rows).toEqual([{ n: 0 }]), SETTLE);
    expect((await confirm(second)).status).toBe(202);
    expect(agent.continueRun).toHaveBeenCalledTimes(2);
  });

  it("fails the run with AGENT_ERROR when the continuation rejects (C6.4)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { app } = build({ agent: { continueRun: async () => Promise.reject(new Error(MARKER)) } });
    const { runId, candidateIds } = await awaitingRun([{ title: "SmartLess" }]);
    expect((await postJson(app, `/runs/${runId}/confirm`, { candidateId: candidateIds[0] })).status).toBe(202);
    await vi.waitFor(async () => expect((await getRun(db, runId))?.errorCode).toBe("AGENT_ERROR"), SETTLE);
    expect(await listEventsAfter(db, runId, 0)).toEqual([{ seq: 1, event: "failed", data: { code: "AGENT_ERROR" } }]);
  });

  it("closes a run that waited more than 30 minutes as failed with CONFIRM_EXPIRED and answers 410, starting nothing (C6.4)", async () => {
    const late = build({ now: () => new Date(NOW.getTime() + 31 * 60_000) });
    const { runId, candidateIds } = await awaitingRun([{ title: "SmartLess" }], NOW);
    const confirm = () => postJson(late.app, `/runs/${runId}/confirm`, { candidateId: candidateIds[0] });

    const expired = await confirm();
    expect(expired.status).toBe(410);
    expect(await expired.json()).toEqual({ error: "CONFIRM_EXPIRED" });
    expect(await getRun(db, runId)).toMatchObject({ status: "failed", errorCode: "CONFIRM_EXPIRED" });
    expect(await listEventsAfter(db, runId, 0)).toEqual([{ seq: 1, event: "failed", data: { code: "CONFIRM_EXPIRED" } }]);
    expect(late.agent.continueRun).not.toHaveBeenCalled();
    expect(await inflight()).toBe(0);

    const again = await confirm();
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "NOT_AWAITING" });
    expect(await inflight()).toBe(0);

    const onTime = build({ now: () => new Date(NOW.getTime() + 29 * 60_000) });
    const fresh = await awaitingRun([{ title: "SmartLess" }], NOW);
    expect((await postJson(onTime.app, `/runs/${fresh.runId}/confirm`, { candidateId: fresh.candidateIds[0] })).status).toBe(202);
    expect(onTime.agent.continueRun).toHaveBeenCalledExactlyOnceWith(fresh.runId, fresh.candidateIds[0]);
    await settled(0);
  });

  it("keeps a run awaiting its confirm through the restart sweep, so the visitor can still confirm it (audit A1-N2)", async () => {
    const { app, agent } = build();
    const { runId, candidateIds } = await awaitingRun([{ title: "SmartLess" }]);

    expect(await failInterruptedRuns(db)).toBe(0);
    expect((await getRun(db, runId))?.status).toBe("awaiting_confirm");

    const res = await postJson(app, `/runs/${runId}/confirm`, { candidateId: candidateIds[0] });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(agent.continueRun).toHaveBeenCalledExactlyOnceWith(runId, candidateIds[0]);
    await settled(0);
  });

  it("answers a confirm on a done run 409 NOT_AWAITING with live runs on, never reading the kill switch or touching a slot (audit A3-1)", async () => {
    const counting = countingDb(db);
    const { app, agent } = build({ db: counting.db });
    const { runId, candidateIds } = await awaitingRun([{ title: "SmartLess" }]);
    await setRunStatus(db, runId, "running");
    await setRunStatus(db, runId, "done");
    const before = await snapshot();

    for (let i = 0; i < 10; i += 1) {
      const res = await postJson(app, `/runs/${runId}/confirm`, { candidateId: candidateIds[0] });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "NOT_AWAITING" });
    }

    expect(counting.texts.length).toBeGreaterThan(0);
    expect(counting.texts.filter((text) => /inflight|app_flags/.test(text))).toEqual([]);
    expect(await snapshot()).toBe(before);
    expect(agent.continueRun).not.toHaveBeenCalled();
  });

  it("still gives the loser of two racing confirms 409 from the status claim, and its slot back", async () => {
    // Holds each status claim until both confirms hold a slot, so both are
    // past the early status check when the claim decides between them.
    const texts: string[] = [];
    let slotsTaken = 0;
    let bothHoldSlots = (): void => {};
    const gate = new Promise<void>((resolve) => (bothHoldSlots = resolve));
    const wrap = (target: Db): Db => ({
      query: async <R = Record<string, unknown>>(text: string, params?: unknown[]) => {
        texts.push(text);
        if (text.startsWith("UPDATE runs SET status = $3")) await gate;
        const result = await target.query<R>(text, params);
        if (text.startsWith("UPDATE inflight SET n = n + 1")) {
          slotsTaken += 1;
          if (slotsTaken === 2) bothHoldSlots();
        }
        return result;
      },
      transaction: <T>(fn: (handle: Db) => Promise<T>) => target.transaction((handle) => fn(wrap(handle))),
      close: () => target.close(),
    });
    const { app, agent } = build({ db: wrap(db) });
    const { runId, candidateIds } = await awaitingRun([{ title: "SmartLess" }]);
    const confirm = () => postJson(app, `/runs/${runId}/confirm`, { candidateId: candidateIds[0] });

    const results = await Promise.all([confirm(), confirm()]);

    expect(results.map((res) => res.status).sort()).toEqual([202, 409]);
    expect(await results.find((res) => res.status === 409)!.json()).toEqual({ error: "NOT_AWAITING" });
    expect(texts.filter((text) => text.startsWith("UPDATE runs SET status = $3"))).toHaveLength(2);
    expect(agent.continueRun).toHaveBeenCalledExactlyOnceWith(runId, candidateIds[0]);
    await settled(0);
    expect(texts.filter((text) => text.startsWith("UPDATE inflight SET n = n - 1"))).toHaveLength(2);
  });
});

describe("the website's doors on an MCP run (D4.1)", () => {
  it("answers confirm and brief with 404 NOT_FOUND, as for an unknown run, before any claim, cap or agent call", async () => {
    const counting = countingDb(db);
    const { app, agent } = build({ db: counting.db });
    const { id: tokenId } = await issueToken(db);
    const origin = { surface: "mcp", tokenId } as const;
    const awaiting = await createRun(db, INPUT, new Date(), origin);
    await setRunStatus(db, awaiting, "awaiting_confirm");
    const [candidateId] = await putCandidates(db, awaiting, [{ title: "SmartLess" }]);
    const done = await createRun(db, INPUT, NOW, origin);
    await setRunStatus(db, done, "running", undefined, NOW);
    const [guestId] = await putBoard(db, done, [storedGuest(1, [])]);
    await setRunStatus(db, done, "done", undefined, NOW);
    const before = await snapshot();

    const doors: Array<[string, unknown]> = [
      [`/runs/${awaiting}/confirm`, { candidateId }],
      [`/runs/${done}/confirm`, { candidateId }],
      [`/runs/${done}/brief`, { guestId }],
      [`/runs/${awaiting}/brief`, { guestId }],
    ];
    for (const [path, body] of doors) {
      const res = await postJson(app, path, body);
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual({ error: "NOT_FOUND" });
    }

    // Each request read its run and nothing else: no flag, cap, candidate,
    // board or claim was touched.
    expect(counting.texts).toHaveLength(doors.length);
    for (const text of counting.texts) expect(text).toMatch(/^SELECT .* FROM runs WHERE id = \$1::uuid$/);
    expect(await snapshot()).toBe(before);
    expect(agent.continueRun).not.toHaveBeenCalled();
    expect(agent.writeBrief).not.toHaveBeenCalled();
    expect((await getRun(db, awaiting))?.status).toBe("awaiting_confirm");
  });
});

describe("POST /runs/:id/brief", () => {
  it("writes a brief only for a guest on a finished run's board, once per guest (C6.2, C5.8)", async () => {
    const { app, agent } = build();
    const brief = (runId: string, body: unknown) => postJson(app, `/runs/${runId}/brief`, body);
    const guests = Array.from({ length: 7 }, (_, i) => ({ name: `guest ${i}` }));
    const { runId, guestIds } = await runWithBoard(guests);
    const { guestIds: elsewhere } = await runWithBoard([{ name: "elsewhere" }]);

    const unfinished = await createRun(db, INPUT, NOW);
    await setRunStatus(db, unfinished, "running", undefined, NOW);
    const [early] = await putBoard(db, unfinished, [{ name: "early" }]);

    const refusals: Array<[Promise<Response>, number, string]> = [
      [brief(unfinished, { guestId: early }), 409, "NOT_READY"],
      [brief(runId, { guestId: randomUUID() }), 404, "UNKNOWN_GUEST"],
      [brief(runId, { guestId: elsewhere[0] }), 404, "UNKNOWN_GUEST"],
      [brief(runId, { guestId: guestIds[0], name: "Barack Obama" }), 400, "BAD_INPUT"],
      [brief(runId, { name: "Barack Obama" }), 400, "BAD_INPUT"],
      [brief(randomUUID(), { guestId: guestIds[0] }), 404, "NOT_FOUND"],
    ];
    for (const [pending, status, error] of refusals) {
      const res = await pending;
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error });
    }
    expect(agent.writeBrief).not.toHaveBeenCalled();

    const together = await Promise.all([brief(runId, { guestId: guestIds[0] }), brief(runId, { guestId: guestIds[0] })]);
    for (const res of together) {
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ status: "pending" });
    }
    expect(agent.writeBrief).toHaveBeenCalledExactlyOnceWith(runId, guestIds[0]);
    expect((await brief(runId, { guestId: guestIds[0] })).status).toBe(202);
    expect(agent.writeBrief).toHaveBeenCalledTimes(1);

    for (let i = 1; i < 5; i += 1) expect((await brief(runId, { guestId: guestIds[i] })).status).toBe(202);
    const sixth = await brief(runId, { guestId: guestIds[5] });
    expect(sixth.status).toBe(429);
    expect(await sixth.json()).toEqual({ error: "BRIEF_LIMIT" });
    expect(agent.writeBrief).toHaveBeenCalledTimes(5);
  });

  it("serves a stored brief from storage without calling the agent", async () => {
    const { app, agent } = build();
    const { runId, guestIds } = await runWithBoard([{ name: "guest" }]);
    await db.query(
      "INSERT INTO run_briefs (run_id, guest_id, data, created_at) VALUES ($1::uuid, $2::uuid, $3::json, $4::timestamptz)",
      [runId, guestIds[0], JSON.stringify(syntheticBrief(1)), NOW.toISOString()],
    );
    const res = await postJson(app, `/runs/${runId}/brief`, { guestId: guestIds[0] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ brief: shownBrief(1) });
    expect(agent.writeBrief).not.toHaveBeenCalled();
  });

  it("with live runs off, still serves a stored brief but writes no new one (C5.7)", async () => {
    const { app, agent } = build();
    const { runId, guestIds } = await runWithBoard([{ name: "stored" }, { name: "new" }]);
    await db.query(
      "INSERT INTO run_briefs (run_id, guest_id, data, created_at) VALUES ($1::uuid, $2::uuid, $3::json, $4::timestamptz)",
      [runId, guestIds[0], JSON.stringify(syntheticBrief(1)), NOW.toISOString()],
    );
    await setFlag(db, "live_runs", false);
    expect((await postJson(app, `/runs/${runId}/brief`, { guestId: guestIds[0] })).status).toBe(200);
    const off = await postJson(app, `/runs/${runId}/brief`, { guestId: guestIds[1] });
    expect(off.status).toBe(503);
    expect(await off.json()).toEqual({ error: "LIVE_RUNS_OFF" });
    expect((await db.query("SELECT count(*)::int AS n FROM run_brief_claims")).rows).toEqual([{ n: 0 }]);
    expect(agent.writeBrief).not.toHaveBeenCalled();
  });

  it("only logs a rejected brief, leaving the finished run and its board alone", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const { app } = build({ agent: { writeBrief: async () => Promise.reject(new Error(MARKER)) } });
    const { runId, guestIds } = await runWithBoard([{ name: "guest" }]);
    const boardBefore = await listBoard(db, runId);
    expect((await postJson(app, `/runs/${runId}/brief`, { guestId: guestIds[0] })).status).toBe(202);
    await vi.waitFor(() => expect(lines).toHaveLength(1), SETTLE);
    expect(JSON.parse(lines[0]!)).toEqual({ level: "error", route: "agent.writeBrief", code: "UNEXPECTED" });
    expect((await getRun(db, runId))?.status).toBe("done");
    expect(await listBoard(db, runId)).toEqual(boardBefore);
    expect(await listEventsAfter(db, runId, 0)).toEqual([]);
  });

  it("writes a failed brief once more, then answers 409 BRIEF_FAILED with its code (C5.8)", async () => {
    // Fails the way the real runner does: the claim is marked with only the code.
    const writeBrief: AgentPort["writeBrief"] = async (runId, guestId) => {
      await markBriefFailed(db, runId, guestId, "MODEL_TIMEOUT");
    };
    const { app, agent } = build({ agent: { writeBrief } });
    const { runId, guestIds } = await runWithBoard([{ name: "guest" }]);
    const guestId = guestIds[0]!;
    const ask = () => postJson(app, `/runs/${runId}/brief`, { guestId });

    const first = await ask();
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ status: "pending" });
    await vi.waitFor(async () =>
      expect(await getBriefClaim(db, runId, guestId)).toEqual({ status: "failed", attempts: 1, errorCode: "MODEL_TIMEOUT" }),
      SETTLE,
    );

    const second = await ask();
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual({ status: "pending" });
    expect(agent.writeBrief).toHaveBeenCalledTimes(2);
    expect(agent.writeBrief).toHaveBeenNthCalledWith(2, runId, guestId);
    await vi.waitFor(async () =>
      expect(await getBriefClaim(db, runId, guestId)).toEqual({ status: "failed", attempts: 2, errorCode: "MODEL_TIMEOUT" }),
      SETTLE,
    );

    const lines = captureConsole();
    for (let i = 0; i < 2; i += 1) {
      const refused = await ask();
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({ error: "BRIEF_FAILED", code: "MODEL_TIMEOUT" });
    }
    // Logged like every other refusal, with the fixed code and not the stored one.
    const line = { level: "warn", route: "/runs/:id/brief", code: "BRIEF_FAILED" };
    expect(lines.map((text) => JSON.parse(text) as unknown)).toEqual([line, line]);
    expect(agent.writeBrief).toHaveBeenCalledTimes(2);
    expect((await getRun(db, runId))?.status).toBe("done");
  });

  it("treats a brief a budget refused as never asked for: GET says none, POST asks again only with live runs on, and no attempt is spent (audit A1-9)", async () => {
    // Refuses the way the real runner does when the model budget is used up.
    let budgetLeft = false;
    const writeBrief: AgentPort["writeBrief"] = async (runId, guestId) => {
      if (!budgetLeft) {
        await markBriefFailed(db, runId, guestId, "MODEL_BUDGET");
        return;
      }
      await putBrief(db, runId, guestId, syntheticBrief(1));
      await markBriefDone(db, runId, guestId);
    };
    const { app, agent } = build({ agent: { writeBrief } });
    const { runId, guestIds } = await runWithBoard([storedGuest(1, [])]);
    const guestId = guestIds[0]!;
    const ask = () => postJson(app, `/runs/${runId}/brief`, { guestId });
    const read = async () => (await app.request(`/runs/${runId}/briefs/${guestId}`)).json();
    const deferredAfter = async (calls: number) =>
      vi.waitFor(async () => {
        expect(agent.writeBrief).toHaveBeenCalledTimes(calls);
        expect(await getBriefClaim(db, runId, guestId)).toEqual({ status: "deferred", attempts: 1, errorCode: "MODEL_BUDGET" });
      }, SETTLE);

    expect((await ask()).status).toBe(202);
    await deferredAfter(1);
    expect(await read()).toEqual({ status: "none" });

    await setFlag(db, "live_runs", false);
    const off = await ask();
    expect(off.status).toBe(503);
    expect(await off.json()).toEqual({ error: "LIVE_RUNS_OFF" });
    expect(agent.writeBrief).toHaveBeenCalledTimes(1);
    await setFlag(db, "live_runs", true);

    expect((await ask()).status).toBe(202);
    await deferredAfter(2);

    budgetLeft = true;
    expect((await ask()).status).toBe(202);
    await vi.waitFor(async () => expect(await read()).toEqual({ status: "done", brief: shownBrief(1) }), SETTLE);
    expect(await getBriefClaim(db, runId, guestId)).toEqual({ status: "done", attempts: 1, errorCode: null });
    expect(agent.writeBrief).toHaveBeenCalledTimes(3);
  });

  it("with live runs off, answers a twice-failed brief 409 and a pending one 202, and refuses only new model spend with 503 (C5.7)", async () => {
    const { app, agent } = build();
    const { runId, guestIds } = await runWithBoard([{ name: "twice" }, { name: "new" }, { name: "pending" }, { name: "once" }]);
    const [twice, fresh, pending, once] = guestIds as [string, string, string, string];
    await claimBrief(db, runId, twice, 5, NOW);
    await markBriefFailed(db, runId, twice, "MODEL_TIMEOUT");
    await claimBrief(db, runId, twice, 5, NOW);
    await markBriefFailed(db, runId, twice, "AGENT_BAD_PROSE");
    await claimBrief(db, runId, pending, 5, NOW);
    await claimBrief(db, runId, once, 5, NOW);
    await markBriefFailed(db, runId, once, "MODEL_TIMEOUT");
    await setFlag(db, "live_runs", false);
    const before = await snapshot();
    const ask = (guestId: string) => postJson(app, `/runs/${runId}/brief`, { guestId });

    const failed = await ask(twice);
    expect(failed.status).toBe(409);
    expect(await failed.json()).toEqual({ error: "BRIEF_FAILED", code: "AGENT_BAD_PROSE" });
    const waiting = await ask(pending);
    expect(waiting.status).toBe(202);
    expect(await waiting.json()).toEqual({ status: "pending" });
    // A brand-new brief and the one retry of a failed brief would both call the model.
    for (const guestId of [fresh, once]) {
      const off = await ask(guestId);
      expect(off.status).toBe(503);
      expect(await off.json()).toEqual({ error: "LIVE_RUNS_OFF" });
    }

    expect(await snapshot()).toBe(before);
    expect(agent.writeBrief).not.toHaveBeenCalled();
    expect(await getBriefClaim(db, runId, once)).toEqual({ status: "failed", attempts: 1, errorCode: "MODEL_TIMEOUT" });
    expect(await getBriefClaim(db, runId, fresh)).toBeNull();
  });

  it("with the unavailable agent, refuses every brief with 503 AGENT_NOT_READY before claiming, so no attempt is spent", async () => {
    const app = createApp({
      db,
      config: CONFIG,
      verifyTurnstile: async () => true,
      agent: createUnavailableAgent(db),
      socketAddress: () => null,
    });
    const { runId, guestIds } = await runWithBoard([{ name: "guest" }]);
    const guestId = guestIds[0]!;
    const before = await snapshot();

    for (let i = 0; i < 3; i += 1) {
      const res = await postJson(app, `/runs/${runId}/brief`, { guestId });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "AGENT_NOT_READY" });
    }

    expect(await getBriefClaim(db, runId, guestId)).toBeNull();
    expect(await snapshot()).toBe(before);
    expect(await (await app.request(`/runs/${runId}/briefs/${guestId}`)).json()).toEqual({ status: "none" });
    expect((await getRun(db, runId))?.status).toBe("done");
  });
});

describe("briefs on a promoted run (C6.3)", () => {
  it("answers POST for a missing brief 409 BRIEF_NOT_READY, with live runs on or off, and never claims or calls the agent", async () => {
    const { app, agent } = build();
    const { runId, guestIds } = await runWithBoard([storedGuest(1, []), storedGuest(2, []), storedGuest(3, [])]);
    const [, missing, once] = guestIds as [string, string, string];
    await claimBrief(db, runId, once, 5, NOW);
    await markBriefFailed(db, runId, once, "MODEL_TIMEOUT");
    // Placed by hand, because promote itself refuses a run with a missing brief.
    await db.query("INSERT INTO showcase_runs (run_id, position, promoted_at) VALUES ($1::uuid, 1, $2::timestamptz)", [
      runId,
      NOW.toISOString(),
    ]);
    const before = await snapshot();

    for (const live of [true, false]) {
      await setFlag(db, "live_runs", live);
      for (const guestId of [missing, once]) {
        const res = await postJson(app, `/runs/${runId}/brief`, { guestId });
        expect(res.status, `live ${live}`).toBe(409);
        expect(await res.json()).toEqual({ error: "BRIEF_NOT_READY" });
      }
    }

    expect(await snapshot()).toBe(before);
    expect(agent.writeBrief).not.toHaveBeenCalled();
    expect(await getBriefClaim(db, runId, missing)).toBeNull();
    expect(await getBriefClaim(db, runId, once)).toEqual({ status: "failed", attempts: 1, errorCode: "MODEL_TIMEOUT" });
  });

  it("serves every stored brief with live runs off, through POST and GET alike (C5.7)", async () => {
    const { app, agent } = build();
    const { runId, guestIds } = await runWithBoard([storedGuest(1, []), storedGuest(2, []), storedGuest(3, [])]);
    await storeBriefs(db, runId, guestIds);
    await promoteRun(db, runId, 1);
    await setFlag(db, "live_runs", false);

    for (const [index, guestId] of guestIds.entries()) {
      const posted = await postJson(app, `/runs/${runId}/brief`, { guestId });
      expect(posted.status).toBe(200);
      expect(await posted.json()).toEqual({ brief: shownBrief(index + 1) });
      const read = await app.request(`/runs/${runId}/briefs/${guestId}`);
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual({ status: "done", brief: shownBrief(index + 1) });
    }
    expect(agent.writeBrief).not.toHaveBeenCalled();
  });
});

describe("GET /runs/:id/briefs/:guestId", () => {
  it("reports none, pending, failed and done from storage alone, with no agent, Turnstile or meter call (C5.4)", async () => {
    const counting = countingDb(db);
    const { app, agent, verify } = build({ db: counting.db });
    const { runId, guestIds } = await runWithBoard([{ name: "none" }, { name: "pending" }, { name: "failed" }, { name: "done" }]);
    await claimBrief(db, runId, guestIds[1]!, 5, NOW);
    await claimBrief(db, runId, guestIds[2]!, 5, NOW);
    await markBriefFailed(db, runId, guestIds[2]!, "MODEL_TIMEOUT");
    await claimBrief(db, runId, guestIds[3]!, 5, NOW);
    await putBrief(db, runId, guestIds[3]!, syntheticBrief(4), NOW);
    await markBriefDone(db, runId, guestIds[3]!);
    const before = await snapshot();

    const expected = [
      { status: "none" },
      { status: "pending" },
      { status: "failed", code: "MODEL_TIMEOUT" },
      { status: "done", brief: shownBrief(4) },
    ];
    for (const [i, body] of expected.entries()) {
      const res = await app.request(`/runs/${runId}/briefs/${guestIds[i]}`, { headers: { origin: APP_ORIGIN } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(body);
      expect(res.headers.get("x-robots-tag")).toBe("noindex");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    const head = await app.request(`/runs/${runId}/briefs/${guestIds[1]}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

    expect(await snapshot()).toBe(before);
    expect(agent.startRun).toHaveBeenCalledTimes(0);
    expect(agent.continueRun).toHaveBeenCalledTimes(0);
    expect(agent.writeBrief).toHaveBeenCalledTimes(0);
    expect(verify).toHaveBeenCalledTimes(0);
    expect(counting.texts.length).toBeGreaterThan(0);
    expect(counting.texts.filter((text) => text.includes("usage_buckets"))).toHaveLength(0);
    expect(counting.texts.filter((text) => !/^\s*SELECT\b/i.test(text))).toHaveLength(0);
  });

  it("gives 404 for an unknown run and for a guest not on that run's board", async () => {
    const { app } = build();
    const { runId, guestIds } = await runWithBoard([{ name: "guest" }]);
    const { guestIds: elsewhere } = await runWithBoard([{ name: "elsewhere" }]);
    const cases: Array<[string, string]> = [
      [`/runs/${randomUUID()}/briefs/${guestIds[0]}`, "NOT_FOUND"],
      [`/runs/not-a-uuid/briefs/${guestIds[0]}`, "NOT_FOUND"],
      [`/runs/${runId}/briefs/${elsewhere[0]}`, "UNKNOWN_GUEST"],
      [`/runs/${runId}/briefs/${randomUUID()}`, "UNKNOWN_GUEST"],
      [`/runs/${runId}/briefs/${guestIds[0]!.toUpperCase()}`, "UNKNOWN_GUEST"],
      [`/runs/${runId}/briefs/Barack%20Obama`, "UNKNOWN_GUEST"],
    ];
    for (const [path, error] of cases) {
      const res = await app.request(path);
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual({ error });
      expect(res.headers.get("x-robots-tag")).toBe("noindex");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });
});

describe("the brief a visitor reads (C6.5, audit A3-3)", () => {
  it("shows only the five named fields and the first 5 questions, on POST and GET alike", async () => {
    const { app, agent } = build();
    const { runId, guestIds } = await runWithBoard([storedGuest(1, [])]);
    const guestId = guestIds[0]!;
    const questions = ["One?", "Two?", "Three?", "Four?", "Five?", "Six?", "Seven?"];
    await putBrief(db, runId, guestId, { ...syntheticBrief(1), questions, internal: MARKER }, NOW);
    const shown = { ...shownBrief(1), questions: questions.slice(0, 5) };

    const posted = await postJson(app, `/runs/${runId}/brief`, { guestId });
    expect(posted.status).toBe(200);
    const postedText = await posted.text();
    expect(JSON.parse(postedText)).toEqual({ brief: shown });
    const read = await app.request(`/runs/${runId}/briefs/${guestId}`);
    const readText = await read.text();
    expect(JSON.parse(readText)).toEqual({ status: "done", brief: shown });
    for (const text of [postedText, readText]) {
      for (const absent of [MARKER, "internal", "removed", "pitch_subject", "Six?"]) expect(text, absent).not.toContain(absent);
    }
    expect(agent.writeBrief).not.toHaveBeenCalled();
  });

  it("reads a stored brief that fails its schema as missing: GET reports the claim, POST goes on to claim it", async () => {
    const { app, agent } = build();
    const { runId, guestIds } = await runWithBoard([storedGuest(1, [])]);
    const guestId = guestIds[0]!;
    await putBrief(db, runId, guestId, { ...syntheticBrief(1), why: 5, angle: MARKER }, NOW);
    const read = async () => {
      const text = await (await app.request(`/runs/${runId}/briefs/${guestId}`)).text();
      expect(text).not.toContain(MARKER);
      return JSON.parse(text) as unknown;
    };

    expect(await read()).toEqual({ status: "none" });
    const posted = await postJson(app, `/runs/${runId}/brief`, { guestId });
    expect(posted.status).toBe(202);
    const postedText = await posted.text();
    expect(postedText).not.toContain(MARKER);
    expect(JSON.parse(postedText)).toEqual({ status: "pending" });
    expect(agent.writeBrief).toHaveBeenCalledExactlyOnceWith(runId, guestId);
    expect(await read()).toEqual({ status: "pending" });
  });

  // A done claim is never claimed again, so these two would otherwise wait at pending for good.
  async function doneButUnreadable(): Promise<{ runId: string; guestId: string }> {
    const { runId, guestIds } = await runWithBoard([storedGuest(1, [])]);
    const guestId = guestIds[0]!;
    await claimBrief(db, runId, guestId, 5, NOW);
    await putBrief(db, runId, guestId, { ...syntheticBrief(1), why: 5, angle: MARKER }, NOW);
    await markBriefDone(db, runId, guestId);
    return { runId, guestId };
  }

  // The brief and claim reads in the order the route made them.
  const briefReads = (texts: string[]) =>
    texts.filter((text) => /FROM run_brief(s|_claims) /.test(text)).map((text) => (text.includes("FROM run_briefs ") ? "brief" : "claim"));

  it("answers GET for a done claim whose stored brief fails its schema as failed with BRIEF_UNREADABLE, from storage alone", async () => {
    const counting = countingDb(db);
    const { app, agent } = build({ db: counting.db });
    const { runId, guestId } = await doneButUnreadable();
    const before = await snapshot();

    const res = await app.request(`/runs/${runId}/briefs/${guestId}`);

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(MARKER);
    expect(JSON.parse(text)).toEqual({ status: "failed", code: "BRIEF_UNREADABLE" });
    // Unreadable on a read made after the done claim was read, not only on the first.
    expect(briefReads(counting.texts)).toEqual(["brief", "claim", "brief"]);
    expect(await snapshot()).toBe(before);
    expect(agent.writeBrief).not.toHaveBeenCalled();
  });

  it("answers POST for a done claim whose stored brief fails its schema 409 BRIEF_FAILED with BRIEF_UNREADABLE, never 202, live runs on or off", async () => {
    const counting = countingDb(db);
    const { app, agent } = build({ db: counting.db });
    const { runId, guestId } = await doneButUnreadable();
    const before = await snapshot();

    for (const live of [true, false]) {
      await setFlag(db, "live_runs", live);
      counting.texts.length = 0;
      const res = await postJson(app, `/runs/${runId}/brief`, { guestId });
      expect(res.status, `live ${live}`).toBe(409);
      const text = await res.text();
      expect(text).not.toContain(MARKER);
      expect(JSON.parse(text)).toEqual({ error: "BRIEF_FAILED", code: "BRIEF_UNREADABLE" });
      expect(briefReads(counting.texts)).toEqual(["brief", "claim", "brief"]);
    }
    await setFlag(db, "live_runs", true);

    expect(await snapshot()).toBe(before);
    expect(agent.writeBrief).not.toHaveBeenCalled();
    expect(await getBriefClaim(db, runId, guestId)).toEqual({ status: "done", attempts: 1, errorCode: null });
  });

  // The runner finishing between the route's first brief read and its claim
  // read: that read sees no brief, and the claim it reads next is done. The
  // runner stores the brief before it marks the claim done, as here.
  async function briefLandsDuringFirstRead(): Promise<{ racing: Db; runId: string; guestId: string }> {
    const { runId, guestIds } = await runWithBoard([storedGuest(1, [])]);
    const guestId = guestIds[0]!;
    await claimBrief(db, runId, guestId, 5, NOW);
    let landed = false;
    const racing: Db = {
      query: async <R = Record<string, unknown>>(text: string, params?: unknown[]) => {
        const result = await db.query<R>(text, params);
        if (!landed && text.includes("FROM run_briefs ")) {
          landed = true;
          await putBrief(db, runId, guestId, syntheticBrief(1), NOW);
          await markBriefDone(db, runId, guestId);
        }
        return result;
      },
      transaction: (fn) => db.transaction(fn),
      close: async () => {},
    };
    return { racing, runId, guestId };
  }

  it("answers GET done for a brief the runner finished between the route's brief and claim reads, never failed (audit R2)", async () => {
    const { racing, runId, guestId } = await briefLandsDuringFirstRead();
    const { app, agent } = build({ db: racing });

    const res = await app.request(`/runs/${runId}/briefs/${guestId}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "done", brief: shownBrief(1) });
    expect(agent.writeBrief).not.toHaveBeenCalled();
  });

  it("answers POST 200 with a brief the runner finished between the route's brief and claim reads, never 409 (audit R2)", async () => {
    const { racing, runId, guestId } = await briefLandsDuringFirstRead();
    const { app, agent } = build({ db: racing });

    const res = await postJson(app, `/runs/${runId}/brief`, { guestId });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ brief: shownBrief(1) });
    expect(agent.writeBrief).not.toHaveBeenCalled();
    expect(await getBriefClaim(db, runId, guestId)).toEqual({ status: "done", attempts: 1, errorCode: null });
  });
});
