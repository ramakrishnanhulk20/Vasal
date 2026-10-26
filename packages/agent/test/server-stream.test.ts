// Covers GET /runs/:id/events through app.request() on a migrated PGlite
// database: replay after Last-Event-ID, the ways a stream ends, pings, the
// per-run and site-wide stream caps, frame safety and the reach a board or
// Without Qloo event streams with. It does not cover a
// real socket or a browser's EventSource (the live smoke uses curl), proxies
// that buffer, or streams spread over several server processes, whose counts
// are separate.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPort } from "../src/server/agent-port.js";
import { createApp, type AppDeps } from "../src/server/app.js";
import type { ServerConfig } from "../src/server/config.js";
import { ServerError } from "../src/server/errors.js";
import { appendEvent, createRun, listEventsAfter, setRunStatus } from "../src/server/runs.js";
import { SSE_PING } from "../src/server/sse.js";
import type { Db } from "../src/store/db.js";
import { migratedPglite } from "./helpers/pglite.js";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const CONFIG: ServerConfig = {
  production: false,
  port: 8787,
  appOrigin: "http://localhost:3000",
  databaseUrl: null,
  databaseNetwork: null,
  visitorHashSecret: "v".repeat(32),
  turnstileSecret: "test-secret",
  clientIpHeader: "x-test-client-ip",
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

// PGlite 0.5.10 can spin forever inside its WASM Postgres when a query
// reaches it while close() runs, so every stream is ended first. PGlite runs
// queries one at a time in order, so once the barrier query returns, a stream
// that was mid-query has resumed, seen it is closed, and stopped.
afterEach(async () => {
  for (const res of opened) await res.body?.cancel().catch(() => {});
  await db.query("SELECT 1");
  await db.close();
});

function build(extra: Partial<Pick<AppDeps, "now" | "streamPollMs" | "streamLifetimeMs" | "maxOpenStreams">> = {}) {
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
    streamLifetimeMs: 5_000,
    ...extra,
  });
}

async function openRun(): Promise<string> {
  const runId = await createRun(db, { show: "SmartLess", exclude: [] }, NOW);
  await setRunStatus(db, runId, "running", undefined, NOW);
  return runId;
}

type Frame = { id: number; event: string; data: unknown; lines: string[] };

function framesOf(text: string): Frame[] {
  return text
    .split("\n\n")
    .filter((block) => block !== "" && !block.startsWith(":"))
    .map((block) => {
      const lines = block.split("\n");
      const field = (name: string) => lines.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
      return { id: Number(field("id")), event: field("event") ?? "", data: JSON.parse(field("data") ?? "null"), lines };
    });
}

async function readUntil(res: Response, done: (text: string) => boolean): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!done(text)) {
    const { value, done: ended } = await reader.read();
    if (ended) break;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  return text;
}

async function events(app: ReturnType<typeof build>, runId: string, headers: Record<string, string> = {}) {
  const res = await app.request(`/runs/${runId}/events`, { headers });
  opened.push(res);
  return res;
}

describe("GET /runs/:id/events", () => {
  it("replays the events after Last-Event-ID 2 and ends after a failed event", async () => {
    const runId = await openRun();
    for (const step of ["search", "feed", "rank"]) await appendEvent(db, runId, "step", { tool: step }, NOW);
    await appendEvent(db, runId, "failed", { code: "QLOO_LIMIT" }, NOW);
    await appendEvent(db, runId, "step", { tool: "after the end" }, NOW);

    const res = await events(build(), runId, { "last-event-id": "2" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    const frames = framesOf(await res.text());
    expect(frames.map(({ id, event, data }) => ({ id, event, data }))).toEqual([
      { id: 3, event: "step", data: { tool: "rank" } },
      { id: 4, event: "failed", data: { code: "QLOO_LIMIT" } },
    ]);
  });

  it("ignores a Last-Event-ID that is not a plain number and replays from the start (C6.1)", async () => {
    const runId = await openRun();
    await appendEvent(db, runId, "step", { tool: "search" }, NOW);
    await appendEvent(db, runId, "done", {}, NOW);
    const app = build();
    for (const header of ["abc", "-1", "1e3", "2.0", "99999999999999999"]) {
      const frames = framesOf(await (await events(app, runId, { "last-event-id": header })).text());
      expect(frames.map((frame) => frame.id), header).toEqual([1, 2]);
    }
  });

  it("ends a finished, drained run even without a closing event, and ends at the lifetime", async () => {
    const finished = await openRun();
    await appendEvent(db, finished, "step", { tool: "search" }, NOW);
    await setRunStatus(db, finished, "failed", "SERVER_RESTART", NOW);
    expect(framesOf(await (await events(build(), finished)).text()).map((frame) => frame.id)).toEqual([1]);

    const stillRunning = await openRun();
    const startedAt = Date.now();
    const text = await (await events(build({ streamLifetimeMs: 150 }), stillRunning)).text();
    expect(text).toBe("");
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it("sends a ping once 15 seconds pass on the server clock", async () => {
    const runId = await openRun();
    let tick = 0;
    const app = build({ now: () => new Date(NOW.getTime() + tick++ * 8_000) });
    const text = await readUntil(await events(app, runId), (seen) => seen.includes(SSE_PING));
    expect(text).toBe(SSE_PING);
  });

  it("refuses a fourth open stream for one run and frees a place when a stream closes (C5.8)", async () => {
    const runId = await openRun();
    const app = build();
    const open = await Promise.all([events(app, runId), events(app, runId), events(app, runId)]);
    expect(open.map((res) => res.status)).toEqual([200, 200, 200]);

    const fourth = await events(app, runId);
    expect(fourth.status).toBe(429);
    expect(await fourth.json()).toEqual({ error: "TOO_MANY_STREAMS" });
    for (let i = 0; i < 3; i += 1) expect((await app.request(`/runs/${runId}/events`, { method: "HEAD" })).status).toBe(200);

    const other = await openRun();
    const elsewhere = await events(app, other);
    expect(elsewhere.status).toBe(200);

    await open[0]!.body!.cancel();
    const replacement = await events(app, runId);
    expect(replacement.status).toBe(200);
    for (const res of [open[1]!, open[2]!, replacement, elsewhere]) await res.body!.cancel();
    expect((await events(app, runId)).status).toBe(200);
  });

  it("refuses a stream past the site-wide total with 503 STREAMS_FULL and Retry-After 5, and opens one once a place frees (C5.8)", async () => {
    for (const bad of [0, 1_001, 1.5]) {
      let code: string | undefined;
      try {
        build({ maxOpenStreams: bad });
      } catch (error) {
        code = error instanceof ServerError ? error.code : String(error);
      }
      expect(code, String(bad)).toBe("SRV_BAD_INPUT");
    }
    const app = build({ maxOpenStreams: 2 });
    const [first, second, third] = [await openRun(), await openRun(), await openRun()];
    const open = [await events(app, first), await events(app, second)];
    expect(open.map((res) => res.status)).toEqual([200, 200]);

    const full = await events(app, third);
    expect(full.status).toBe(503);
    expect(full.headers.get("retry-after")).toBe("5");
    expect(await full.json()).toEqual({ error: "STREAMS_FULL" });
    // The total is checked before the run's own cap, which still has room here.
    expect((await events(app, first)).status).toBe(503);

    await open[0]!.body!.cancel();
    expect((await events(app, third)).status).toBe(200);
  });

  it("gives the site-wide place back exactly once whichever way a stream ends: lifetime, done event or client abort", async () => {
    const app = build({ maxOpenStreams: 1, streamLifetimeMs: 300 });
    const running = await openRun();
    const finished = await openRun();
    await appendEvent(db, finished, "done", {}, NOW);

    const timedOut = await events(app, running);
    expect(timedOut.status).toBe(200);
    expect(await timedOut.text()).toBe("");

    const ended = await events(app, finished);
    expect(ended.status).toBe(200);
    expect(framesOf(await ended.text()).map((frame) => frame.event)).toEqual(["done"]);

    const controller = new AbortController();
    const aborted = await app.request(`/runs/${running}/events`, { signal: controller.signal });
    opened.push(aborted);
    expect(aborted.status).toBe(200);
    controller.abort();

    // With a cap of 1, one stream opening and the next refused shows the
    // count came back to exactly 0, not below it.
    expect((await events(app, running)).status).toBe(200);
    expect((await events(app, finished)).status).toBe(503);
  });

  it("keeps a feed title that imitates stream lines inside one data line (C3.3)", async () => {
    const runId = await openRun();
    const title = 'Episode 1\n\nevent: done\ndata: {"board":[]}\n\nid: 99\r\n';
    await appendEvent(db, runId, "step", { tool: "feed", title }, NOW);
    await appendEvent(db, runId, "failed", { code: "AGENT_ERROR" }, NOW);

    const text = await (await events(build(), runId)).text();
    expect(text.split("\n").filter((line) => line.startsWith("event:"))).toEqual(["event: step", "event: failed"]);
    const frames = framesOf(text);
    expect(frames).toHaveLength(2);
    expect(frames[0]!.lines).toHaveLength(3);
    expect(frames[0]!.data).toEqual({ tool: "feed", title });
  });

  it("streams a board event's reach as GET /runs/:id shows it: bookable, none or an unknown label as null, household name as is, the stored row unchanged", async () => {
    const runId = await openRun();
    const guest = (rank: number, reach: string) => ({
      id: randomUUID(),
      name: `Synthetic Guest ${rank}`,
      fit: 0.5,
      fitKnown: true,
      fitRank: rank,
      reach,
      rising: "steady",
    });
    const stored = {
      guests: [guest(1, "bookable"), guest(2, "none"), guest(3, "household name"), guest(4, "famous")],
      pastGuests: { checked: true, skipped: 1, titles: 12, since: "2026-01", source: "directory", candidateId: randomUUID(), archiveTitles: 0 },
    };
    await appendEvent(db, runId, "board", stored, NOW);
    await appendEvent(db, runId, "done", {}, NOW);

    const [board] = framesOf(await (await events(build(), runId)).text());
    expect(board?.event).toBe("board");
    const shown = [null, null, "household name", null];
    expect(board?.data).toEqual({ ...stored, guests: stored.guests.map((row, index) => ({ ...row, reach: shown[index] })) });
    expect((await listEventsAfter(db, runId, 0))[0]?.data).toEqual(stored);
  });

  it("streams a without_qloo event's reach the same way, and leaves its other fields as stored", async () => {
    const runId = await openRun();
    const guess = (name: string, reach: string) => ({ name, fit: 0.4, fitKnown: true, reach, pastGuest: false, host: false, onBoard: true });
    const stored = {
      status: "done",
      guesses: [guess("Synthetic Guess 1", "bookable"), guess("Synthetic Guess 2", "none"), guess("Synthetic Guess 3", "household name")],
      unresolved: 1,
    };
    await appendEvent(db, runId, "without_qloo", stored, NOW);
    await appendEvent(db, runId, "done", {}, NOW);

    const [flip] = framesOf(await (await events(build(), runId)).text());
    expect(flip?.event).toBe("without_qloo");
    expect(flip?.data).toEqual({
      status: "done",
      guesses: [
        { ...guess("Synthetic Guess 1", "bookable"), reach: null },
        { ...guess("Synthetic Guess 2", "none"), reach: null },
        guess("Synthetic Guess 3", "household name"),
      ],
      unresolved: 1,
    });
    expect((await listEventsAfter(db, runId, 0))[0]?.data).toEqual(stored);
  });

  it("gives 404 for an unknown or malformed run id", async () => {
    const app = build();
    for (const id of [randomUUID(), "not-a-uuid"]) {
      const res = await events(app, id);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "NOT_FOUND" });
    }
  });
});
