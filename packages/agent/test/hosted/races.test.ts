// Races every cap and every "only one wins" claim across 50 separate
// connections on hosted Postgres (C5.1, C5.7, C5.8, D3.3, D3.5, D3.6). The
// whole file is skipped unless HOSTED_TEST_DATABASE_URL names a throwaway
// database and HOSTED_TEST_THROWAWAY=yes (see harness.ts). It does not cover
// the routes and tools around these calls (the PGlite suites do), the app
// role's grants (it connects as whatever user the URL names), the per-key
// daily counters in countTokenUse, or callers on more than one machine.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueToken } from "../../src/mcp/tokens.js";
import { acquireTokenInflight, countKeyIssue, MCP_LIMITS } from "../../src/mcp/usage.js";
import { visitorKey } from "../../src/net/visitor-key.js";
import { PromoteError, promoteRun } from "../../src/ops/promote.js";
import {
  acquireInflightSlot,
  acquireMcpRunSlots,
  countVisitorRun,
  releaseInflightSlot,
  resetInflight,
} from "../../src/server/caps.js";
import { KEYS_BUCKET } from "../../src/server/keys-route.js";
import { claimBrief, claimRunStatus, createRun, finishRun, getRun, putBoard, setRunStatus } from "../../src/server/runs.js";
import type { Db } from "../../src/store/db.js";
import { QLOO_PER_SECOND_CAP, reserve, setBucket, usage, waitForQlooSlot } from "../../src/store/meter.js";
import { CONTENDERS, freshSchema, HOSTED_URL, openContenders, race, trackRun } from "./harness.js";

const SECRET = "s".repeat(32);
const DAY_MS = 24 * 60 * 60 * 1_000;
const RACE_TIMEOUT_MS = 120_000;
// The production shapes: config.ts defaults to 3 site places, and MCP may
// hold 1 of them (MCP_RUN_SLOTS in mcp/tools.ts, D3.3).
const SITE_PLACES = 3;
const MCP_PLACES = 1;
// The per-run brief cap app.ts and mcp/tools.ts both pass to claimBrief.
const BRIEFS_PER_RUN = 5;

type Results<T> = Array<{ ok: true; value: T } | { ok: false; error: unknown }>;

let admin: Db;
let contenders: Db[] = [];

const inDays = (days: number): Date => new Date(Date.now() + days * DAY_MS);

function hashOf(address: string): string {
  const key = visitorKey(address, SECRET);
  if (key === null) throw new Error("expected a key");
  return key;
}

// A rejection means the database refused or timed out, which breaks the claim
// under test, so it is never counted as a loser.
function valuesOf<T>(results: Results<T>): T[] {
  expect(results.filter((result) => !result.ok)).toEqual([]);
  return results.flatMap((result) => (result.ok ? [result.value] : []));
}

async function slotCount(slot: "runs" | "mcp"): Promise<number> {
  const { rows } = await admin.query<{ n: number }>("SELECT n FROM inflight WHERE slot = $1", [slot]);
  return rows[0]!.n;
}

async function usedOf(key: string): Promise<number | undefined> {
  return (await usage(admin, key))?.used;
}

// Synthetic guests in the shape the agent runner stores (C7.3).
const guest = (n: number) => ({
  personId: `00000000-0000-4000-8000-0000000005${String(n).padStart(2, "0")}`,
  name: `Synthetic Guest ${n}`,
  fit: n / 100,
  fitKnown: true,
  fitRank: n,
  reach: "bookable",
  rising: { state: "rising", points: 2.5 },
  bringsNew: { segment: "age", label: "listeners 25 to 29", gap: 0.3 },
  sharedTags: ["synthetic taste"],
  angle: "A synthetic angle.",
  showName: "Synthetic Show",
});

// The calls the agent runner makes from start to a finished board.
async function doneRun(db: Db): Promise<{ runId: string; guestIds: string[] }> {
  const runId = trackRun(await createRun(db, { show: "Synthetic Show", exclude: [] }));
  await setRunStatus(db, runId, "running");
  const guestIds = await putBoard(db, runId, [guest(1), guest(2), guest(3)]);
  await finishRun(db, runId, "done", { name: "done", data: { guests: 3 } });
  return { runId, guestIds };
}

class IssueRefused extends Error {}

// The issue transaction exactly as POST /agent-keys runs it (keys-route.ts):
// the visitor's count, then the global bucket, then the key, and a refusal at
// any step rolls back the steps before it.
async function issueKey(db: Db, visitor: string, perVisitorCap: number, now: Date): Promise<boolean> {
  try {
    await db.transaction(async (tx) => {
      if (!(await countKeyIssue(tx, visitor, perVisitorCap, now))) throw new IssueRefused();
      if (!(await reserve(tx, [{ key: KEYS_BUCKET, amount: 1 }], now))) throw new IssueRefused();
      await issueToken(tx);
    });
    return true;
  } catch (error) {
    if (error instanceof IssueRefused) return false;
    throw error;
  }
}

describe.skipIf(HOSTED_URL === undefined)("hosted races (C5, D3)", () => {
  beforeAll(async () => {
    const [first] = await openContenders(1);
    if (first === undefined) throw new Error("expected an admin connection");
    admin = first;
    contenders = await openContenders(CONTENDERS);
  }, RACE_TIMEOUT_MS);

  afterAll(async () => {
    try {
      // Left empty, so the next run of this file passes the guard even though
      // this run's record of its own runs is gone.
      if (admin) await freshSchema(admin);
    } finally {
      await Promise.allSettled([admin, ...contenders].filter((db) => db !== undefined).map((db) => db.close()));
    }
  }, RACE_TIMEOUT_MS);

  it("meter: 50 reservations against a cap of 10 give exactly 10", async () => {
    await freshSchema(admin);
    await setBucket(admin, { key: "race:day", cap: 10, windowEnd: inDays(1) });

    const values = valuesOf(await race(contenders, (db) => reserve(db, [{ key: "race:day", amount: 1 }])));

    expect(values.filter((won) => won)).toHaveLength(10);
    expect(values.filter((won) => !won)).toHaveLength(CONTENDERS - 10);
    expect(await usedOf("race:day")).toBe(10);
  }, RACE_TIMEOUT_MS);

  it("meter: a two-bucket reservation is all or nothing under the race", async () => {
    await freshSchema(admin);
    await setBucket(admin, { key: "race:a", cap: 10, windowEnd: inDays(1) });
    await setBucket(admin, { key: "race:b", cap: 30, windowEnd: inDays(1) });

    const values = valuesOf(
      await race(contenders, (db) =>
        reserve(db, [
          { key: "race:a", amount: 1 },
          { key: "race:b", amount: 1 },
        ]),
      ),
    );

    expect(values.filter((won) => won)).toHaveLength(10);
    expect(await usedOf("race:a")).toBe(10);
    expect(await usedOf("race:b")).toBe(10);
  }, RACE_TIMEOUT_MS);

  it("per-second Qloo slots never pass QLOO_PER_SECOND_CAP in one second", async () => {
    await freshSchema(admin);
    await setBucket(admin, { key: "qloo:month", cap: 1_000_000, windowEnd: inDays(30) });
    await setBucket(admin, { key: "qloo:day", cap: 1_000_000, windowEnd: inDays(1) });

    const values = valuesOf(await race(contenders, (db) => waitForQlooSlot(db, { maxWaitMs: 0 })));

    const successes = values.filter((won) => won).length;
    const { rows } = await admin.query<{ cap: number; used: number }>(
      "SELECT cap::int AS cap, used::int AS used FROM usage_buckets WHERE starts_with(key, $1)",
      ["qloo:second:"],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.cap).toBe(QLOO_PER_SECOND_CAP);
      expect(row.used).toBeLessThanOrEqual(QLOO_PER_SECOND_CAP);
    }
    expect(rows.reduce((sum, row) => sum + row.used, 0)).toBe(successes);
    // With the day and month set high, only a full second can refuse, so a
    // refusal means some second reached the cap exactly.
    if (successes < CONTENDERS) expect(rows.some((row) => row.used === QLOO_PER_SECOND_CAP)).toBe(true);
    expect(await usedOf("qloo:day")).toBe(successes);
    expect(await usedOf("qloo:month")).toBe(successes);
  }, RACE_TIMEOUT_MS);

  it("website in-flight slots: 50 contenders for 3 slots give exactly 3", async () => {
    await freshSchema(admin);

    const values = valuesOf(await race(contenders, (db) => acquireInflightSlot(db, SITE_PLACES)));

    expect(values.filter((won) => won)).toHaveLength(SITE_PLACES);
    expect(await slotCount("runs")).toBe(SITE_PLACES);

    const winners = contenders.filter((_, i) => values[i] === true);
    valuesOf(await race(winners, (db) => releaseInflightSlot(db)));
    expect(await slotCount("runs")).toBe(0);

    // Fifty more releases than places taken must leave the counter at 0.
    valuesOf(await race(contenders, (db) => releaseInflightSlot(db)));
    expect(await slotCount("runs")).toBe(0);
  }, RACE_TIMEOUT_MS);

  it("per-visitor daily runs: exactly the cap succeed", async () => {
    await freshSchema(admin);
    const visitor = hashOf("203.0.113.9");
    const now = new Date();

    const values = valuesOf(await race(contenders, (db) => countVisitorRun(db, visitor, 5, now)));

    expect(values.filter((counted) => counted)).toHaveLength(5);
    const { rows } = await admin.query("SELECT runs FROM visitor_counters WHERE visitor_hash = $1", [visitor]);
    expect(rows).toEqual([{ runs: 5 }]);
  }, RACE_TIMEOUT_MS);

  it("claimRunStatus: exactly one of 50 moves awaiting_confirm to running", async () => {
    await freshSchema(admin);
    const runId = trackRun(await createRun(admin, { show: "Synthetic Show", exclude: [] }));
    await setRunStatus(admin, runId, "running");
    expect(await claimRunStatus(admin, runId, "running", "awaiting_confirm")).toBe(true);

    const values = valuesOf(await race(contenders, (db) => claimRunStatus(db, runId, "awaiting_confirm", "running")));

    expect(values.filter((moved) => moved)).toHaveLength(1);
    expect((await getRun(admin, runId))?.status).toBe("running");
  }, RACE_TIMEOUT_MS);

  it("claimBrief: one brief per guest per run (C5.8, D3.5)", async () => {
    await freshSchema(admin);
    const { runId, guestIds } = await doneRun(admin);
    const guestId = guestIds[0]!;

    const values = valuesOf(await race(contenders, (db) => claimBrief(db, runId, guestId, BRIEFS_PER_RUN)));

    expect(values.filter((claim) => claim === "claimed")).toHaveLength(1);
    expect(values.filter((claim) => claim === "exists")).toHaveLength(CONTENDERS - 1);
    const { rows } = await admin.query(
      "SELECT guest_id::text AS guest_id, status, attempts FROM run_brief_claims WHERE run_id = $1::uuid",
      [runId],
    );
    expect(rows).toEqual([{ guest_id: guestId, status: "pending", attempts: 1 }]);
  }, RACE_TIMEOUT_MS);

  it("promote: one run per position", async () => {
    await freshSchema(admin);
    const runs = await Promise.all(contenders.map((db) => doneRun(db)));

    const results = await race(contenders, (db, i) => promoteRun(db, runs[i]!.runId, 1));

    const winners = results.flatMap((result, i) => (result.ok ? [runs[i]!.runId] : []));
    const refusals = results.flatMap((result) =>
      result.ok ? [] : [result.error instanceof PromoteError ? result.error.code : String(result.error)],
    );
    expect(winners).toHaveLength(1);
    expect(refusals).toEqual(Array.from({ length: CONTENDERS - 1 }, () => "PROMOTE_POSITION_TAKEN"));
    const { rows } = await admin.query("SELECT run_id::text AS run_id, position FROM showcase_runs");
    expect(rows).toEqual([{ run_id: winners[0], position: 1 }]);
  }, RACE_TIMEOUT_MS);

  it("MCP: per-token in-flight cap holds", async () => {
    await freshSchema(admin);
    const { id } = await issueToken(admin);

    const values = valuesOf(
      await race(contenders, (db) => acquireTokenInflight(db, id, MCP_LIMITS.inflightPerToken)),
    );

    expect(values.filter((held) => held)).toHaveLength(MCP_LIMITS.inflightPerToken);
    const { rows } = await admin.query("SELECT n FROM mcp_token_inflight WHERE token_id = $1::uuid", [id]);
    expect(rows).toEqual([{ n: MCP_LIMITS.inflightPerToken }]);
  }, RACE_TIMEOUT_MS);

  it("MCP: a run takes its website slot and the mcp slot together, or neither", async () => {
    await freshSchema(admin);

    const pairs = valuesOf(await race(contenders, (db) => acquireMcpRunSlots(db, MCP_PLACES, SITE_PLACES)));
    expect(pairs.filter((held) => held)).toHaveLength(MCP_PLACES);
    expect(await slotCount("mcp")).toBe(MCP_PLACES);
    expect(await slotCount("runs")).toBe(MCP_PLACES);

    // With MCP at its limit, website starts racing MCP runs still get every
    // place left, and no MCP run gets one (D3.3).
    const mixed = valuesOf(
      await race(contenders, (db, i) =>
        i % 2 === 0 ? acquireInflightSlot(db, SITE_PLACES) : acquireMcpRunSlots(db, MCP_PLACES, SITE_PLACES),
      ),
    );
    expect(mixed.filter((held, i) => held && i % 2 === 0)).toHaveLength(SITE_PLACES - MCP_PLACES);
    expect(mixed.filter((held, i) => held && i % 2 === 1)).toHaveLength(0);
    expect(await slotCount("runs")).toBe(SITE_PLACES);
    expect(await slotCount("mcp")).toBe(MCP_PLACES);

    // With the site full and MCP's own place free, an MCP run must take neither.
    await resetInflight(admin, 0, "mcp");
    await resetInflight(admin, SITE_PLACES);
    const blocked = valuesOf(await race(contenders, (db) => acquireMcpRunSlots(db, MCP_PLACES, SITE_PLACES)));
    expect(blocked.filter((held) => held)).toHaveLength(0);
    expect(await slotCount("mcp")).toBe(0);
    expect(await slotCount("runs")).toBe(SITE_PLACES);
  }, RACE_TIMEOUT_MS);

  it("MCP: key issue never passes its daily cap", async () => {
    await freshSchema(admin);
    const now = new Date();
    await setBucket(admin, { key: KEYS_BUCKET, cap: 1_000, windowEnd: inDays(1) });
    const visitor = hashOf("203.0.113.9");

    const one = valuesOf(await race(contenders, (db) => issueKey(db, visitor, 5, now)));

    expect(one.filter((issued) => issued)).toHaveLength(5);
    const perVisitor = await admin.query("SELECT n FROM mcp_key_issue WHERE visitor_hash = $1", [visitor]);
    expect(perVisitor.rows).toEqual([{ n: 5 }]);
    const firstKeys = await admin.query("SELECT count(*)::int AS n FROM mcp_tokens");
    expect(firstKeys.rows).toEqual([{ n: 5 }]);
    expect(await usedOf(KEYS_BUCKET)).toBe(5);

    // Fifty visitors, each under their own cap, against a global cap of 5.
    await freshSchema(admin);
    await setBucket(admin, { key: KEYS_BUCKET, cap: 5, windowEnd: inDays(1) });

    const many = valuesOf(
      await race(contenders, (db, i) => issueKey(db, hashOf(`203.0.113.${i + 1}`), MCP_LIMITS.keysPerVisitorPerDay, now)),
    );

    expect(many.filter((issued) => issued)).toHaveLength(5);
    const keys = await admin.query("SELECT count(*)::int AS n FROM mcp_tokens");
    expect(keys.rows).toEqual([{ n: 5 }]);
    expect(await usedOf(KEYS_BUCKET)).toBe(5);
    // A refusal at the global bucket rolled the visitor's count back with it.
    const counted = await admin.query("SELECT coalesce(sum(n), 0)::int AS n FROM mcp_key_issue");
    expect(counted.rows).toEqual([{ n: 5 }]);
  }, RACE_TIMEOUT_MS);
});
