// Covers the pure board maths: trend state, the new-audience segment, reach
// bands and the ranked board built from a run context. It does not cover how
// tools fill the context (agent-tools.test.ts), the prose check on angles
// (agent-prose.test.ts), or whether the thresholds suit real Qloo data, which
// only the live probe can show. Every row and name here is synthetic.
import { describe, expect, it } from "vitest";
import { bringsNewFrom, buildBoard, reachFrom, risingFrom } from "../src/agent/board.js";
import { createRunContext, type Demographics, type RunContext, type TrendRow } from "../src/agent/context.js";

const SHOW = { qlooId: "00000000-0000-4000-8000-000000000001", name: "Synthetic Show" };
const id = (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`;

function weeks(recent: number, baseline: number, count = 12): TrendRow[] {
  const rows: TrendRow[] = [];
  for (let week = 0; week < count; week += 1) {
    const date = new Date(Date.UTC(2026, 9, 12) - week * 7 * 86_400_000).toISOString().slice(0, 10);
    rows.push({ date, population_percentile: week < 4 ? recent : baseline });
  }
  return rows;
}

const demographics = (age: Record<string, number>, gender: Record<string, number>): Demographics => ({ age, gender });

function contextWith(people: Array<[number, string, number | null, number | null]>, exclusions: string[] = []): RunContext {
  const ctx = createRunContext({ show: SHOW, episodeTitles: [], exclusions });
  for (const [n, name, affinity, popularity] of people) ctx.people.set(id(n), { name, affinity, popularity });
  return ctx;
}

describe("risingFrom", () => {
  it("reads rising, steady and falling from the newest 4 weeks against the 8 before", () => {
    expect(risingFrom(weeks(60, 50))).toEqual({ state: "rising", points: 10 });
    expect(risingFrom(weeks(51, 50))).toEqual({ state: "steady", points: 1 });
    expect(risingFrom(weeks(50, 50))).toEqual({ state: "steady", points: 0 });
    expect(risingFrom(weeks(47.5, 50))).toEqual({ state: "falling", points: -2.5 });
  });

  it("puts the threshold at exactly plus and minus 2 points", () => {
    expect(risingFrom(weeks(52, 50)).state).toBe("rising");
    expect(risingFrom(weeks(48, 50)).state).toBe("falling");
  });

  it("scales fractions from 0 to 1 into percentile points", () => {
    expect(risingFrom(weeks(0.6, 0.5))).toEqual({ state: "rising", points: 10 });
  });

  it("is unknown with 11 weeks, and with 12 rows when one has no percentile", () => {
    expect(risingFrom(weeks(60, 50, 11))).toEqual({ state: "unknown", points: null });
    const gappy = weeks(60, 50);
    gappy[5] = { date: gappy[5]?.date ?? "", population_percentile: null };
    expect(risingFrom(gappy)).toEqual({ state: "unknown", points: null });
  });

  it("orders by date itself and counts a repeated date once", () => {
    const shuffled = weeks(60, 50).reverse();
    expect(risingFrom(shuffled)).toEqual({ state: "rising", points: 10 });
    const repeated = weeks(60, 50, 11);
    repeated.push({ ...(repeated[0] as TrendRow) });
    expect(risingFrom(repeated).state).toBe("unknown");
  });
});

describe("bringsNewFrom", () => {
  it("picks the largest gap where the person over-indexes and the show does not", () => {
    const show = demographics({ "25_to_29": -0.2, "30_to_34": 0.3, "55_and_older": 0 }, { female: -0.1, male: 0.1 });
    const person = demographics({ "25_to_29": 0.25, "30_to_34": 0.6, "55_and_older": 0.1 }, { female: 0.2, male: -0.2 });

    expect(bringsNewFrom(show, person)).toEqual({ segment: "age:25_to_29", label: "listeners 25 to 29", gap: 0.45 });
  });

  it("can pick a gender segment with a plain label", () => {
    const show = demographics({ "25_to_29": 0.1 }, { female: -0.3, male: 0.3 });
    const person = demographics({ "25_to_29": 0.4 }, { female: 0.2, male: -0.2 });

    expect(bringsNewFrom(show, person)).toEqual({ segment: "gender:female", label: "women", gap: 0.5 });
  });

  it("returns null when the person never over-indexes where the show does not", () => {
    const show = demographics({ "25_to_29": 0.2, "45_to_54": -0.3 }, { female: 0.1, male: -0.1 });
    const person = demographics({ "25_to_29": 0.5, "45_to_54": -0.1 }, { female: 0.4, male: 0 });

    expect(bringsNewFrom(show, person)).toBeNull();
  });

  it("ignores segments Qloo did not document and segments missing on one side", () => {
    const show = demographics({ teen_hackers: -0.5, "30_to_34": -0.2 }, {});
    const person = demographics({ teen_hackers: 0.9 }, { female: 0.4 });

    expect(bringsNewFrom(show, person)).toBeNull();
  });
});

describe("reachFrom", () => {
  it("bands popularity, with a missing value counted as bookable", () => {
    expect(reachFrom(0.95)).toBe("household name");
    expect(reachFrom(0.9499)).toBe("well known");
    expect(reachFrom(0.8)).toBe("well known");
    expect(reachFrom(0.79)).toBe("bookable");
    expect(reachFrom(null)).toBe("bookable");
  });
});

describe("buildBoard", () => {
  it("drops an unknown personId, excluded names in any case or spacing, and duplicates", () => {
    const ctx = contextWith(
      [
        [1, "Synthetic Guest One", 0.9, 0.5],
        [2, "Ada  Synthetic", 0.8, 0.5],
        [3, "Grace Synthetic", 0.7, 0.5],
        [4, "Synthetic Guest Four", 0.6, 0.5],
      ],
      ["  ADA synthetic ", "grace​ synthetic"],
    );

    const board = buildBoard(ctx, [
      { personId: id(1), angle: "first" },
      { personId: id(99), angle: "never returned" },
      { personId: id(2), angle: "excluded by case and spacing" },
      { personId: id(3), angle: "excluded with an invisible character" },
      { personId: id(1), angle: "repeat" },
      { personId: id(4), angle: "fourth" },
    ]);

    expect(board.map((entry) => [entry.personId, entry.angle])).toEqual([
      [id(1), "first"],
      [id(4), "fourth"],
    ]);
  });

  it("ranks by fit, then by lower popularity, with no affinity last at fit 0", () => {
    const ctx = contextWith([
      [1, "Synthetic A", 0.801, 0.9],
      [2, "Synthetic B", 0.799, 0.3],
      [3, "Synthetic C", 0.95, 0.99],
      [4, "Synthetic D", null, 0.1],
      [5, "Synthetic E", 0.7, null],
    ]);

    const board = buildBoard(
      ctx,
      [1, 2, 3, 4, 5].map((n) => ({ personId: id(n), angle: `pick ${n}` })),
    );

    expect(board.map((entry) => [entry.name, entry.fit, entry.fitKnown, entry.fitRank, entry.reach])).toEqual([
      ["Synthetic C", 0.95, true, 1, "household name"],
      ["Synthetic B", 0.8, true, 2, "bookable"],
      ["Synthetic A", 0.8, true, 3, "well known"],
      ["Synthetic E", 0.7, true, 4, "bookable"],
      ["Synthetic D", 0, false, 5, "bookable"],
    ]);
  });

  it("fills trend, new audience and the top 5 shared tags from the context", () => {
    const ctx = contextWith([[1, "Synthetic Guest", 0.9, 0.5]]);
    ctx.showDemographics = demographics({ "55_and_older": -0.2 }, {});
    ctx.personDemographics.set(id(1), demographics({ "55_and_older": 0.3 }, {}));
    ctx.trends.set(id(1), weeks(60, 50));
    ctx.compares.set(
      id(1),
      [0.2, null, 0.9, 0.5, 0.7, 0.1, 0.8].map((score, n) => ({ name: `tag ${String.fromCharCode(97 + n)}`, score })),
    );

    const [entry] = buildBoard(ctx, [{ personId: id(1), angle: "angle" }]);

    expect(entry?.rising).toEqual({ state: "rising", points: 10 });
    expect(entry?.bringsNew).toEqual({ segment: "age:55_and_older", label: "listeners 55 and older", gap: 0.5 });
    expect(entry?.sharedTags).toEqual(["tag c", "tag g", "tag e", "tag d", "tag a"]);
  });

  it("leaves trend unknown and new audience empty when nothing was fetched", () => {
    const ctx = contextWith([[1, "Synthetic Guest", 0.9, 0.5]]);

    const [entry] = buildBoard(ctx, [{ personId: id(1), angle: "angle" }]);

    expect(entry?.rising).toEqual({ state: "unknown", points: null });
    expect(entry?.bringsNew).toBeNull();
    expect(entry?.sharedTags).toEqual([]);
  });
});
