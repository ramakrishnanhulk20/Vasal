// Covers the per-visitor daily cap, the site-wide in-progress slots and MCP's
// share of them, the release retry and the reconcile, on PGlite. It does not
// cover races between separate connections (PGlite has one connection, so
// simultaneous calls are serialised; the cross-connection race is proven
// later on hosted Postgres), a reconcile at the moment a run takes or gives
// back its place, the vasal_app grants (mcp-usage.test.ts covers the MCP
// ones), or pruning old counter rows, which is an operator job.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueToken } from "../src/mcp/tokens.js";
import {
  acquireInflightSlot,
  acquireMcpRunSlots,
  countVisitorRun,
  reconcileInflight,
  releaseInflightSlot,
  releaseMcpRunSlots,
  resetInflight,
  visitorRunsAtCap,
} from "../src/server/caps.js";
import { ServerError } from "../src/server/errors.js";
import { createRun, setRunStatus, type RunStatus } from "../src/server/runs.js";
import { visitorKey } from "../src/net/visitor-key.js";
import type { Db } from "../src/store/db.js";
import { migratedPglite } from "./helpers/pglite.js";

const SECRET = "s".repeat(32);
const DAY = new Date("2026-10-19T08:00:00.000Z");
const LATE_SAME_DAY = new Date("2026-10-19T23:59:59.999Z");
const NEXT_DAY = new Date("2026-10-20T00:00:00.000Z");

let db: Db;

beforeEach(async () => {
  db = await migratedPglite();
});

afterEach(async () => {
  await db.close();
});

function hashOf(address: string): string {
  const key = visitorKey(address, SECRET);
  if (key === null) throw new Error("expected a key");
  return key;
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof ServerError ? error.code : String(error);
  }
  return undefined;
}

async function inflight(slot = "runs"): Promise<number> {
  const { rows } = await db.query<{ n: number }>("SELECT n FROM inflight WHERE slot = $1", [slot]);
  return rows[0]!.n;
}

describe("countVisitorRun (C5.3)", () => {
  it("allows exactly 5 per visitor per UTC day, resets the next day, and keeps visitors apart", async () => {
    const alice = hashOf("203.0.113.9");
    const bob = hashOf("2001:db8:1:2::1");

    for (let i = 0; i < 5; i += 1) expect(await countVisitorRun(db, alice, 5, DAY)).toBe(true);
    expect(await countVisitorRun(db, alice, 5, DAY)).toBe(false);
    expect(await countVisitorRun(db, alice, 5, LATE_SAME_DAY)).toBe(false);

    expect(await countVisitorRun(db, bob, 5, LATE_SAME_DAY)).toBe(true);
    expect(await countVisitorRun(db, alice, 5, NEXT_DAY)).toBe(true);

    const { rows } = await db.query<{ runs: number }>(
      "SELECT runs FROM visitor_counters WHERE visitor_hash = $1 ORDER BY window_start",
      [alice],
    );
    expect(rows.map((row) => row.runs)).toEqual([5, 1]);
  });

  it("counts an IPv4 address and its mapped IPv6 form as one visitor", async () => {
    for (let i = 0; i < 5; i += 1) expect(await countVisitorRun(db, hashOf("203.0.113.9"), 5, DAY)).toBe(true);
    expect(await countVisitorRun(db, hashOf("::ffff:203.0.113.9"), 5, DAY)).toBe(false);
  });

  it("gives exactly 5 of 20 simultaneous attempts against a cap of 5", async () => {
    // PGlite has one connection, so this proves the single-statement cap, not
    // the race between connections. That race is proven later on hosted
    // Postgres.
    const alice = hashOf("203.0.113.9");

    const results = await Promise.all(Array.from({ length: 20 }, () => countVisitorRun(db, alice, 5, DAY)));

    expect(results.filter((counted) => counted)).toHaveLength(5);
  });

  it("refuses a raw address, a bad cap or a bad date, and stores nothing", async () => {
    const alice = hashOf("203.0.113.9");
    for (const hash of ["203.0.113.9", "", alice.toUpperCase(), `${alice}0`, alice.slice(1)]) {
      expect(await codeOf(countVisitorRun(db, hash, 5, DAY))).toBe("SRV_BAD_INPUT");
    }
    for (const cap of [0, -1, 1.5, 101, Number.NaN]) {
      expect(await codeOf(countVisitorRun(db, alice, cap, DAY))).toBe("SRV_BAD_INPUT");
    }
    expect(await codeOf(countVisitorRun(db, alice, 5, new Date(Number.NaN)))).toBe("SRV_BAD_INPUT");

    const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM visitor_counters");
    expect(rows[0]!.n).toBe(0);
  });

  it("reports a database failure as SRV_UNAVAILABLE", async () => {
    await db.close();
    expect(await codeOf(countVisitorRun(db, hashOf("203.0.113.9"), 5, DAY))).toBe("SRV_UNAVAILABLE");
    db = await migratedPglite();
  });
});

describe("visitorRunsAtCap (C5.8)", () => {
  async function counters(): Promise<unknown[]> {
    return (await db.query("SELECT visitor_hash, window_start, runs FROM visitor_counters ORDER BY visitor_hash, window_start")).rows;
  }

  it("says yes only once the visitor's count for this UTC day has reached the cap, and changes nothing", async () => {
    const alice = hashOf("203.0.113.9");
    const bob = hashOf("2001:db8:1:2::1");
    expect(await visitorRunsAtCap(db, alice, 2, DAY)).toBe(false);

    expect(await countVisitorRun(db, alice, 2, DAY)).toBe(true);
    expect(await visitorRunsAtCap(db, alice, 2, DAY)).toBe(false);
    expect(await countVisitorRun(db, alice, 2, DAY)).toBe(true);
    const stored = await counters();

    expect(await visitorRunsAtCap(db, alice, 2, LATE_SAME_DAY)).toBe(true);
    expect(await visitorRunsAtCap(db, alice, 3, DAY)).toBe(false);
    expect(await visitorRunsAtCap(db, alice, 2, NEXT_DAY)).toBe(false);
    expect(await visitorRunsAtCap(db, bob, 2, DAY)).toBe(false);
    expect(await counters()).toEqual(stored);
  });

  it("refuses what countVisitorRun refuses, and fails closed on a database failure", async () => {
    const alice = hashOf("203.0.113.9");
    for (const hash of ["203.0.113.9", "", alice.toUpperCase(), `${alice}0`]) {
      expect(await codeOf(visitorRunsAtCap(db, hash, 5, DAY))).toBe("SRV_BAD_INPUT");
    }
    for (const cap of [0, -1, 1.5, 101, Number.NaN]) {
      expect(await codeOf(visitorRunsAtCap(db, alice, cap, DAY))).toBe("SRV_BAD_INPUT");
    }
    expect(await codeOf(visitorRunsAtCap(db, alice, 5, new Date(Number.NaN)))).toBe("SRV_BAD_INPUT");

    await db.close();
    expect(await codeOf(visitorRunsAtCap(db, alice, 5, DAY))).toBe("SRV_UNAVAILABLE");
    db = await migratedPglite();
  });
});

describe("in-progress slots (C5.8)", () => {
  it("gives exactly 3 of 10 simultaneous attempts against a max of 3", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => acquireInflightSlot(db, 3)));

    expect(results.filter((acquired) => acquired)).toHaveLength(3);
    expect(await inflight()).toBe(3);
  });

  it("frees a slot on release and never goes below 0", async () => {
    expect(await acquireInflightSlot(db, 1)).toBe(true);
    expect(await acquireInflightSlot(db, 1)).toBe(false);

    await releaseInflightSlot(db);
    expect(await inflight()).toBe(0);
    await releaseInflightSlot(db);
    await releaseInflightSlot(db);
    expect(await inflight()).toBe(0);

    expect(await acquireInflightSlot(db, 1)).toBe(true);
    expect(await acquireInflightSlot(db, 1)).toBe(false);
  });

  it("resets the count at startup", async () => {
    for (let i = 0; i < 3; i += 1) await acquireInflightSlot(db, 3);

    await resetInflight(db, 0);

    expect(await inflight()).toBe(0);
    expect(await acquireInflightSlot(db, 3)).toBe(true);
  });

  it("refuses bad limits and fails closed when the counter row is missing", async () => {
    for (const max of [0, 21, 1.5, Number.NaN]) {
      expect(await codeOf(acquireInflightSlot(db, max))).toBe("SRV_BAD_INPUT");
    }
    for (const running of [-1, 21, 0.5]) {
      expect(await codeOf(resetInflight(db, running))).toBe("SRV_BAD_INPUT");
    }

    await db.query("DELETE FROM inflight");
    expect(await acquireInflightSlot(db, 3)).toBe(false);
    expect(await codeOf(resetInflight(db, 0))).toBe("SRV_UNAVAILABLE");
  });
});

describe("MCP's share of the in-progress slots (D3.3)", () => {
  it("fails for MCP while its slot is held, and a website start still gets a place", async () => {
    expect(await acquireMcpRunSlots(db, 1, 3)).toBe(true);

    expect(await acquireMcpRunSlots(db, 1, 3)).toBe(false);
    expect(await acquireInflightSlot(db, 3)).toBe(true);
    expect(await acquireInflightSlot(db, 3)).toBe(true);

    expect(await inflight("mcp")).toBe(1);
    expect(await inflight()).toBe(3);
  });

  it("takes both places or neither when the site is full", async () => {
    for (let i = 0; i < 3; i += 1) expect(await acquireInflightSlot(db, 3)).toBe(true);

    expect(await acquireMcpRunSlots(db, 1, 3)).toBe(false);

    expect(await inflight("mcp")).toBe(0);
    expect(await inflight()).toBe(3);
  });

  it("gives exactly 1 of 10 simultaneous MCP starts against a share of 1, and the release frees both places", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => acquireMcpRunSlots(db, 1, 3)));

    expect(results.filter((acquired) => acquired)).toHaveLength(1);
    expect([await inflight("mcp"), await inflight()]).toEqual([1, 1]);

    await releaseMcpRunSlots(db);
    expect([await inflight("mcp"), await inflight()]).toEqual([0, 0]);
    await releaseMcpRunSlots(db);
    expect([await inflight("mcp"), await inflight()]).toEqual([0, 0]);
    expect(await acquireMcpRunSlots(db, undefined, 3)).toBe(true);
  });

  it("refuses an MCP share that is not below the site's, a bad slot name, and fails closed with the MCP row missing", async () => {
    for (const [mcpMax, siteMax] of [
      [3, 3],
      [4, 3],
      [0, 3],
      [1, 0],
      [1, 21],
      [1.5, 3],
    ] as const) {
      expect(await codeOf(acquireMcpRunSlots(db, mcpMax, siteMax)), `${mcpMax} of ${siteMax}`).toBe("SRV_BAD_INPUT");
    }
    for (const slot of ["Runs", "", "mcp ", "showcase"]) {
      expect(await codeOf(acquireInflightSlot(db, 3, slot as "runs"))).toBe("SRV_BAD_INPUT");
      expect(await codeOf(releaseInflightSlot(db, slot as "runs"))).toBe("SRV_BAD_INPUT");
      expect(await codeOf(resetInflight(db, 0, slot as "runs"))).toBe("SRV_BAD_INPUT");
    }

    await db.query("DELETE FROM inflight WHERE slot = 'mcp'");
    expect(await acquireMcpRunSlots(db, 1, 3)).toBe(false);
    expect(await inflight()).toBe(0);
    expect(await codeOf(resetInflight(db, 0, "mcp"))).toBe("SRV_UNAVAILABLE");
  });

  it("resets the MCP slot at startup on its own", async () => {
    expect(await acquireMcpRunSlots(db, 1, 3)).toBe(true);

    await resetInflight(db, 0, "mcp");

    expect([await inflight("mcp"), await inflight()]).toEqual([0, 1]);
  });
});

describe("release retries", () => {
  // Fails the first `failures` statements or transactions, then passes them to the real database.
  function flaky(failures: number): { flakyDb: Db; tries: () => number } {
    let tries = 0;
    const blip = () => {
      tries += 1;
      return tries <= failures;
    };
    const flakyDb: Db = {
      query: (text, params) => (blip() ? Promise.reject(new Error("blip")) : db.query(text, params)),
      transaction: (fn) => (blip() ? Promise.reject(new Error("blip")) : db.transaction(fn)),
      close: async () => {},
    };
    return { flakyDb, tries: () => tries };
  }

  it("gives the place back on the third try after two failed decrements, and rethrows after a third", async () => {
    for (let i = 0; i < 2; i += 1) expect(await acquireInflightSlot(db, 3)).toBe(true);
    const twice = flaky(2);
    const started = Date.now();

    await releaseInflightSlot(twice.flakyDb);

    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    expect([twice.tries(), await inflight()]).toEqual([3, 1]);
    const always = flaky(3);
    expect(await codeOf(releaseInflightSlot(always.flakyDb))).toBe("SRV_UNAVAILABLE");
    expect([always.tries(), await inflight()]).toEqual([3, 1]);
  });

  it("retries the MCP pair's release the same way", async () => {
    expect(await acquireMcpRunSlots(db, 1, 3)).toBe(true);
    const twice = flaky(2);

    await releaseMcpRunSlots(twice.flakyDb);

    expect([twice.tries(), await inflight("mcp"), await inflight()]).toEqual([3, 0, 0]);
    expect(await acquireMcpRunSlots(db, 1, 3)).toBe(true);
    expect(await codeOf(releaseMcpRunSlots(flaky(3).flakyDb))).toBe("SRV_UNAVAILABLE");
    expect([await inflight("mcp"), await inflight()]).toEqual([1, 1]);
  });
});

describe("reconcileInflight (G23)", () => {
  async function runIn(status: RunStatus, surface: "web" | "mcp" = "web"): Promise<void> {
    const origin = surface === "mcp" ? { surface, tokenId: (await issueToken(db)).id } : undefined;
    const runId = await createRun(db, { show: "Synthetic Show", exclude: [] }, DAY, origin);
    if (status !== "queued") await setRunStatus(db, runId, status, undefined, DAY);
  }

  it("lowers a leaked place with no run behind it to 0, for the site and for MCP", async () => {
    await db.query("UPDATE inflight SET n = CASE slot WHEN 'runs' THEN 2 ELSE 1 END");
    await runIn("awaiting_confirm");
    await runIn("done", "mcp");

    expect(await reconcileInflight(db)).toEqual({ runs: { before: 2, after: 0 }, mcp: { before: 1, after: 0 } });
    expect([await inflight(), await inflight("mcp")]).toEqual([0, 0]);
  });

  it("keeps every place a queued or running run holds", async () => {
    await runIn("running");
    await runIn("queued", "mcp");
    await runIn("failed");
    await db.query("UPDATE inflight SET n = CASE slot WHEN 'runs' THEN 3 ELSE 1 END");

    expect(await reconcileInflight(db)).toEqual({ runs: { before: 3, after: 2 }, mcp: { before: 1, after: 1 } });
  });

  it("never raises a counter, even with more runs going than it counts", async () => {
    await runIn("running");
    await runIn("running", "mcp");
    await runIn("queued", "mcp");

    expect(await reconcileInflight(db)).toEqual({ runs: { before: 0, after: 0 }, mcp: { before: 0, after: 0 } });
    expect([await inflight(), await inflight("mcp")]).toEqual([0, 0]);
  });

  it("fails as SRV_UNAVAILABLE when a counter row is missing", async () => {
    await db.query("DELETE FROM inflight WHERE slot = 'mcp'");
    expect(await codeOf(reconcileInflight(db))).toBe("SRV_UNAVAILABLE");
  });
});
