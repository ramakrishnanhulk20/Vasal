// Covers the kill switch read and the operator write on PGlite and on stub
// databases. It does not cover the vasal_app grants that stop the app from
// writing app_flags (roles.sql runs only on Neon), or what the site shows
// when live runs are off.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/store/db.js";
import { StoreError } from "../src/store/errors.js";
import { liveRunsEnabled, setFlag } from "../src/store/flags.js";
import { migratedPglite } from "./helpers/pglite.js";

const MARKER = "MARKER-0b5d22";

function stubDb(query: Db["query"]): Db {
  const self: Db = {
    query,
    transaction: (fn) => fn(self),
    close: async () => {},
  };
  return self;
}

function returning(rows: Record<string, unknown>[]): Db {
  return stubDb(async <R>() => ({ rows: rows as R[] }));
}

describe("liveRunsEnabled on a real schema", () => {
  let db: Db;

  beforeEach(async () => {
    db = await migratedPglite();
  });

  afterEach(async () => {
    await db.close();
  });

  it("is false with no row, follows setFlag, and ignores other flags", async () => {
    expect(await liveRunsEnabled(db)).toBe(false);

    await setFlag(db, "something_else", true);
    expect(await liveRunsEnabled(db)).toBe(false);

    await setFlag(db, "live_runs", false);
    expect(await liveRunsEnabled(db)).toBe(false);

    await setFlag(db, "live_runs", true);
    expect(await liveRunsEnabled(db)).toBe(true);

    await setFlag(db, "live_runs", false);
    expect(await liveRunsEnabled(db)).toBe(false);
  });

  it("turns false when the database it read true from goes away", async () => {
    const other = await migratedPglite();
    await setFlag(other, "live_runs", true);
    expect(await liveRunsEnabled(other)).toBe(true);

    await other.close();

    expect(await liveRunsEnabled(other)).toBe(false);
  });

  it("refuses a bad flag name or a non-boolean value without echoing it", async () => {
    for (const [name, value] of [
      ["", true],
      ["Live_Runs", true],
      ["live runs", true],
      [`${MARKER}'; DROP TABLE app_flags; --`, true],
      ["x".repeat(64), true],
      ["live_runs", "true"],
      ["live_runs", 1],
    ] as Array<[string, unknown]>) {
      let caught: unknown;
      try {
        await setFlag(db, name, value as boolean);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(StoreError);
      expect((caught as StoreError).code).toBe("STORE_BAD_INPUT");
      expect(String(caught)).not.toContain("MARKER");
    }
    expect(await liveRunsEnabled(db)).toBe(false);
  });
});

describe("liveRunsEnabled on a failing or odd database (C5.7)", () => {
  it("is false when query rejects", async () => {
    expect(await liveRunsEnabled(stubDb(() => Promise.reject(new Error("connection refused"))))).toBe(false);
  });

  it("is false when query throws before returning a promise", async () => {
    expect(
      await liveRunsEnabled(
        stubDb(() => {
          throw new Error("pool destroyed");
        }),
      ),
    ).toBe(false);
  });

  it("is false for a value that is not the boolean true", async () => {
    for (const value of ["true", 1, "t", null, {}]) {
      expect(await liveRunsEnabled(returning([{ value }]))).toBe(false);
    }
    expect(await liveRunsEnabled(returning([]))).toBe(false);
    expect(await liveRunsEnabled(returning([{ value: true }, { value: true }]))).toBe(false);
    expect(await liveRunsEnabled(returning([{ value: true }]))).toBe(true);
  });
});
