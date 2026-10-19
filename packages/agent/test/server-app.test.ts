// Covers the agent server's HTTP routes through app.request() on a migrated
// PGlite database, with a stub human check, a spy agent and a stub socket
// address, plus the run-store functions those routes added. It does not cover
// the real Turnstile call or a real socket (the live smoke does), races
// between separate database connections (PGlite has one), the vasal_app
// grants, the event stream (server-stream.test.ts), or the real agent loop.
import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPort } from "../src/server/agent-port.js";
import { createApp, type AppDeps } from "../src/server/app.js";
import type { ServerConfig } from "../src/server/config.js";
import { ServerError } from "../src/server/errors.js";
import {
  appendEvent,
  claimBrief,
  claimRunStatus,
  createRun,
  getRun,
  listBoard,
  listCandidates,
  listEventsAfter,
  putBoard,
  putCandidates,
  setRunStatus,
  type RunInput,
} from "../src/server/runs.js";
import type { Db } from "../src/store/db.js";
import { setFlag } from "../src/store/flags.js";
import { setBucket } from "../src/store/meter.js";
import { migratedPglite } from "./helpers/pglite.js";

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
  ];
  const results = [];
  for (const text of tables) results.push((await db.query(text)).rows);
  return JSON.stringify(results);
}

async function settled(expected = 0): Promise<void> {
  await vi.waitFor(async () => expect(await inflight()).toBe(expected));
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
});

describe("POST /runs", () => {
  it("starts a run for a checked visitor and hands the agent only the checked input", async () => {
    const { app, agent, verify } = build();
    const res = await start(app, { show: "  Café Society  ", exclude: [" Kevin  "], turnstileToken: "tok-1" });
    expect(res.status).toBe(202);
    const { runId } = (await res.json()) as { runId: string };
    expect(runId).toMatch(UUID);

    expect(verify).toHaveBeenCalledExactlyOnceWith("tok-1", VISITOR);
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
    expect(socket.verify).toHaveBeenCalledExactlyOnceWith("tok", "198.51.100.4");
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

    await vi.waitFor(() => expect(settle).toHaveLength(2));
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
    });
    expect(JSON.stringify(await (await app.request(`/runs/${runId}`)).json())).not.toContain("feeds.example");

    await setRunStatus(db, runId, "done", undefined, NOW);
    const done = (await (await app.request(`/runs/${runId}`)).json()) as { board: unknown[]; finishedAt: string };
    expect(done.board).toEqual([
      { name: "first", id: guestIds[0] },
      { name: "second", id: guestIds[1] },
    ]);
    expect(done.finishedAt).toBe(NOW.toISOString());
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

async function awaitingRun(candidates: unknown[]): Promise<{ runId: string; candidateIds: string[] }> {
  const runId = await createRun(db, INPUT, NOW);
  await setRunStatus(db, runId, "awaiting_confirm", undefined, NOW);
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
    await vi.waitFor(async () => expect((await db.query("SELECT n FROM inflight")).rows).toEqual([{ n: 0 }]));
    expect((await confirm(second)).status).toBe(202);
    expect(agent.continueRun).toHaveBeenCalledTimes(2);
  });

  it("fails the run with AGENT_ERROR when the continuation rejects (C6.4)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { app } = build({ agent: { continueRun: async () => Promise.reject(new Error(MARKER)) } });
    const { runId, candidateIds } = await awaitingRun([{ title: "SmartLess" }]);
    expect((await postJson(app, `/runs/${runId}/confirm`, { candidateId: candidateIds[0] })).status).toBe(202);
    await vi.waitFor(async () => expect((await getRun(db, runId))?.errorCode).toBe("AGENT_ERROR"));
    expect(await listEventsAfter(db, runId, 0)).toEqual([{ seq: 1, event: "failed", data: { code: "AGENT_ERROR" } }]);
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
      [runId, guestIds[0], JSON.stringify({ text: "stored" }), NOW.toISOString()],
    );
    const res = await postJson(app, `/runs/${runId}/brief`, { guestId: guestIds[0] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ brief: { text: "stored" } });
    expect(agent.writeBrief).not.toHaveBeenCalled();
  });

  it("with live runs off, still serves a stored brief but writes no new one (C5.7)", async () => {
    const { app, agent } = build();
    const { runId, guestIds } = await runWithBoard([{ name: "stored" }, { name: "new" }]);
    await db.query(
      "INSERT INTO run_briefs (run_id, guest_id, data, created_at) VALUES ($1::uuid, $2::uuid, $3::json, $4::timestamptz)",
      [runId, guestIds[0], JSON.stringify({ text: "stored" }), NOW.toISOString()],
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
    await vi.waitFor(() => expect(lines).toHaveLength(1));
    expect(JSON.parse(lines[0]!)).toEqual({ level: "error", route: "agent.writeBrief", code: "UNEXPECTED" });
    expect((await getRun(db, runId))?.status).toBe("done");
    expect(await listBoard(db, runId)).toEqual(boardBefore);
    expect(await listEventsAfter(db, runId, 0)).toEqual([]);
  });
});
