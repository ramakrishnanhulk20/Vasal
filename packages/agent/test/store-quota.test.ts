// Covers the one-row store of Qloo's monthly count on PGlite: a reading
// stored and read back with the database's own time, an older stamp never
// replacing a newer one, a damaged row read as no reading, bad inputs
// refused before any query, the floor rule quotaAllows gives the meter and
// the probe, and the app role's grants on the table under roles.sql. It does
// not cover hosted Postgres, two connections writing at once (PGlite has
// one, so a newer stamp is placed by hand), the meter's use of the rule
// (qloo-metered.test.ts), or the probe script, which has no test and is
// never run here.
import { readFile } from "node:fs/promises";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/store/db.js";
import { StoreError } from "../src/store/errors.js";
import { migrate } from "../src/store/migrate.js";
import { QLOO_QUOTA_FLOOR, quotaAllows, readQuota, recordQuota } from "../src/store/quota.js";
import { migratedPglite } from "./helpers/pglite.js";

const T1 = new Date("2026-10-25T10:00:00.000Z");
// A caller whose clock runs decades ahead. Under the old rule its reading
// could never be replaced.
const FAST_CLOCK = new Date("2099-01-01T00:00:00.000Z");
// PGlite reads the same machine clock as Date.now(); this only absorbs rounding.
const CLOCK_SLACK_MS = 1_000;
const ROLES_FILE = new URL("../src/store/roles.sql", import.meta.url);

describe("recordQuota and readQuota", () => {
  let db: Db;

  beforeEach(async () => {
    db = await migratedPglite();
  });

  afterEach(async () => {
    await db.close();
  });

  it("reads null on a fresh database, then reads back what was recorded, stamped by the database clock", async () => {
    expect(await readQuota(db)).toBeNull();

    const before = Date.now();
    await recordQuota(db, { remaining: 48_210, limit: 50_000, seenAt: T1 });
    const after = Date.now();

    const stored = await readQuota(db);
    expect(stored).toEqual({ remaining: 48_210, limit: 50_000, seenAt: expect.any(Date) });
    expect(stored!.seenAt.getTime()).toBeGreaterThanOrEqual(before - CLOCK_SLACK_MS);
    expect(stored!.seenAt.getTime()).toBeLessThanOrEqual(after + CLOCK_SLACK_MS);
  });

  it("lets the database clock win over a caller's fast clock, so a later reply still replaces the count", async () => {
    await recordQuota(db, { remaining: 1_499, limit: 50_000, seenAt: FAST_CLOCK });
    const first = await readQuota(db);
    expect(first!.seenAt.getTime()).toBeLessThan(Date.now() + CLOCK_SLACK_MS);

    await recordQuota(db, { remaining: 48_000, limit: 50_000, seenAt: T1 });

    const second = await readQuota(db);
    expect(second).toEqual({ remaining: 48_000, limit: 50_000, seenAt: expect.any(Date) });
    expect(second!.seenAt.getTime()).toBeGreaterThan(first!.seenAt.getTime());
    const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM qloo_quota");
    expect(rows[0]?.n).toBe(1);
  });

  it("keeps a reading the database stamped later than this write, as when a newer reply committed first", async () => {
    await recordQuota(db, { remaining: 1_499, limit: 50_000, seenAt: T1 });
    await db.query("UPDATE qloo_quota SET seen_at = now() + interval '1 hour'");
    const newer = await readQuota(db);

    await recordQuota(db, { remaining: 9_000, limit: 50_000, seenAt: FAST_CLOCK });

    expect(await readQuota(db)).toEqual(newer);
    expect(newer?.remaining).toBe(1_499);
  });

  it("reads a row that fails its schema as null", async () => {
    await db.query("INSERT INTO qloo_quota (id, remaining, quota_limit, seen_at) VALUES (1, -5, 50000, $1::timestamptz)", [T1.toISOString()]);
    expect(await readQuota(db)).toBeNull();

    await db.query("UPDATE qloo_quota SET remaining = 1499, quota_limit = -1");
    expect(await readQuota(db)).toBeNull();

    await db.query("UPDATE qloo_quota SET quota_limit = 50000, seen_at = 'infinity'");
    expect(await readQuota(db)).toBeNull();
  });

  it("refuses a count that is not a whole number from 0 to 2,147,483,647, or a bad date, before any query", async () => {
    const refused: unknown[] = [
      { remaining: -1, limit: 50_000, seenAt: T1 },
      { remaining: 1.5, limit: 50_000, seenAt: T1 },
      { remaining: 1_499, limit: 2_147_483_648, seenAt: T1 },
      { remaining: Number.NaN, limit: 50_000, seenAt: T1 },
      { remaining: "1499", limit: 50_000, seenAt: T1 },
      { remaining: 1_499, limit: 50_000, seenAt: new Date("not a date") },
      { remaining: 1_499, limit: 50_000, seenAt: T1.toISOString() },
      null,
    ];
    const queries: string[] = [];
    const watched: Db = {
      ...db,
      query: async (text, params) => {
        queries.push(text);
        return db.query(text, params);
      },
    };
    for (const quota of refused) {
      await expect(recordQuota(watched, quota as never)).rejects.toThrow(expect.objectContaining({ code: "STORE_BAD_INPUT" }));
    }
    expect(queries).toEqual([]);
    expect(await readQuota(db)).toBeNull();
  });

  it("throws STORE_UNAVAILABLE when the database fails, never reading an outage as no reading", async () => {
    const gone = await migratedPglite();
    await gone.close();

    await expect(readQuota(gone)).rejects.toThrow(StoreError);
    await expect(readQuota(gone)).rejects.toThrow(expect.objectContaining({ code: "STORE_UNAVAILABLE" }));
    await expect(recordQuota(gone, { remaining: 1, limit: 2, seenAt: T1 })).rejects.toThrow(expect.objectContaining({ code: "STORE_UNAVAILABLE" }));
  });
});

describe("quotaAllows", () => {
  const DAY_MS = 24 * 60 * 60 * 1_000;
  const NOW = T1;
  let db: Db;

  beforeEach(async () => {
    db = await migratedPglite();
  });

  afterEach(async () => {
    await db.close();
  });

  it("refuses a fresh reading under the floor and allows one at the floor", async () => {
    expect(QLOO_QUOTA_FLOOR).toBe(1_500);
    expect(await quotaAllows(db, QLOO_QUOTA_FLOOR, new Date())).toBe(true);

    await recordQuota(db, { remaining: 1_499, limit: 50_000, seenAt: T1 });
    expect(await quotaAllows(db, QLOO_QUOTA_FLOOR, new Date())).toBe(false);
    expect(await quotaAllows(db, 1_499, new Date())).toBe(true);
    expect(await quotaAllows(db, 0, new Date())).toBe(true);

    await recordQuota(db, { remaining: 1_500, limit: 50_000, seenAt: T1 });
    expect(await quotaAllows(db, QLOO_QUOTA_FLOOR, new Date())).toBe(true);
  });

  it("allows a call on a 25-hour-old reading under the floor, as after Qloo's reset, and refuses again once a fresh one lands", async () => {
    await recordQuota(db, { remaining: 0, limit: 50_000, seenAt: T1 });
    await db.query("UPDATE qloo_quota SET seen_at = now() - interval '25 hours'");
    expect(await quotaAllows(db, QLOO_QUOTA_FLOOR, new Date())).toBe(true);

    await recordQuota(db, { remaining: 1_499, limit: 50_000, seenAt: T1 });
    expect(await quotaAllows(db, QLOO_QUOTA_FLOOR, new Date())).toBe(false);
  });

  it("treats a reading as no reading from exactly 24 hours after its stamp, and one stamped after now as fresh", async () => {
    await recordQuota(db, { remaining: 0, limit: 50_000, seenAt: T1 });
    const seenAt = (await readQuota(db))!.seenAt.getTime();

    expect(await quotaAllows(db, QLOO_QUOTA_FLOOR, new Date(seenAt + DAY_MS - 1))).toBe(false);
    expect(await quotaAllows(db, QLOO_QUOTA_FLOOR, new Date(seenAt + DAY_MS))).toBe(true);
    expect(await quotaAllows(db, QLOO_QUOTA_FLOOR, new Date(seenAt - 60_000))).toBe(false);
  });

  it("says yes for a row that fails its schema, as for no row", async () => {
    await db.query("INSERT INTO qloo_quota (id, remaining, quota_limit, seen_at) VALUES (1, -5, 50000, $1::timestamptz)", [NOW.toISOString()]);

    expect(await quotaAllows(db, QLOO_QUOTA_FLOOR, NOW)).toBe(true);
  });

  it("refuses a bad floor or date before any query, and throws when the database fails", async () => {
    const queries: string[] = [];
    const watched: Db = {
      ...db,
      query: async (text, params) => {
        queries.push(text);
        return db.query(text, params);
      },
    };
    for (const floor of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(quotaAllows(watched, floor, NOW)).rejects.toThrow(expect.objectContaining({ code: "STORE_BAD_INPUT" }));
    }
    await expect(quotaAllows(watched, QLOO_QUOTA_FLOOR, new Date("not a date"))).rejects.toThrow(expect.objectContaining({ code: "STORE_BAD_INPUT" }));
    expect(queries).toEqual([]);

    const gone = await migratedPglite();
    await gone.close();
    await expect(quotaAllows(gone, QLOO_QUOTA_FLOOR, NOW)).rejects.toThrow(expect.objectContaining({ code: "STORE_UNAVAILABLE" }));
  });
});

describe("qloo_quota under roles.sql", () => {
  let pg: PGlite;

  // The store's own PGlite Db hides SQLSTATEs, and SET ROLE needs the raw
  // connection, so the schema and grants are applied through this one.
  function rawDb(conn: PGlite | Transaction): Db {
    const self: Db = {
      query: async <R>(text: string, params?: unknown[]) => ({ rows: (await conn.query<R>(text, params)).rows }),
      transaction: <T>(fn: (tx: Db) => Promise<T>) => ("transaction" in conn ? conn.transaction((tx) => fn(rawDb(tx))) : fn(self)),
      close: () => Promise.reject(new Error("not closed here")),
    };
    return self;
  }

  beforeEach(async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    pg = await PGlite.create();
    await pg.exec("CREATE ROLE vasal_owner WITH NOLOGIN CREATEROLE; GRANT CREATE ON SCHEMA public TO vasal_owner;");
    const roles = await readFile(ROLES_FILE, "utf8");
    await pg.query("SET ROLE vasal_owner");
    await migrate(rawDb(pg));
    await pg.exec(roles);
    await pg.query("RESET ROLE");
  });

  afterEach(async () => {
    await pg.close();
  });

  it("lets vasal_app record and read the count, and gives it nothing else on the table", async () => {
    const allowed = async (privilege: string) =>
      (await pg.query<{ ok: boolean }>(`SELECT has_table_privilege('vasal_app', 'qloo_quota', '${privilege}') AS ok`)).rows[0]?.ok;
    expect(await allowed("SELECT")).toBe(true);
    expect(await allowed("INSERT")).toBe(true);
    expect(await allowed("UPDATE")).toBe(true);
    for (const privilege of ["DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) expect(await allowed(privilege), privilege).toBe(false);

    await pg.query("SET ROLE vasal_app");
    try {
      const app = rawDb(pg);
      await recordQuota(app, { remaining: 2_000, limit: 50_000, seenAt: T1 });
      await recordQuota(app, { remaining: 1_499, limit: 50_000, seenAt: T1 });
      expect(await readQuota(app)).toEqual({ remaining: 1_499, limit: 50_000, seenAt: expect.any(Date) });
      await expect(pg.query("DELETE FROM qloo_quota")).rejects.toThrow(/permission denied/);
      await expect(pg.query("INSERT INTO qloo_quota (id, remaining, quota_limit, seen_at) VALUES (2, 1, 1, now())")).rejects.toThrow(/check constraint/);
    } finally {
      await pg.query("RESET ROLE");
    }
  });
});
