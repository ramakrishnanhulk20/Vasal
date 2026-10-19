// Covers the budget policy schema, the shipped scripts/budget-policy.json and
// profileFor. It does not cover setting the buckets (ops-roll.test.ts) or
// whether the shipped numbers suit Qloo's real quota, which is only known on
// key day.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadPolicy, parsePolicy, PolicyError, profileFor, type BudgetPolicy } from "../src/ops/policy.js";

const SHIPPED = fileURLToPath(new URL("../scripts/budget-policy.json", import.meta.url));

function profile(from: string, to: string, buckets: unknown[] = [{ key: "qloo:day", window: "day", cap: 10 }]) {
  return { from, to, buckets };
}

function issuesOf(raw: unknown): string[] {
  try {
    parsePolicy(raw);
  } catch (error) {
    if (error instanceof PolicyError) return error.issues;
    throw error;
  }
  return [];
}

describe("the shipped policy", () => {
  it("loads and holds the starting numbers for October and November", async () => {
    const policy = await loadPolicy(SHIPPED);
    const caps = policy.profiles.map((p) => ({
      range: `${p.from}..${p.to}`,
      caps: Object.fromEntries(p.buckets.map((b) => [b.key, [b.window, b.cap]])),
    }));

    expect(caps).toEqual([
      {
        range: "2026-10-01..2026-11-01",
        caps: {
          "qloo:month": ["month", 9_000],
          "qloo:day": ["day", 300],
          "qloo:day:offline": ["day", 4_000],
          "anthropic:day": ["day", 2_000_000],
          "anthropic:day:offline": ["day", 1_500_000],
          "youtube:day": ["day", 9_000],
        },
      },
      {
        range: "2026-11-01..2026-12-01",
        caps: {
          "qloo:month": ["month", 9_500],
          "qloo:day": ["day", 600],
          "qloo:day:offline": ["day", 500],
          "anthropic:day": ["day", 3_000_000],
          "anthropic:day:offline": ["day", 500_000],
          "youtube:day": ["day", 9_000],
        },
      },
    ]);
    expect(policy.notes?.join(" ")).toContain("judging");
  });
});

describe("parsePolicy", () => {
  it("refuses overlapping profiles, in either order", () => {
    expect(issuesOf({ profiles: [profile("2026-10-01", "2026-11-02"), profile("2026-11-01", "2026-12-01")] })).toEqual([
      expect.stringContaining("overlaps the profile starting 2026-10-01"),
    ]);
    expect(issuesOf({ profiles: [profile("2026-11-01", "2026-12-01"), profile("2026-10-15", "2026-11-15")] })).toHaveLength(1);
    expect(issuesOf({ profiles: [profile("2026-10-01", "2026-12-01"), profile("2026-10-01", "2026-12-01")] })).toHaveLength(1);
  });

  it("refuses a long profile that holds two short ones, not only the first", () => {
    const issues = issuesOf({
      profiles: [profile("2026-10-01", "2026-12-01"), profile("2026-10-05", "2026-10-10"), profile("2026-10-15", "2026-10-20")],
    });

    expect(issues).toEqual([
      expect.stringContaining("at profiles.1: overlaps the profile starting 2026-10-01"),
      expect.stringContaining("at profiles.2: overlaps the profile starting 2026-10-01"),
    ]);
  });

  it("accepts profiles that touch", () => {
    expect(issuesOf({ profiles: [profile("2026-10-01", "2026-11-01"), profile("2026-11-01", "2026-12-01")] })).toEqual([]);
  });

  it("refuses caps that are negative, fractional, text or past a safe integer", () => {
    for (const cap of [-1, 2.5, "10", Number.MAX_SAFE_INTEGER + 1]) {
      expect(issuesOf({ profiles: [profile("2026-10-01", "2026-11-01", [{ key: "qloo:day", window: "day", cap }])] })).not.toEqual([]);
    }
    expect(issuesOf({ profiles: [profile("2026-10-01", "2026-11-01", [{ key: "qloo:day", window: "day", cap: 0 }])] })).toEqual([]);
  });

  it("refuses a window missing from its key, a duplicate key, a per-second key and unknown fields", () => {
    const bad: unknown[][] = [
      [{ key: "qloo:month", window: "day", cap: 1 }],
      [
        { key: "qloo:day", window: "day", cap: 1 },
        { key: "qloo:day", window: "day", cap: 2 },
      ],
      [{ key: "qloo:second:1729", window: "day", cap: 1 }],
      [{ key: "Qloo:Day", window: "day", cap: 1 }],
      [{ key: "qloo:day", window: "week", cap: 1 }],
      [{ key: "qloo:day", window: "day", cap: 1, used: 0 }],
    ];
    for (const buckets of bad) {
      expect(issuesOf({ profiles: [profile("2026-10-01", "2026-11-01", buckets)] })).not.toEqual([]);
    }
    expect(issuesOf({ profiles: [profile("2026-10-01", "2026-11-01")], extra: true })).not.toEqual([]);
  });

  it("refuses a profile that ends before it starts, an impossible date and an empty list", () => {
    expect(issuesOf({ profiles: [profile("2026-11-01", "2026-11-01")] })).not.toEqual([]);
    expect(issuesOf({ profiles: [profile("2026-02-30", "2026-03-01")] })).not.toEqual([]);
    expect(issuesOf({ profiles: [] })).not.toEqual([]);
    expect(issuesOf({ profiles: [profile("2026-10-01", "2026-11-01", [])] })).not.toEqual([]);
  });
});

describe("loadPolicy", () => {
  it("throws PolicyError for a missing file and for a file that is not JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vasal-policy-"));
    try {
      const broken = join(dir, "broken.json");
      await writeFile(broken, "{ not json", "utf8");
      await expect(loadPolicy(broken)).rejects.toThrow(PolicyError);
      await expect(loadPolicy(join(dir, "missing.json"))).rejects.toThrow(PolicyError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("profileFor", () => {
  const at = (iso: string) => new Date(iso);
  let policy: BudgetPolicy;

  it("covers each profile from 00:00 UTC on its from date up to, not including, its to date", async () => {
    policy = await loadPolicy(SHIPPED);
    const [october, november] = policy.profiles;

    expect(profileFor(policy, at("2026-09-30T23:59:59.999Z"))).toBeNull();
    expect(profileFor(policy, at("2026-10-01T00:00:00.000Z"))).toBe(october);
    expect(profileFor(policy, at("2026-10-31T23:59:59.999Z"))).toBe(october);
    expect(profileFor(policy, at("2026-11-01T00:00:00.000Z"))).toBe(november);
    expect(profileFor(policy, at("2026-11-30T23:59:59.999Z"))).toBe(november);
    expect(profileFor(policy, at("2026-12-01T00:00:00.000Z"))).toBeNull();
  });

  it("throws RangeError for an invalid date", async () => {
    policy = await loadPolicy(SHIPPED);
    expect(() => profileFor(policy, new Date(Number.NaN))).toThrow(RangeError);
  });
});
