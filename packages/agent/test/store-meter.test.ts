// Covers the budget meter and the store error wrapper on PGlite. It does not
// cover races between separate connections (PGlite has one), the pg adapter,
// TLS, roles.sql, or clock differences between hosts. Those need hosted
// Postgres through createPgDb and are proven against it later.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/store/db.js";
import { StoreError } from "../src/store/errors.js";
import {
  pruneSecondBuckets,
  reserve,
  reserveQlooCall,
  setBucket,
  usage,
  waitForQlooSlot,
  type Reservation,
} from "../src/store/meter.js";
import { migratedPglite } from "./helpers/pglite.js";

const NOW = new Date("2026-10-19T12:00:00.100Z");
const FAR_FUTURE = new Date("2099-01-01T00:00:00.000Z");
const MARKER = "MARKER-7f3a9c";

let db: Db;

beforeEach(async () => {
  db = await migratedPglite();
});

afterEach(async () => {
  await db.close();
});

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await errorOf(promise);
  return error instanceof StoreError ? error.code : String(error);
}

async function usedOf(key: string): Promise<number | undefined> {
  return (await usage(db, key))?.used;
}

async function openQlooBuckets(dayCap: number, monthCap: number): Promise<void> {
  await setBucket(db, { key: "qloo:day", cap: dayCap, windowEnd: FAR_FUTURE });
  await setBucket(db, { key: "qloo:month", cap: monthCap, windowEnd: FAR_FUTURE });
}

describe("reserve", () => {
  it("gives exactly 10 of 50 simultaneous reservations against a cap of 10 (C5.1)", async () => {
    // PGlite runs one connection, so this proves the all-or-nothing logic and
    // the cap, not the race between connections. That race is proven later
    // against hosted Postgres with createPgDb.
    await setBucket(db, { key: "runs:day", cap: 10, windowEnd: FAR_FUTURE });

    const results = await Promise.all(
      Array.from({ length: 50 }, () => reserve(db, [{ key: "runs:day", amount: 1 }], NOW)),
    );

    expect(results.filter((ok) => ok)).toHaveLength(10);
    expect(results.filter((ok) => !ok)).toHaveLength(40);
    expect(await usedOf("runs:day")).toBe(10);
  });

  it("adds to every bucket when all have room", async () => {
    await setBucket(db, { key: "tokens:day", cap: 1_000, windowEnd: FAR_FUTURE });
    await setBucket(db, { key: "youtube:day", cap: 100, windowEnd: FAR_FUTURE });

    const ok = await reserve(db, [
      { key: "youtube:day", amount: 100 },
      { key: "tokens:day", amount: 400 },
    ], NOW);

    expect(ok).toBe(true);
    expect(await usedOf("tokens:day")).toBe(400);
    expect(await usedOf("youtube:day")).toBe(100);
  });

  it("changes neither bucket when one of two would overflow", async () => {
    await setBucket(db, { key: "tokens:day", cap: 1_000, windowEnd: FAR_FUTURE });
    await setBucket(db, { key: "youtube:day", cap: 100, windowEnd: FAR_FUTURE });
    await reserve(db, [{ key: "youtube:day", amount: 90 }], NOW);

    const ok = await reserve(db, [
      { key: "tokens:day", amount: 400 },
      { key: "youtube:day", amount: 11 },
    ], NOW);

    expect(ok).toBe(false);
    expect(await usedOf("tokens:day")).toBe(0);
    expect(await usedOf("youtube:day")).toBe(90);
  });

  it("sums repeated keys before checking the cap", async () => {
    await setBucket(db, { key: "runs:day", cap: 10, windowEnd: FAR_FUTURE });

    expect(await reserve(db, [{ key: "runs:day", amount: 6 }, { key: "runs:day", amount: 6 }], NOW)).toBe(false);
    expect(await usedOf("runs:day")).toBe(0);
    expect(await reserve(db, [{ key: "runs:day", amount: 5 }, { key: "runs:day", amount: 5 }], NOW)).toBe(true);
    expect(await usedOf("runs:day")).toBe(10);
  });

  it("fails closed on a missing bucket, and leaves the other bucket untouched", async () => {
    await setBucket(db, { key: "runs:day", cap: 10, windowEnd: FAR_FUTURE });

    expect(await reserve(db, [{ key: "never:made", amount: 1 }], NOW)).toBe(false);
    expect(await reserve(db, [{ key: "runs:day", amount: 1 }, { key: "never:made", amount: 1 }], NOW)).toBe(false);
    expect(await usedOf("runs:day")).toBe(0);
    expect(await usage(db, "never:made")).toBeNull();
  });

  it("fails closed when the window has ended, even with room under the cap", async () => {
    await setBucket(db, { key: "runs:day", cap: 10, windowEnd: NOW });

    expect(await reserve(db, [{ key: "runs:day", amount: 1 }], NOW)).toBe(false);
    expect(await reserve(db, [{ key: "runs:day", amount: 1 }], new Date(NOW.getTime() - 1))).toBe(true);
  });

  it("throws STORE_BAD_INPUT for amount 0, -1, a non-integer, too large, 9 items or none", async () => {
    await setBucket(db, { key: "runs:day", cap: 10_000_000, windowEnd: FAR_FUTURE });
    const nine: Reservation[] = Array.from({ length: 9 }, (_, i) => ({ key: `k${i}`, amount: 1 }));

    for (const items of [
      [{ key: "runs:day", amount: 0 }],
      [{ key: "runs:day", amount: -1 }],
      [{ key: "runs:day", amount: 1.5 }],
      [{ key: "runs:day", amount: Number.NaN }],
      [{ key: "runs:day", amount: 1_000_001 }],
      nine,
      [],
    ]) {
      expect(await codeOf(reserve(db, items, NOW))).toBe("STORE_BAD_INPUT");
    }
    expect(await usedOf("runs:day")).toBe(0);
  });
});

describe("setBucket", () => {
  it("keeps used and the window inside a live window, but updates the cap", async () => {
    await setBucket(db, { key: "runs:day", cap: 10, windowEnd: FAR_FUTURE });
    await reserve(db, [{ key: "runs:day", amount: 3 }], NOW);

    await setBucket(db, { key: "runs:day", cap: 20, windowEnd: new Date("2100-01-01T00:00:00.000Z") });

    expect(await usage(db, "runs:day")).toEqual({ used: 3, cap: 20, windowEnd: FAR_FUTURE });
  });

  it("resets used and moves the window once the stored window has ended", async () => {
    const ended = new Date("2020-01-01T00:00:00.000Z");
    await setBucket(db, { key: "runs:day", cap: 10, windowEnd: ended });
    await reserve(db, [{ key: "runs:day", amount: 7 }], new Date("2019-12-31T00:00:00.000Z"));

    await setBucket(db, { key: "runs:day", cap: 12, windowEnd: FAR_FUTURE });

    expect(await usage(db, "runs:day")).toEqual({ used: 0, cap: 12, windowEnd: FAR_FUTURE });
  });

  it("refuses a negative or fractional cap", async () => {
    expect(await codeOf(setBucket(db, { key: "runs:day", cap: -1, windowEnd: FAR_FUTURE }))).toBe("STORE_BAD_INPUT");
    expect(await codeOf(setBucket(db, { key: "runs:day", cap: 2.5, windowEnd: FAR_FUTURE }))).toBe("STORE_BAD_INPUT");
    expect(await usage(db, "runs:day")).toBeNull();
  });
});

describe("reserveQlooCall", () => {
  it("allows exactly 4 calls in one second, refuses a 5th, and allows one a second later (C5.2)", async () => {
    await openQlooBuckets(100, 1_000);
    const sameSecond = [0, 200, 400, 600, 899].map((ms) => new Date(NOW.getTime() + ms));

    const results: boolean[] = [];
    for (const at of sameSecond) results.push(await reserveQlooCall(db, at));

    expect(results).toEqual([true, true, true, true, false]);
    expect(await reserveQlooCall(db, new Date(NOW.getTime() + 1_000))).toBe(true);
    expect(await usedOf("qloo:day")).toBe(5);
    expect(await usedOf("qloo:month")).toBe(5);
  });

  it("returns false in a fresh second once the day bucket is full", async () => {
    await openQlooBuckets(2, 1_000);

    expect(await reserveQlooCall(db, NOW)).toBe(true);
    expect(await reserveQlooCall(db, new Date(NOW.getTime() + 1_000))).toBe(true);
    expect(await reserveQlooCall(db, new Date(NOW.getTime() + 2_000))).toBe(false);
    expect(await usedOf("qloo:month")).toBe(2);
  });

  it("returns false when the month bucket was never set", async () => {
    await setBucket(db, { key: "qloo:day", cap: 100, windowEnd: FAR_FUTURE });

    expect(await reserveQlooCall(db, NOW)).toBe(false);
    expect(await usedOf("qloo:day")).toBe(0);
  });
});

describe("waitForQlooSlot", () => {
  function fakeTime(start: Date): { now: () => Date; sleep: (ms: number) => Promise<void>; sleeps: number[] } {
    let at = start.getTime();
    const sleeps: number[] = [];
    return {
      now: () => new Date(at),
      sleep: async (ms) => {
        sleeps.push(ms);
        at += ms;
      },
      sleeps,
    };
  }

  async function fillSecond(at: Date): Promise<void> {
    for (let i = 0; i < 4; i += 1) expect(await reserveQlooCall(db, at)).toBe(true);
  }

  it("waits into the next second when only the per-second bucket is full", async () => {
    await openQlooBuckets(100, 1_000);
    await fillSecond(NOW);
    const time = fakeTime(NOW);

    expect(await waitForQlooSlot(db, { now: time.now, sleep: time.sleep })).toBe(true);
    expect(time.sleeps).toEqual([900]);
    expect(await usedOf("qloo:day")).toBe(5);
  });

  it("returns false at once when the day bucket is full", async () => {
    await openQlooBuckets(1, 1_000);
    expect(await reserveQlooCall(db, new Date(NOW.getTime() - 5_000))).toBe(true);
    const time = fakeTime(NOW);

    expect(await waitForQlooSlot(db, { now: time.now, sleep: time.sleep })).toBe(false);
    expect(time.sleeps).toEqual([]);
  });

  it("gives up once maxWaitMs would pass, even with a clock that never moves", async () => {
    await openQlooBuckets(100, 1_000);
    await fillSecond(NOW);
    const sleeps: number[] = [];

    const ok = await waitForQlooSlot(db, {
      now: () => NOW,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(ok).toBe(false);
    expect(sleeps).toEqual([900, 900, 900]);
    expect(await usedOf("qloo:day")).toBe(4);
  });
});

describe("offline Qloo share (dayKey)", () => {
  const OFFLINE = { dayKey: "qloo:day:offline" };

  async function openOfflineShare(cap: number): Promise<void> {
    await setBucket(db, { key: "qloo:day:offline", cap, windowEnd: FAR_FUTURE });
  }

  it("reserves from qloo:day:offline and the shared month, and leaves qloo:day alone (C5.1)", async () => {
    await openQlooBuckets(100, 1_000);
    await openOfflineShare(50);

    expect(await reserveQlooCall(db, NOW, OFFLINE)).toBe(true);
    expect(await reserveQlooCall(db, NOW)).toBe(true);

    expect(await usedOf("qloo:day:offline")).toBe(1);
    expect(await usedOf("qloo:day")).toBe(1);
    expect(await usedOf("qloo:month")).toBe(2);
  });

  it("is not blocked by a full qloo:day, but a full month blocks both shares", async () => {
    await openQlooBuckets(1, 3);
    await openOfflineShare(50);
    expect(await reserveQlooCall(db, NOW)).toBe(true);

    expect(await reserveQlooCall(db, new Date(NOW.getTime() + 1_000))).toBe(false);
    expect(await reserveQlooCall(db, new Date(NOW.getTime() + 1_000), OFFLINE)).toBe(true);
    expect(await reserveQlooCall(db, new Date(NOW.getTime() + 2_000), OFFLINE)).toBe(true);

    expect(await usedOf("qloo:month")).toBe(3);
    expect(await reserveQlooCall(db, new Date(NOW.getTime() + 3_000), OFFLINE)).toBe(false);
    expect(await reserveQlooCall(db, new Date(NOW.getTime() + 3_000))).toBe(false);
    expect(await usedOf("qloo:day:offline")).toBe(2);
    expect(await usedOf("qloo:day")).toBe(1);
  });

  it("refuses when the offline share was never set, even with qloo:day open", async () => {
    await openQlooBuckets(100, 1_000);

    expect(await reserveQlooCall(db, NOW, OFFLINE)).toBe(false);
    expect(await usedOf("qloo:month")).toBe(0);
  });

  it("shares one per-second limit with the online share (C5.2)", async () => {
    await openQlooBuckets(100, 1_000);
    await openOfflineShare(50);

    const results = [
      await reserveQlooCall(db, NOW),
      await reserveQlooCall(db, NOW, OFFLINE),
      await reserveQlooCall(db, NOW),
      await reserveQlooCall(db, NOW, OFFLINE),
      await reserveQlooCall(db, NOW, OFFLINE),
      await reserveQlooCall(db, NOW),
    ];

    expect(results).toEqual([true, true, true, true, false, false]);
    expect(await usedOf("qloo:month")).toBe(4);
  });

  it("waitForQlooSlot draws on the share it is given and gives up at once when that share is full", async () => {
    await openQlooBuckets(100, 1_000);
    await openOfflineShare(1);
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };

    expect(await waitForQlooSlot(db, { ...OFFLINE, now: () => NOW, sleep })).toBe(true);
    expect(await waitForQlooSlot(db, { ...OFFLINE, now: () => new Date(NOW.getTime() + 1_000), sleep })).toBe(false);
    expect(sleeps).toEqual([]);
    expect(await usedOf("qloo:day:offline")).toBe(1);
    expect(await usedOf("qloo:day")).toBe(0);
  });

  it("refuses a dayKey outside the qloo:day family before touching any bucket", async () => {
    await openQlooBuckets(100, 1_000);

    for (const dayKey of ["qloo:month", "qloo:second:1", "qloo:dayoffline", "", "qloo:day:".padEnd(201, "x")]) {
      expect(await codeOf(reserveQlooCall(db, NOW, { dayKey }))).toBe("STORE_BAD_INPUT");
      expect(await codeOf(waitForQlooSlot(db, { dayKey }))).toBe("STORE_BAD_INPUT");
    }
    expect(await usedOf("qloo:month")).toBe(0);
  });
});

describe("pruneSecondBuckets", () => {
  it("deletes only per-second buckets whose window has ended", async () => {
    await openQlooBuckets(100, 1_000);
    await reserveQlooCall(db, NOW);
    await reserveQlooCall(db, new Date(NOW.getTime() + 5_000));
    const firstSecond = `qloo:second:${Math.floor(NOW.getTime() / 1_000)}`;

    expect(await pruneSecondBuckets(db, new Date(NOW.getTime() + 3_000))).toBe(1);
    expect(await usage(db, firstSecond)).toBeNull();
    expect(await usedOf("qloo:day")).toBe(2);
    expect(await usedOf("qloo:month")).toBe(2);
    expect(await pruneSecondBuckets(db, new Date(NOW.getTime() + 3_000))).toBe(0);
  });
});

describe("StoreError", () => {
  it("never repeats a value passed to the failing call", async () => {
    const refusals = [
      reserve(db, [{ key: MARKER, amount: 0 }], NOW),
      reserve(db, [{ key: MARKER.repeat(40), amount: 1 }], NOW),
      setBucket(db, { key: MARKER, cap: -1, windowEnd: FAR_FUTURE }),
      usage(db, MARKER.repeat(40)),
    ];
    for (const refusal of refusals) {
      const error = await errorOf(refusal);
      expect(error).toBeInstanceOf(StoreError);
      expect(String(error)).not.toContain("MARKER");
      expect(JSON.stringify(error)).not.toContain("MARKER");
    }
  });

  it("hides the driver error, which does carry the value, behind STORE_UNAVAILABLE", async () => {
    const error = await errorOf(db.query("SELECT $1::int AS n", [MARKER]));

    expect(error).toBeInstanceOf(StoreError);
    expect((error as StoreError).code).toBe("STORE_UNAVAILABLE");
    expect((error as StoreError).cause).toBeUndefined();
    expect(String(error)).not.toContain("MARKER");
    expect(JSON.stringify(error)).not.toContain("MARKER");
    expect((error as StoreError).stack ?? "").not.toContain("MARKER");
  });
});
