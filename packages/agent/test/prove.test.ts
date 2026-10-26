// Covers the remote proof script's checks against the real app on PGlite,
// reached through fetch stand-ins: one that plays an edge replacing the
// client address header, one that passes it through, and one with no server,
// plus a stub that answers only the agent-key probe, and the exit code.
// It does not cover a real network, a real edge, or real Turnstile; the run
// against the local dev server and the deployed one does.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exitCodeFor, prove, type CheckLine, type ProveOptions } from "../scripts/prove.js";
import { MCP_ENABLED_FLAG } from "../src/mcp/tokens.js";
import { promoteRun } from "../src/ops/promote.js";
import { createUnavailableAgent } from "../src/server/agent-port.js";
import { createApp, type AppDeps } from "../src/server/app.js";
import type { ServerConfig } from "../src/server/config.js";
import { createRun, finishRun, putBoard, setRunStatus } from "../src/server/runs.js";
import type { Db } from "../src/store/db.js";
import { setFlag } from "../src/store/flags.js";
import { storeBriefs } from "./helpers/briefs.js";
import { migratedPglite } from "./helpers/pglite.js";

const APP_ORIGIN = "https://vasal.site";
const EDGE_ADDRESS = "203.0.113.9";
const CONFIG: ServerConfig = {
  production: false,
  port: 8787,
  appOrigin: APP_ORIGIN,
  databaseUrl: null,
  databaseNetwork: null,
  visitorHashSecret: "v".repeat(32),
  turnstileSecret: "test-secret",
  clientIpHeader: "x-real-ip",
  runsPerVisitorPerDay: 5,
  maxInflightRuns: 3,
  anthropicApiKey: null,
  model: "claude-haiku-5-5",
  effort: "medium",
  anthropicTokensPerDay: 2_000_000,
  trends: false,
};

// In the shape the agent runner stores, with no Qloo data in it (C7.3).
const GUESTS = [1, 2, 3].map((n) => ({
  personId: `00000000-0000-4000-8000-00000000070${n}`,
  name: `Synthetic Guest ${n}`,
  fit: (90 - n * 10) / 100,
  fitKnown: true,
  fitRank: n,
  reach: "bookable",
  rising: { state: "steady", points: 0 },
  bringsNew: null,
  sharedTags: [`tag ${n}`, "shared"],
  angle: "A synthetic angle for the proof test.",
  showName: "Synthetic Show",
}));

let db: Db;

beforeEach(async () => {
  db = await migratedPglite();
  await setFlag(db, "live_runs", true);
});

afterEach(async () => {
  await db.close();
});

async function promotedRun(): Promise<string> {
  const runId = await createRun(db, { show: "Synthetic Show", exclude: [] });
  await setRunStatus(db, runId, "running");
  const guestIds = await putBoard(db, runId, GUESTS);
  await finishRun(db, runId, "done", { name: "done", data: { guests: GUESTS.length } });
  await storeBriefs(db, runId, guestIds);
  await promoteRun(db, runId, 1);
  return runId;
}

type Edge = "replaces" | "passes";

function server(edge: Edge, verifyTurnstile: AppDeps["verifyTurnstile"] = async () => false): typeof fetch {
  const app = createApp({
    db,
    config: CONFIG,
    verifyTurnstile,
    agent: createUnavailableAgent(db),
    socketAddress: () => null,
    streamPollMs: 20,
  });
  return async (input, init) => {
    const request = new Request(input, init);
    if (edge === "replaces") request.headers.set("x-real-ip", EDGE_ADDRESS);
    return app.fetch(request);
  };
}

const options = (fetchImpl: typeof fetch, extra: Partial<ProveOptions> = {}): ProveOptions => ({
  base: new URL("http://agent.test/"),
  origin: APP_ORIGIN,
  allowEmptyShowcase: false,
  fetchImpl,
  ...extra,
});

const outcomes = (lines: CheckLine[]) => Object.fromEntries(lines.map((line) => [line.name, line.outcome]));

describe("prove", () => {
  it("passes every check against a server with a promoted run behind an edge that sets the address", async () => {
    await promotedRun();
    await setFlag(db, MCP_ENABLED_FLAG, true);

    const lines = await prove(options(server("replaces")));

    expect(outcomes(lines)).toEqual({
      health: "PASS",
      showcase: "PASS",
      run: "PASS",
      events: "PASS",
      "runs from a foreign site": "PASS",
      "agent keys from a foreign site": "PASS",
      "mcp without a key": "PASS",
      "mcp by GET": "PASS",
      "mcp preflight": "PASS",
      "unknown path": "PASS",
      "X-Real-IP comma probe": "PASS",
      "X-Real-IP agent-key probe": "PASS",
    });
    const reasons = Object.fromEntries(lines.map((line) => [line.name, line.reason]));
    expect(reasons["showcase"]).toBe("1 promoted; the first has 3 guests, 6 shared tags and a kolam with 3 rings");
    expect(reasons["events"]).toMatch(/^first frame in \d+ ms, 1 frame parsed, ending with done$/);
    expect(reasons["X-Real-IP comma probe"]).toMatch(/^partial: 403 HUMAN_CHECK_FAILED/);
    expect(reasons["X-Real-IP agent-key probe"]).toMatch(/^403 HUMAN_CHECK_FAILED/);
    expect(exitCodeFor(lines)).toBe(0);
  });

  it("warns when the comma list reaches the server, and with MCP off skips the agent-key probe and fails nothing", async () => {
    await promotedRun();

    const lines = await prove(options(server("passes")));

    expect(outcomes(lines)["X-Real-IP comma probe"]).toBe("WARN");
    expect(outcomes(lines)["X-Real-IP agent-key probe"]).toBe("SKIP");
    expect(lines.filter((line) => line.outcome === "FAIL")).toEqual([]);
    expect(exitCodeFor(lines)).toBe(0);
  });

  it("fails the whole run when MCP is on and the edge passes a client-written X-Real-IP through (audit A3-N1)", async () => {
    await promotedRun();
    await setFlag(db, MCP_ENABLED_FLAG, true);

    const lines = await prove(options(server("passes")));

    expect(lines.filter((line) => line.outcome === "FAIL").map((line) => line.name)).toEqual(["X-Real-IP agent-key probe"]);
    expect(lines.find((line) => line.name === "X-Real-IP agent-key probe")?.reason).toMatch(/^400 NO_CLIENT_ADDRESS/);
    expect(exitCodeFor(lines)).toBe(1);
  });

  it("sends the agent-key probe with the app's Origin, a bad X-Real-IP and the dummy token, and maps each answer", async () => {
    const issued = "vsl_MARKER-a9e1-never-printed";
    const cases: Array<[number, unknown, string]> = [
      [403, { error: "HUMAN_CHECK_FAILED" }, "PASS"],
      [503, { error: "MCP_OFF" }, "SKIP"],
      [400, { error: "NO_CLIENT_ADDRESS" }, "FAIL"],
      [201, { token: issued, expiresAt: "2026-11-24T00:00:00.000Z" }, "FAIL"],
      [403, { error: "FORBIDDEN_ORIGIN" }, "FAIL"],
      [500, { error: "INTERNAL" }, "FAIL"],
    ];
    for (const [status, body, outcome] of cases) {
      const sent: Request[] = [];
      // Answers only the probe; every other check gets a 404 and is not looked at here.
      const stub: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        if (request.method === "POST" && new URL(request.url).pathname === "/agent-keys" && request.headers.has("x-real-ip")) {
          sent.push(request);
          return Response.json(body, { status });
        }
        return Response.json({ error: "NOT_FOUND" }, { status: 404 });
      };

      const lines = await prove(options(stub, { allowEmptyShowcase: true }));

      const probe = lines.find((line) => line.name === "X-Real-IP agent-key probe");
      expect(probe?.outcome, `${status} ${JSON.stringify(body)}`).toBe(outcome);
      expect(JSON.stringify(lines)).not.toContain(issued);
      expect(sent).toHaveLength(1);
      const [request] = sent;
      expect(request!.headers.get("origin")).toBe(APP_ORIGIN);
      expect(request!.headers.get("x-real-ip")).toBe("not-an-address");
      expect(request!.headers.get("content-type")).toBe("application/json");
      expect(await request!.json()).toEqual({ turnstileToken: "XXXX.DUMMY.TOKEN.XXXX" });
    }
  });

  it("skips an empty showcase only when allowed, and then skips the run and its stream", async () => {
    const allowed = outcomes(await prove(options(server("replaces"), { allowEmptyShowcase: true })));
    expect([allowed["showcase"], allowed["run"], allowed["events"]]).toEqual(["SKIP", "SKIP", "SKIP"]);

    expect(outcomes(await prove(options(server("replaces"))))["showcase"]).toBe("FAIL");
  });

  it("fails the probe when the dummy token passes the human check", async () => {
    const lines = await prove(options(server("replaces", async () => true), { allowEmptyShowcase: true }));

    const probe = lines.find((line) => line.name === "X-Real-IP comma probe");
    expect(probe?.outcome).toBe("FAIL");
    expect(probe?.reason).toContain("202");
  });

  it("fails the probe when --origin is not the server's origin", async () => {
    const lines = await prove(options(server("replaces"), { origin: "https://other.example", allowEmptyShowcase: true }));

    expect(lines.find((line) => line.name === "X-Real-IP comma probe")?.outcome).toBe("FAIL");
  });

  it("fails every request check with a fixed reason when nothing answers", async () => {
    const down: typeof fetch = () => Promise.reject(new Error("connect ECONNREFUSED MARKER-0b7d"));

    const lines = await prove(options(down, { allowEmptyShowcase: true }));

    expect(lines.filter((line) => line.outcome !== "FAIL").map((line) => line.name)).toEqual(["run", "events"]);
    expect(JSON.stringify(lines)).not.toContain("MARKER");
  });
});
