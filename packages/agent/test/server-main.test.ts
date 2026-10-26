// Covers createApp's drain, which main.ts's stop awaits so a deploy gives
// runs and briefs in flight up to 12 seconds to finish, on a migrated PGlite
// database with runs started through POST /runs, a brief through POST
// /runs/:id/brief and a fake agent. It does not cover main.ts's stop itself
// (main.ts starts the server when it is imported, so it has no seam), the
// shutdown log line, MCP runs (drain does not count them), or Railway's own
// drain.
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentPort } from "../src/server/agent-port.js";
import { createApp } from "../src/server/app.js";
import type { ServerConfig } from "../src/server/config.js";
import { createRun, putBoard, setRunStatus } from "../src/server/runs.js";
import { createPgliteDb, type Db } from "../src/store/db.js";
import { setFlag } from "../src/store/flags.js";
import { migrate } from "../src/store/migrate.js";

const APP_ORIGIN = "http://localhost:3000";
const IP_HEADER = "x-test-client-ip";
const POST_HEADERS = { origin: APP_ORIGIN, "content-type": "application/json", [IP_HEADER]: "203.0.113.7" };
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

type App = ReturnType<typeof createApp>;
type Job = { ms: number; fails?: boolean };

let db: Db;
let app: App | undefined;
// Each timer still waiting, so cleanup can end every run and brief before
// the database closes under them.
const waiting: Array<() => void> = [];

beforeEach(async () => {
  db = await createPgliteDb();
  await migrate(db);
  await setFlag(db, "live_runs", true);
});

afterEach(async () => {
  for (const finish of waiting.splice(0)) finish();
  await app?.drain(5_000);
  app = undefined;
  await db.close();
});

// Settles after `ms`, counted from the moment the route hands the agent the
// work, or at once when cleanup lets it go.
function later(ms: number, fails = false): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const settle = () => (fails ? reject(new Error("agent failed")) : resolve());
    const timer = setTimeout(settle, ms);
    waiting.push(() => {
      clearTimeout(timer);
      settle();
    });
  });
}

// The agent's startRun for the nth run settles as jobs[n] says, and each
// brief is written after briefMs, its guest id then added to `written`.
function build(jobs: Job[], briefMs = 0, written: string[] = []): App {
  let next = 0;
  const agent: AgentPort = {
    startRun: () => {
      const job = jobs[next++]!;
      return later(job.ms, job.fails);
    },
    continueRun: async () => {},
    writeBrief: async (_runId, guestId) => {
      await later(briefMs);
      written.push(guestId);
    },
  };
  app = createApp({ db, config: CONFIG, verifyTurnstile: async () => true, agent, socketAddress: () => null });
  return app;
}

async function startRun(target: App): Promise<string> {
  const response = await target.request("/runs", {
    method: "POST",
    headers: POST_HEADERS,
    body: JSON.stringify({ show: "SmartLess", turnstileToken: "tok" }),
  });
  expect(response.status).toBe(202);
  return ((await response.json()) as { runId: string }).runId;
}

async function slotsHeld(): Promise<number> {
  const { rows } = await db.query<{ n: number }>("SELECT n FROM inflight WHERE slot = 'runs'");
  return rows[0]!.n;
}

async function timed(work: () => Promise<number>): Promise<{ left: number; ms: number }> {
  const started = performance.now();
  const left = await work();
  return { left, ms: performance.now() - started };
}

describe("drain", () => {
  it("resolves when the time is up with the count still running", async () => {
    const target = build([{ ms: 50 }, { ms: 5_000 }]);
    await startRun(target);
    await startRun(target);

    const { left, ms } = await timed(() => target.drain(200));

    expect(left).toBe(1);
    // A timer may fire a few milliseconds early against this clock. The bound
    // above is loose for a busy machine and still far short of 5 seconds.
    expect(ms).toBeGreaterThanOrEqual(180);
    expect(ms).toBeLessThan(1_500);
    expect(await slotsHeld()).toBe(1);
  });

  it("resolves as soon as every run has settled, after a failed run's failure is written, with 0", async () => {
    const target = build([{ ms: 50 }, { ms: 80, fails: true }]);
    await startRun(target);
    const failing = await startRun(target);

    const { left, ms } = await timed(() => target.drain(5_000));

    expect(left).toBe(0);
    expect(ms).toBeLessThan(1_500);
    const { rows } = await db.query<{ status: string; error_code: string | null }>(
      "SELECT status, error_code FROM runs WHERE id = $1::uuid",
      [failing],
    );
    expect(rows).toEqual([{ status: "failed", error_code: "AGENT_ERROR" }]);
    expect(await slotsHeld()).toBe(0);
  });

  it("waits for a brief the website is writing", async () => {
    const written: string[] = [];
    const target = build([], 150, written);
    const runId = await createRun(db, { show: "SmartLess", exclude: [] });
    const [guestId] = await putBoard(db, runId, [{ name: "Synthetic Guest" }]);
    await setRunStatus(db, runId, "done");
    const response = await target.request(`/runs/${runId}/brief`, {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({ guestId }),
    });
    expect(response.status).toBe(202);
    expect(written).toEqual([]);

    const { left, ms } = await timed(() => target.drain(5_000));

    expect(left).toBe(0);
    expect(written).toEqual([guestId]);
    expect(ms).toBeLessThan(1_500);
  });

  it("resolves at once with 0 when nothing is running", async () => {
    const target = build([]);

    const { left, ms } = await timed(() => target.drain(5_000));

    expect(left).toBe(0);
    expect(ms).toBeLessThan(1_000);
  });
});
