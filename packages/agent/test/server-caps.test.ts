// Covers the per-visitor daily cap and the site-wide in-progress slots on
// PGlite. It does not cover races between separate connections (PGlite has
// one connection, so simultaneous calls are serialised; the cross-connection
// race is proven later on hosted Postgres), the vasal_app grants, or pruning
// old counter rows, which is an operator job.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireInflightSlot, countVisitorRun, releaseInflightSlot, resetInflight } from "../src/server/caps.js";
import { ServerError } from "../src/server/errors.js";
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

async function inflight(): Promise<number> {
  const { rows } = await db.query<{ n: number }>("SELECT n FROM inflight WHERE slot = 'runs'");
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
