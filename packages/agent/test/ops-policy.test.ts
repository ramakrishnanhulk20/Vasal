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

// Each profile's buckets as key: [window, cap], so a change to any cap shows here.
const OCTOBER = {
  "qloo:month": ["month", 12_000],
  "qloo:day": ["day", 1_000],
  "qloo:day:offline": ["day", 6_000],
  "qloo:month:offline": ["month", 4_000],
  "anthropic:day": ["day", 2_000_000],
  "anthropic:day:offline": ["day", 4_000_000],
  "youtube:day": ["day", 9_000],
  "qloo:day:mcp": ["day", 300],
  "qloo:month:mcp": ["month", 2_000],
  "anthropic:day:mcp": ["day", 500_000],
  "mcp:keys:day": ["day", 50],
};
const NOVEMBER = {
  "qloo:month": ["month", 32_000],
  "qloo:day": ["day", 1_400],
  "qloo:day:offline": ["day", 300],
  "qloo:month:offline": ["month", 3_000],
  "anthropic:day": ["day", 3_000_000],
  "anthropic:day:offline": ["day", 500_000],
  "youtube:day": ["day", 9_000],
  "qloo:day:mcp": ["day", 300],
  "qloo:month:mcp": ["month", 4_500],
  "anthropic:day:mcp": ["day", 1_000_000],
  "mcp:keys:day": ["day", 100],
};
// The judging window, 30 Oct to 6 Nov, raises only these day caps; every
// month cap stays its month's. Its October part also cuts the offline share.
const JUDGING_DAYS = {
  "qloo:day": ["day", 3_000],
  "qloo:day:mcp": ["day", 600],
  "anthropic:day": ["day", 20_000_000],
  "anthropic:day:mcp": ["day", 1_000_000],
  "mcp:keys:day": ["day", 100],
};
const AFTER_JUDGING = {
  ...NOVEMBER,
  "qloo:month": ["month", 20_000],
  "qloo:month:offline": ["month", 2_000],
  "anthropic:day": ["day", 1_000_000],
  "anthropic:day:mcp": ["day", 500_000],
};
const DAY_MS = 24 * 60 * 60 * 1_000;

describe("the shipped policy", () => {
  it("holds October and November, each with its judging days split off at higher day caps, then December and January", async () => {
    const policy = await loadPolicy(SHIPPED);
    const caps = policy.profiles.map((p) => ({
      range: `${p.from}..${p.to}`,
      caps: Object.fromEntries(p.buckets.map((b) => [b.key, [b.window, b.cap]])),
    }));

    expect(caps).toEqual([
      { range: "2026-10-01..2026-10-30", caps: OCTOBER },
      { range: "2026-10-30..2026-11-01", caps: { ...OCTOBER, ...JUDGING_DAYS, "qloo:day:offline": ["day", 1_500] } },
      { range: "2026-11-01..2026-11-07", caps: { ...NOVEMBER, ...JUDGING_DAYS } },
      { range: "2026-11-07..2026-12-01", caps: NOVEMBER },
      { range: "2026-12-01..2027-01-01", caps: AFTER_JUDGING },
      { range: "2027-01-01..2027-02-01", caps: AFTER_JUDGING },
    ]);
    expect(policy.notes?.join(" ")).toContain("judging");
    expect(policy.notes?.join(" ")).toContain("Judging now ends 5 Nov");
    expect(policy.notes?.join(" ")).toContain("qloo:month:mcp");
    expect(policy.notes?.join(" ")).toContain("qloo:month:offline");
  });

  it("fits October and November inside the one Qloo month that runs from key day to 20 Nov, and November's judging days inside November", async () => {
    const policy = await loadPolicy(SHIPPED);
    const capOf = (p: (typeof policy.profiles)[number], key: string) => p.buckets.find((b) => b.key === key)?.cap ?? Number.NaN;
    // A profile that starts mid-month must keep its month's cap, so the month
    // bucket, its window and what it has used carry over unchanged.
    const monthCaps = (month: string) => [...new Set(policy.profiles.filter((p) => p.from.startsWith(month)).map((p) => capOf(p, "qloo:month")))];
    const [october] = monthCaps("2026-10");
    const [november] = monthCaps("2026-11");
    expect(monthCaps("2026-10")).toEqual([12_000]);
    expect(monthCaps("2026-11")).toEqual([32_000]);
    // 49,498 were left after the key-day probes; about 5,000 stays free for
    // local runs, which the production meter never sees.
    expect(october! + november!).toBeLessThanOrEqual(44_500);

    const judging = policy.profiles.find((p) => p.from === "2026-11-01")!;
    const judgingDays = (Date.parse(judging.to) - Date.parse(judging.from)) / DAY_MS;
    expect(judgingDays).toBe(6);
    const perDay = capOf(judging, "qloo:day") + capOf(judging, "qloo:day:mcp") + capOf(judging, "qloo:day:offline");
    expect(perDay * judgingDays).toBeLessThanOrEqual(november!);
  });

  it("keeps MCP's own month well under the shared ceiling and its day share under the website's, in every profile (D3.3)", async () => {
    const policy = await loadPolicy(SHIPPED);
    for (const p of policy.profiles) {
      const cap = (key: string) => p.buckets.find((b) => b.key === key)?.cap ?? Number.NaN;
      expect(cap("qloo:month:mcp"), p.from).toBeLessThanOrEqual(cap("qloo:month") / 2);
      expect(cap("qloo:day:mcp"), p.from).toBeLessThan(cap("qloo:day"));
      expect(cap("anthropic:day:mcp"), p.from).toBeLessThan(cap("anthropic:day"));
      expect(cap("mcp:keys:day"), p.from).toBeGreaterThan(0);
    }
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
    const [october, octoberJudging, novemberJudging, november, december, january] = policy.profiles;

    expect(profileFor(policy, at("2026-09-30T23:59:59.999Z"))).toBeNull();
    expect(profileFor(policy, at("2026-10-01T00:00:00.000Z"))).toBe(october);
    expect(profileFor(policy, at("2026-10-29T23:59:59.999Z"))).toBe(october);
    expect(profileFor(policy, at("2026-10-30T00:00:00.000Z"))).toBe(octoberJudging);
    expect(profileFor(policy, at("2026-10-31T23:59:59.999Z"))).toBe(octoberJudging);
    expect(profileFor(policy, at("2026-11-01T00:00:00.000Z"))).toBe(novemberJudging);
    expect(profileFor(policy, at("2026-11-06T23:59:59.999Z"))).toBe(novemberJudging);
    expect(profileFor(policy, at("2026-11-07T00:00:00.000Z"))).toBe(november);
    expect(profileFor(policy, at("2026-11-30T23:59:59.999Z"))).toBe(november);
    expect(profileFor(policy, at("2026-12-01T00:00:00.000Z"))).toBe(december);
    expect(profileFor(policy, at("2027-01-01T00:00:00.000Z"))).toBe(january);
    expect(profileFor(policy, at("2027-01-31T23:59:59.999Z"))).toBe(january);
    expect(profileFor(policy, at("2027-02-01T00:00:00.000Z"))).toBeNull();
  });

  it("gives the judging window's qloo:day of 3,000 on 3 Nov and November's 1,400 again on 7 Nov", async () => {
    policy = await loadPolicy(SHIPPED);
    const qlooDay = (iso: string) => profileFor(policy, at(iso))?.buckets.find((bucket) => bucket.key === "qloo:day")?.cap;

    expect(qlooDay("2026-11-03T12:00:00.000Z")).toBe(3_000);
    expect(qlooDay("2026-11-07T12:00:00.000Z")).toBe(1_400);
  });

  it("throws RangeError for an invalid date", async () => {
    policy = await loadPolicy(SHIPPED);
    expect(() => profileFor(policy, new Date(Number.NaN))).toThrow(RangeError);
  });
});
