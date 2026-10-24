// Covers two limits on GET /runs/:id/events through app.request() on a
// migrated PGlite database: a stream ends once its run waits for a confirm,
// and one visitor holds at most 6 open streams. It does not cover replay,
// pings, the per-run and site-wide caps or frame safety
// (server-stream.test.ts), a real socket or EventSource, or streams spread
// over several server processes, whose counts are separate.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPort } from "../src/server/agent-port.js";
import { createApp, type AppDeps } from "../src/server/app.js";
import type { ServerConfig } from "../src/server/config.js";
import { appendEvent, claimRunStatus, createRun, setRunStatus } from "../src/server/runs.js";
import type { Db } from "../src/store/db.js";
import { migratedPglite } from "./helpers/pglite.js";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const IP_HEADER = "x-test-client-ip";
const VISITOR = "203.0.113.7";
const OTHER_VISITOR = "198.51.100.4";
const CONFIG: ServerConfig = {
  production: false,
  port: 8787,
  appOrigin: "http://localhost:3000",
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
let opened: Response[] = [];

beforeEach(async () => {
  db = await migratedPglite();
  opened = [];
});

// As in server-stream.test.ts: every stream is ended, and one barrier query
// lets a stream that was mid-query see it is closed, before PGlite closes.
afterEach(async () => {
  for (const res of opened) await res.body?.cancel().catch(() => {});
  await db.query("SELECT 1");
  await db.close();
});

function build(extra: Partial<Pick<AppDeps, "streamLifetimeMs">> = {}) {
  const agent: AgentPort = {
    startRun: vi.fn(async () => {}),
    continueRun: vi.fn(async () => {}),
    writeBrief: vi.fn(async () => {}),
  };
  return createApp({
    db,
    config: CONFIG,
    verifyTurnstile: vi.fn(async () => true),
    agent,
    socketAddress: () => null,
    streamPollMs: 5,
    // Long enough that only the route's own rule can end a stream inside a test.
    streamLifetimeMs: 600_000,
    ...extra,
  });
}

async function openRun(): Promise<string> {
  const runId = await createRun(db, { show: "SmartLess", exclude: [] }, NOW);
  await setRunStatus(db, runId, "running", undefined, NOW);
  return runId;
}

async function events(app: ReturnType<typeof build>, runId: string, headers: Record<string, string> = {}) {
  const res = await app.request(`/runs/${runId}/events`, { headers: { [IP_HEADER]: VISITOR, ...headers } });
  opened.push(res);
  return res;
}

// Resolves with the whole body if the server ends the stream within `ms`,
// and with null if it is still open then.
async function bodyWithin(res: Response, ms: number): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([res.text(), late]);
  } finally {
    clearTimeout(timer);
  }
}

const eventNames = (text: string): string[] =>
  text
    .split("\n")
    .filter((line) => line.startsWith("event: "))
    .map((line) => line.slice("event: ".length));

describe("a stream on a run waiting for its confirm", () => {
  it("ends once the candidates frame is sent, and a stream reopened after it ends at once (C5.8)", async () => {
    const runId = await openRun();
    await appendEvent(db, runId, "step", { tool: "search" }, NOW);
    const seq = await appendEvent(db, runId, "candidates", { candidates: [] }, NOW);
    expect(await claimRunStatus(db, runId, "running", "awaiting_confirm", NOW)).toBe(true);
    const app = build();

    const text = await bodyWithin(await events(app, runId), 3_000);
    expect(text).not.toBeNull();
    expect(eventNames(text!)).toEqual(["step", "candidates"]);

    const reopened = await bodyWithin(await events(app, runId, { "last-event-id": String(seq) }), 3_000);
    expect(reopened).toBe("");
  });

  it("stays open while the run is still running, so only the wait for a confirm ends it early", async () => {
    const runId = await openRun();
    await appendEvent(db, runId, "step", { tool: "search" }, NOW);

    expect(await bodyWithin(await events(build(), runId), 300)).toBeNull();
  });
});

describe("open streams per visitor", () => {
  it("refuses a seventh open stream from one visitor with 503 STREAMS_FULL and Retry-After 5, while another visitor still opens one (C5.3, C5.8)", async () => {
    const app = build();
    const [first, second, third] = [await openRun(), await openRun(), await openRun()];
    const mine: Response[] = [];
    for (const runId of [first, first, first, second, second, second]) mine.push(await events(app, runId));
    expect(mine.map((res) => res.status)).toEqual([200, 200, 200, 200, 200, 200]);

    const seventh = await events(app, third!);
    expect(seventh.status).toBe(503);
    expect(seventh.headers.get("retry-after")).toBe("5");
    expect(await seventh.json()).toEqual({ error: "STREAMS_FULL" });
    // Another spelling of the same address is the same visitor.
    expect((await events(app, third!, { [IP_HEADER]: `::ffff:${VISITOR}` })).status).toBe(503);

    expect((await events(app, third!, { [IP_HEADER]: OTHER_VISITOR })).status).toBe(200);

    await mine[0]!.body!.cancel();
    expect((await events(app, third!)).status).toBe(200);
  });

  // Seven in a row from one visitor can all open only if each one that ended
  // gave its place back.
  it("gives the visitor's place back whichever way a stream ends: lifetime, done event or client abort", async () => {
    const app = build({ streamLifetimeMs: 50 });
    const running = await openRun();
    const finished = await openRun();
    await appendEvent(db, finished, "done", {}, NOW);

    for (let i = 0; i < 7; i += 1) {
      const timedOut = await events(app, running);
      expect(timedOut.status).toBe(200);
      expect(await timedOut.text()).toBe("");
    }
    for (let i = 0; i < 7; i += 1) {
      const ended = await events(app, finished);
      expect(ended.status).toBe(200);
      expect(eventNames(await ended.text())).toEqual(["done"]);
    }
    const lasting = build();
    for (let i = 0; i < 7; i += 1) {
      const controller = new AbortController();
      const aborted = await lasting.request(`/runs/${running}/events`, { headers: { [IP_HEADER]: VISITOR }, signal: controller.signal });
      opened.push(aborted);
      expect(aborted.status).toBe(200);
      controller.abort();
    }
  });
});
