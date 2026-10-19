// Covers the pure statistics behind the backtest, on synthetic numbers
// only. It does not cover which episodes reach these functions
// (backtest-eligibility and backtest-pipeline tests), or whether the method
// itself is a good test of Qloo fit, which is the pre-registration's job.
import { describe, expect, it } from "vitest";
import { mulberry32 } from "../src/backtest/random.js";
import {
  bootstrapPooled,
  fisherPool,
  medianRatioTopBottomQuintile,
  olsResiduals,
  partialSpearman,
  pearson,
  rankAverage,
  spearman,
} from "../src/backtest/stats.js";

function syntheticShows(seed: number, count: number, n: number, noise: number) {
  const random = mulberry32(seed);
  return Array.from({ length: count }, () => {
    const x = Array.from({ length: n }, () => random());
    const y = x.map((value) => value + noise * (random() - 0.5));
    const z = x.map((value) => value * 0.5 + random());
    return { x, y, z };
  });
}

describe("mulberry32", () => {
  it("repeats the same sequence for the same seed and stays in [0, 1)", () => {
    const a = mulberry32(20261019);
    const b = mulberry32(20261019);
    const c = mulberry32(20261020);
    const first = Array.from({ length: 1000 }, () => a());
    expect(Array.from({ length: 1000 }, () => b())).toEqual(first);
    expect(Array.from({ length: 1000 }, () => c())).not.toEqual(first);
    expect(first.every((value) => value >= 0 && value < 1)).toBe(true);
  });

  it("refuses a seed that is not a 32-bit unsigned integer", () => {
    expect(() => mulberry32(1.5)).toThrow(RangeError);
    expect(() => mulberry32(-1)).toThrow(RangeError);
    expect(() => mulberry32(2 ** 32)).toThrow(RangeError);
  });
});

describe("rank correlations", () => {
  it("gives tied values the average of the ranks they span", () => {
    expect(rankAverage([10, 20, 20, 30])).toEqual([1, 2.5, 2.5, 4]);
    expect(rankAverage([3, 3, 3])).toEqual([2, 2, 2]);
    expect(rankAverage([5, -1, 5, 0])).toEqual([3.5, 1, 3.5, 2]);
  });

  it("computes the worked Spearman example with a tie: 8 / sqrt(95)", () => {
    const rho = spearman([1, 2, 3, 4, 5], [5, 6, 7, 8, 7]);
    expect(rho).not.toBeNull();
    expect(Math.abs(rho! - 0.8207826816681233)).toBeLessThan(1e-12);
    expect(Math.abs(rho! - 8 / Math.sqrt(95))).toBeLessThan(1e-12);
  });

  it("is the Pearson correlation of the average ranks", () => {
    const x = [0.3, 9, 9, 2, 41];
    const y = [7, 1, 3, 3, 100];
    expect(spearman(x, y)).toBeCloseTo(pearson(rankAverage(x), rankAverage(y))!, 15);
  });

  it("returns null for a constant side or fewer than 3 pairs", () => {
    expect(spearman([1, 2, 3, 4], [7, 7, 7, 7])).toBeNull();
    expect(pearson([0.1, 0.1, 0.1], [1, 2, 3])).toBeNull();
    expect(spearman([1, 2], [2, 1])).toBeNull();
  });

  it("refuses unequal lengths and values that are not finite", () => {
    expect(() => spearman([1, 2, 3], [1, 2])).toThrow(RangeError);
    expect(() => pearson([1, Number.NaN, 3], [1, 2, 3])).toThrow(RangeError);
    expect(() => rankAverage([1, Number.POSITIVE_INFINITY])).toThrow(RangeError);
  });

  it("computes a hand-worked partial Spearman case, on ranks, so monotone rescaling changes nothing", () => {
    // Ranks: x = 1..5, y = [2,1,4,3,5], z = [1,3,2,5,4], so r_xy = 0.8,
    // r_xz = 0.8 and r_yz = 0.3 by hand.
    const expected = (0.8 - 0.8 * 0.3) / Math.sqrt((1 - 0.8 ** 2) * (1 - 0.3 ** 2));
    expect(partialSpearman([1, 2, 3, 4, 5], [2, 1, 4, 3, 5], [1, 3, 2, 5, 4])).toBeCloseTo(expected, 12);

    const x = [10, 20, 30, 40, 50];
    const y = [2, 1, 4, 3, 5].map((value) => value ** 3);
    const z = [1, 3, 2, 5, 4].map((value) => Math.exp(value));
    expect(partialSpearman(x, y, z)).toBeCloseTo(expected, 12);
  });

  it("returns null for a partial correlation when the control ranks exactly like x or y, or is constant", () => {
    expect(partialSpearman([1, 2, 3, 4], [4, 1, 3, 2], [10, 20, 30, 40])).toBeNull();
    expect(partialSpearman([1, 2, 3, 4], [4, 1, 3, 2], [40, 30, 20, 10])).toBeNull();
    expect(partialSpearman([1, 2, 3, 4], [4, 1, 3, 2], [9, 0.5, 4, 1])).toBeNull();
    expect(partialSpearman([1, 2, 2, 4], [4, 1, 3, 2], [0, 5, 5, 6])).toBeNull();
    expect(partialSpearman([1, 2, 3, 4], [4, 1, 3, 2], [5, 5, 5, 5])).toBeNull();
  });
});

describe("olsResiduals", () => {
  it("matches the hand-worked fit and leaves residuals that sum to 0 and are orthogonal to x", () => {
    const x = [1, 2, 3, 4, 5];
    const residuals = olsResiduals([1, 3, 2, 5, 4], x);
    expect(residuals).not.toBeNull();
    // Slope 8 / 10 = 0.8 and intercept 0.6 by hand.
    [-0.4, 0.8, -1, 1.2, -0.6].forEach((value, i) => expect(residuals![i]).toBeCloseTo(value, 12));
    expect(Math.abs(residuals!.reduce((sum, value) => sum + value, 0))).toBeLessThan(1e-12);
    expect(Math.abs(residuals!.reduce((sum, value, i) => sum + value * x[i]!, 0))).toBeLessThan(1e-12);
  });

  it("stays orthogonal on log views against log age", () => {
    const random = mulberry32(7);
    const ages = Array.from({ length: 200 }, () => 80 + Math.floor(random() * 600));
    const views = ages.map((age) => Math.floor(10_000 * age ** 0.4 * (0.5 + random())));
    const x = ages.map((age) => Math.log(age));
    const residuals = olsResiduals(
      views.map((count) => Math.log(count + 1)),
      x,
    )!;
    expect(Math.abs(residuals.reduce((sum, value) => sum + value, 0))).toBeLessThan(1e-9);
    expect(Math.abs(residuals.reduce((sum, value, i) => sum + value * x[i]!, 0))).toBeLessThan(1e-9);
  });

  it("returns null when x is constant or there is only one pair", () => {
    expect(olsResiduals([1, 2, 3], [4, 4, 4])).toBeNull();
    expect(olsResiduals([1], [2])).toBeNull();
  });
});

describe("fisherPool", () => {
  it("pools two equal correlations to the same value", () => {
    expect(fisherPool([{ r: 0.5, n: 13 }, { r: 0.5, n: 23 }])).toBeCloseTo(0.5, 12);
  });

  it("weights each show by n - 3 on the z scale", () => {
    const expected = Math.tanh((10 * Math.atanh(0.2) + 20 * Math.atanh(0.6)) / 30);
    expect(fisherPool([{ r: 0.2, n: 13 }, { r: 0.6, n: 23 }])).toBeCloseTo(expected, 12);
  });

  it("skips items with n of 3 or less and items with no r", () => {
    expect(fisherPool([{ r: 0.5, n: 13 }, { r: -0.9, n: 3 }, { r: null, n: 40 }])).toBeCloseTo(0.5, 12);
    expect(fisherPool([{ r: 0.9, n: 3 }, { r: 0.9, n: 2 }])).toBeNull();
    expect(fisherPool([])).toBeNull();
  });

  it("clips a perfect correlation instead of returning infinity", () => {
    expect(fisherPool([{ r: 1, n: 10 }])).toBeCloseTo(0.999999, 9);
    expect(fisherPool([{ r: -1, n: 10 }])).toBeCloseTo(-0.999999, 9);
  });

  it("refuses r outside [-1, 1] and n that is not a whole number", () => {
    expect(() => fisherPool([{ r: 1.2, n: 10 }])).toThrow(RangeError);
    expect(() => fisherPool([{ r: 0.2, n: 10.5 }])).toThrow(RangeError);
  });
});

describe("bootstrapPooled", () => {
  const shows = syntheticShows(11, 6, 40, 1.5);

  it("is byte-identical across runs with the same seed and differs with another seed", () => {
    const first = JSON.stringify(bootstrapPooled(shows, "spearman", { iterations: 2_000, seed: 20261019 }));
    const second = JSON.stringify(bootstrapPooled(shows, "spearman", { iterations: 2_000, seed: 20261019 }));
    const other = JSON.stringify(bootstrapPooled(shows, "spearman", { iterations: 2_000, seed: 42 }));
    expect(second).toBe(first);
    expect(other).not.toBe(first);

    const partialA = JSON.stringify(bootstrapPooled(shows, "partialSpearman", { iterations: 2_000 }));
    const partialB = JSON.stringify(bootstrapPooled(shows, "partialSpearman", { iterations: 2_000 }));
    expect(partialB).toBe(partialA);
  });

  it("uses 10,000 iterations and seed 20261019 by default", () => {
    const byDefault = bootstrapPooled(shows, "spearman");
    expect(byDefault.iterations).toBe(10_000);
    expect(bootstrapPooled(shows, "spearman", { iterations: 10_000, seed: 20261019 })).toEqual(byDefault);
  });

  it("brackets the pooled estimate on noisy positive data", () => {
    const pooled = fisherPool(shows.map((show) => ({ r: spearman(show.x, show.y), n: show.x.length })))!;
    const interval = bootstrapPooled(shows, "spearman", { iterations: 2_000 });
    expect(interval.low).toBeLessThan(pooled);
    expect(interval.high).toBeGreaterThan(pooled);
  });

  it("gives an interval above 0.99 on perfectly correlated data", () => {
    const perfect = syntheticShows(5, 4, 30, 0).map(({ x, z }) => ({ x, y: x.map((value) => 3 * value + 1), z }));
    const interval = bootstrapPooled(perfect, "spearman");
    expect(interval.low).toBeGreaterThan(0.99);
    expect(interval.high).toBeGreaterThan(0.99);
  });

  it("refuses partialSpearman without z and a bad iteration count", () => {
    const noZ = shows.map(({ x, y }) => ({ x, y }));
    expect(() => bootstrapPooled(noZ, "partialSpearman", { iterations: 10 })).toThrow(RangeError);
    expect(() => bootstrapPooled(shows, "spearman", { iterations: 0 })).toThrow(RangeError);
  });

  it("throws when no iteration can be pooled", () => {
    expect(() => bootstrapPooled([{ x: [1, 2, 3], y: [3, 1, 2] }], "spearman", { iterations: 50 })).toThrow(RangeError);
  });
});

describe("medianRatioTopBottomQuintile", () => {
  it("matches the hand-computed ratio on a constructed case", () => {
    // Show A has 10 episodes, so fifths of 2: bottom fits 1 and 2 hold -1.0
    // and -0.2, top fits 9 and 10 hold 0.5 and 1.1. Show B has 5, so fifths
    // of 1: bottom -0.4, top 0.9. Pooled bottom median -0.4, top 0.9.
    // Show C has one episode and is skipped.
    const ratio = medianRatioTopBottomQuintile([
      { fit: [5, 1, 9, 3, 7, 2, 8, 4, 10, 6], adjusted: [0, -1.0, 0.5, 0, 0, -0.2, 0, 0, 1.1, 0] },
      { fit: [3, 1, 2, 5, 4], adjusted: [0, -0.4, 0, 0.9, 0] },
      { fit: [1], adjusted: [100] },
    ]);
    expect(ratio).toBeCloseTo(Math.exp(1.3), 12);
  });

  it("uses at least one episode per fifth and returns null with nothing to compare", () => {
    expect(medianRatioTopBottomQuintile([{ fit: [2, 1, 4, 3], adjusted: [0, -1, 1, 0] }])).toBeCloseTo(Math.exp(2), 12);
    expect(medianRatioTopBottomQuintile([{ fit: [1], adjusted: [0] }])).toBeNull();
    expect(medianRatioTopBottomQuintile([])).toBeNull();
  });
});
