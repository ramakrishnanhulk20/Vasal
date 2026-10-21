// Covers rollBuckets and windowEndFor on PGlite, with the shipped policy and
// small synthetic ones. setBucket decides whether a stored window has ended by
// the machine clock, so each roll pins that clock to the roll's `now` (only
// Date is faked; timers stay real). It does not cover the owner role
// grants (roles.sql needs hosted Postgres) or two operators rolling at once.
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPolicy, parsePolicy, type BudgetPolicy } from "../src/ops/policy.js";
import { rollBuckets, windowEndFor, type RollOutcome } from "../src/ops/roll.js";
import type { Db } from "../src/store/db.js";
import { reserve, setBucket, usage } from "../src/store/meter.js";
import { migratedPglite } from "./helpers/pglite.js";

const SHIPPED = fileURLToPath(new URL("../scripts/budget-policy.json", import.meta.url));
const at = (iso: string) => new Date(iso);

let db: Db;
let policy: BudgetPolicy;

beforeEach(async () => {
  db = await migratedPglite();
  policy = await loadPolicy(SHIPPED);
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(async () => {
  vi.useRealTimers();
  await db.close();
});

async function rollAt(iso: string, using: BudgetPolicy = policy): Promise<RollOutcome> {
  vi.setSystemTime(at(iso));
  return rollBuckets(db, using, at(iso));
}

function rolled(outcome: RollOutcome) {
  if (!outcome.covered) throw new Error("expected a covering profile");
  return Object.fromEntries(outcome.buckets.map((bucket) => [bucket.key, bucket]));
}

async function bucketCount(): Promise<number> {
  const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM usage_buckets");
  return rows[0]?.n ?? -1;
}

describe("windowEndFor", () => {
  it("ends a day at the next 00:00 UTC and a month at the first of the next month", () => {
    expect(windowEndFor("day", at("2026-10-19T15:30:00.000Z"))).toEqual(at("2026-10-20T00:00:00.000Z"));
    expect(windowEndFor("day", at("2026-10-20T00:00:00.000Z"))).toEqual(at("2026-10-21T00:00:00.000Z"));
    expect(windowEndFor("day", at("2026-10-31T23:59:59.999Z"))).toEqual(at("2026-11-01T00:00:00.000Z"));
    expect(windowEndFor("day", at("2028-02-28T12:00:00.000Z"))).toEqual(at("2028-02-29T00:00:00.000Z"));
    expect(windowEndFor("month", at("2026-10-19T15:30:00.000Z"))).toEqual(at("2026-11-01T00:00:00.000Z"));
    expect(windowEndFor("month", at("2026-11-01T00:00:00.000Z"))).toEqual(at("2026-12-01T00:00:00.000Z"));
    expect(windowEndFor("month", at("2026-12-15T08:00:00.000Z"))).toEqual(at("2027-01-01T00:00:00.000Z"));
  });

  it("throws RangeError for an invalid date", () => {
    expect(() => windowEndFor("day", new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe("rollBuckets", () => {
  it("sets every bucket of the covering profile with its cap and window end", async () => {
    const outcome = await rollAt("2026-10-19T15:30:00.000Z");

    expect(outcome.covered && outcome.profile).toEqual({ from: "2026-10-01", to: "2026-11-01" });
    const byKey = rolled(outcome);
    expect(Object.keys(byKey).sort()).toEqual([
      "anthropic:day",
      "anthropic:day:mcp",
      "anthropic:day:offline",
      "mcp:keys:day",
      "qloo:day",
      "qloo:day:mcp",
      "qloo:day:offline",
      "qloo:month",
      "qloo:month:mcp",
      "youtube:day",
    ]);
    for (const bucket of Object.values(byKey)) expect(bucket.changed).toEqual(["created"]);

    const day = at("2026-10-20T00:00:00.000Z");
    const month = at("2026-11-01T00:00:00.000Z");
    expect(await usage(db, "qloo:month")).toEqual({ cap: 12_000, used: 0, windowEnd: month });
    expect(await usage(db, "qloo:day")).toEqual({ cap: 1_000, used: 0, windowEnd: day });
    expect(await usage(db, "qloo:day:offline")).toEqual({ cap: 6_000, used: 0, windowEnd: day });
    expect(await usage(db, "anthropic:day")).toEqual({ cap: 2_000_000, used: 0, windowEnd: day });
    expect(await usage(db, "youtube:day")).toEqual({ cap: 9_000, used: 0, windowEnd: day });
    expect(await usage(db, "qloo:day:mcp")).toEqual({ cap: 300, used: 0, windowEnd: day });
    expect(await usage(db, "qloo:month:mcp")).toEqual({ cap: 2_000, used: 0, windowEnd: month });
    expect(await usage(db, "anthropic:day:mcp")).toEqual({ cap: 500_000, used: 0, windowEnd: day });
    expect(await usage(db, "mcp:keys:day")).toEqual({ cap: 50, used: 0, windowEnd: day });
  });

  it("changes nothing the second time in one window and keeps what was used", async () => {
    await rollAt("2026-10-19T15:30:00.000Z");
    expect(await reserve(db, [{ key: "qloo:day", amount: 7 }, { key: "qloo:month", amount: 7 }], at("2026-10-19T16:00:00.000Z"))).toBe(true);
    const before = await usage(db, "qloo:day");

    for (const later of ["2026-10-19T15:30:00.000Z", "2026-10-19T23:59:59.999Z"]) {
      const again = rolled(await rollAt(later));
      for (const bucket of Object.values(again)) {
        expect(bucket.changed).toEqual([]);
        expect(bucket.after).toEqual(bucket.before);
      }
    }
    expect(await usage(db, "qloo:day")).toEqual(before);
    expect((await usage(db, "qloo:day"))?.used).toBe(7);
    expect((await usage(db, "qloo:month"))?.used).toBe(7);
  });

  it("resets a day bucket at midnight while the month bucket keeps counting", async () => {
    await rollAt("2026-10-19T15:30:00.000Z");
    await reserve(db, [{ key: "qloo:day", amount: 7 }, { key: "qloo:month", amount: 7 }], at("2026-10-19T16:00:00.000Z"));

    const next = rolled(await rollAt("2026-10-20T00:00:00.000Z"));

    expect(next["qloo:day"]?.changed).toEqual(["window"]);
    expect(await usage(db, "qloo:day")).toEqual({ cap: 1_000, used: 0, windowEnd: at("2026-10-21T00:00:00.000Z") });
    expect(next["qloo:month"]?.changed).toEqual([]);
    expect(await usage(db, "qloo:month")).toEqual({ cap: 12_000, used: 7, windowEnd: at("2026-11-01T00:00:00.000Z") });
  });

  it("moves to the next profile's caps and a fresh month on the first of the month", async () => {
    await rollAt("2026-10-31T23:00:00.000Z");
    await reserve(db, [{ key: "qloo:month", amount: 100 }, { key: "qloo:day", amount: 5 }], at("2026-10-31T23:30:00.000Z"));

    const outcome = await rollAt("2026-11-01T00:00:00.000Z");
    const next = rolled(outcome);

    expect(outcome.covered && outcome.profile).toEqual({ from: "2026-11-01", to: "2026-12-01" });
    expect(next["qloo:month"]?.changed).toEqual(["cap", "window"]);
    expect(await usage(db, "qloo:month")).toEqual({ cap: 32_000, used: 0, windowEnd: at("2026-12-01T00:00:00.000Z") });
    expect(await usage(db, "qloo:day")).toEqual({ cap: 1_400, used: 0, windowEnd: at("2026-11-02T00:00:00.000Z") });
    expect(await usage(db, "qloo:day:offline")).toEqual({ cap: 300, used: 0, windowEnd: at("2026-11-02T00:00:00.000Z") });
  });

  it("applies a retuned cap at once inside a live window without touching used", async () => {
    await rollAt("2026-10-19T10:00:00.000Z");
    await reserve(db, [{ key: "qloo:day", amount: 40 }], at("2026-10-19T11:00:00.000Z"));
    const retuned = parsePolicy({
      profiles: [{ from: "2026-10-01", to: "2026-11-01", buckets: [{ key: "qloo:day", window: "day", cap: 50 }] }],
    });

    const next = rolled(await rollAt("2026-10-19T12:00:00.000Z", retuned));

    expect(next["qloo:day"]?.changed).toEqual(["cap"]);
    expect(await usage(db, "qloo:day")).toEqual({ cap: 50, used: 40, windowEnd: at("2026-10-20T00:00:00.000Z") });
  });

  it("reports a live window set some other way, and leaves it until it ends", async () => {
    const devWindow = at("2026-11-18T00:00:00.000Z");
    vi.setSystemTime(at("2026-10-19T09:00:00.000Z"));
    await setBucket(db, { key: "qloo:day", cap: 1_000, windowEnd: devWindow });

    const next = rolled(await rollAt("2026-10-19T10:00:00.000Z"));

    expect(next["qloo:day"]?.changed).toEqual([]);
    expect(next["qloo:day"]?.after?.windowEnd).toEqual(devWindow);
    expect(next["qloo:day"]?.windowEndWanted).toEqual(at("2026-10-20T00:00:00.000Z"));
  });

  it("sets nothing and says so when no profile covers now", async () => {
    expect(await rollAt("2026-12-01T00:00:00.000Z")).toEqual({ covered: false });
    expect(await rollAt("2026-09-30T23:59:59.999Z")).toEqual({ covered: false });
    expect(await bucketCount()).toBe(0);
  });
});
