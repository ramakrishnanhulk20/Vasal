import { mulberry32 } from "./random.js";

// The pre-registration fixes both numbers (docs/backtest-preregistration.md).
export const BOOTSTRAP_ITERATIONS = 10_000;
export const BOOTSTRAP_SEED = 20_261_019;
const MAX_BOOTSTRAP_ITERATIONS = 1_000_000;
// atanh(1) is infinite, so a perfect correlation is pulled just inside the
// interval before the Fisher transform.
const R_LIMIT = 0.999999;

export type BootstrapStatistic = "spearman" | "partialSpearman";
export type BootstrapShow = { x: readonly number[]; y: readonly number[]; z?: readonly number[] };
export type BootstrapInterval = { low: number; high: number; iterations: number };

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

function requireFinite(values: readonly number[]): void {
  for (const value of values) {
    if (!Number.isFinite(value)) throw new RangeError("statistics need finite numbers");
  }
}

function requirePaired(a: readonly number[], b: readonly number[]): void {
  if (a.length !== b.length) throw new RangeError("paired samples must have the same length");
  requireFinite(a);
  requireFinite(b);
}

// Exact equality, not a tolerance: a mean of identical values can differ
// from them in the last bit, which would make a constant sample look
// spread out and produce a meaningless correlation.
function isConstant(values: readonly number[]): boolean {
  const first = values[0];
  return values.every((value) => value === first);
}

function averageRanks(values: readonly number[]): number[] {
  const order = values.map((_, index) => index).sort((a, b) => values[a]! - values[b]! || a - b);
  const ranks = new Array<number>(values.length);
  for (let start = 0; start < order.length; ) {
    let end = start + 1;
    while (end < order.length && values[order[end]!] === values[order[start]!]) end += 1;
    const rank = (start + 1 + end) / 2;
    for (let k = start; k < end; k += 1) ranks[order[k]!] = rank;
    start = end;
  }
  return ranks;
}

function pearsonOf(x: readonly number[], y: readonly number[]): number | null {
  const n = x.length;
  if (n < 3 || isConstant(x) || isConstant(y)) return null;
  let meanX = 0;
  let meanY = 0;
  for (let i = 0; i < n; i += 1) {
    meanX += x[i]!;
    meanY += y[i]!;
  }
  meanX /= n;
  meanY /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = x[i]! - meanX;
    const dy = y[i]! - meanY;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return clamp(sxy / (Math.sqrt(sxx) * Math.sqrt(syy)), -1, 1);
}

// Average ranks are exact multiples of one half, so a perfect rank
// correlation can be tested exactly. Rounding turns r = 1 into
// 0.9999999999999998, and the partial formula would then divide by that
// rounding error and return noise.
function ranksAgreePerfectly(a: readonly number[], b: readonly number[]): boolean {
  const mirror = a.length + 1;
  let same = true;
  let reversed = true;
  for (let i = 0; i < a.length && (same || reversed); i += 1) {
    if (a[i] !== b[i]) same = false;
    if (a[i] !== mirror - b[i]!) reversed = false;
  }
  return same || reversed;
}

function partialOfRanks(rx: readonly number[], ry: readonly number[], rz: readonly number[]): number | null {
  if (ranksAgreePerfectly(rx, rz) || ranksAgreePerfectly(ry, rz)) return null;
  const rxy = pearsonOf(rx, ry);
  const rxz = pearsonOf(rx, rz);
  const ryz = pearsonOf(ry, rz);
  if (rxy === null || rxz === null || ryz === null) return null;
  const denominator = (1 - rxz * rxz) * (1 - ryz * ryz);
  if (!(denominator > 0)) return null;
  return clamp((rxy - rxz * ryz) / Math.sqrt(denominator), -1, 1);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

// Linear interpolation between order statistics (the common "type 7"
// definition), so the interval does not jump with the iteration count.
function percentile(sorted: readonly number[], p: number): number {
  const position = (sorted.length - 1) * p;
  const below = Math.floor(position);
  const above = Math.ceil(position);
  const low = sorted[below]!;
  return low + (position - below) * (sorted[above]! - low);
}

/**
 * Ranks values from 1 (smallest) to n. Tied values all get the average of
 * the ranks they span, so [10, 20, 20, 30] ranks as [1, 2.5, 2.5, 4].
 * Throws RangeError if any value is not a finite number.
 */
export function rankAverage(values: number[]): number[] {
  requireFinite(values);
  return averageRanks(values);
}

/**
 * Pearson correlation of two paired samples, from -1 to 1. Returns null when
 * there are fewer than 3 pairs or either side is constant, because the
 * correlation is then undefined. Throws RangeError for samples of different
 * lengths or values that are not finite.
 */
export function pearson(x: number[], y: number[]): number | null {
  requirePaired(x, y);
  return pearsonOf(x, y);
}

/**
 * Spearman rank correlation: the Pearson correlation of the average ranks.
 * Returns null when Pearson would (fewer than 3 pairs, or a constant side).
 * Throws RangeError like `pearson`.
 */
export function spearman(x: number[], y: number[]): number | null {
  requirePaired(x, y);
  return pearsonOf(averageRanks(x), averageRanks(y));
}

/**
 * Partial Spearman correlation of x and y controlling for z:
 * (r_xy - r_xz r_yz) / sqrt((1 - r_xz^2)(1 - r_yz^2)), where each r is a
 * Spearman correlation. Returns null when any of the three is undefined or
 * when z is perfectly rank-correlated with x or y, so the formula divides by
 * zero. Throws RangeError for samples of different lengths or values that
 * are not finite.
 */
export function partialSpearman(x: number[], y: number[], z: number[]): number | null {
  requirePaired(x, y);
  requirePaired(x, z);
  return partialOfRanks(averageRanks(x), averageRanks(y), averageRanks(z));
}

/**
 * Residuals of the ordinary least squares fit y = a + b x, one per pair, in
 * the input order. They sum to zero and are uncorrelated with x, up to
 * rounding. Returns null when there are fewer than 2 pairs or x is constant,
 * because the slope is then undefined. Throws RangeError for samples of
 * different lengths or values that are not finite.
 */
export function olsResiduals(y: number[], x: number[]): number[] | null {
  requirePaired(y, x);
  const n = y.length;
  if (n < 2 || isConstant(x)) return null;
  let meanX = 0;
  let meanY = 0;
  for (let i = 0; i < n; i += 1) {
    meanX += x[i]!;
    meanY += y[i]!;
  }
  meanX /= n;
  meanY /= n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = x[i]! - meanX;
    sxy += dx * (y[i]! - meanY);
    sxx += dx * dx;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  return y.map((value, i) => value - meanY - slope * (x[i]! - meanX));
}

/**
 * Pools per-show correlations with the Fisher z transform: z = atanh(r),
 * with r first clipped to [-0.999999, 0.999999], weighted by n - 3, and the
 * weighted mean turned back with tanh. Items whose r is null or whose n is
 * 3 or less are skipped. Returns null when nothing is left to pool.
 * Throws RangeError for an r outside [-1, 1] or an n that is not a
 * non-negative integer.
 */
export function fisherPool(items: ReadonlyArray<{ r: number | null; n: number }>): number | null {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const { r, n } of items) {
    if (!Number.isInteger(n) || n < 0) throw new RangeError("fisherPool needs a non-negative integer n");
    if (r !== null && !(Number.isFinite(r) && r >= -1 && r <= 1)) {
      throw new RangeError("fisherPool needs r from -1 to 1, or null");
    }
    if (r === null || n <= 3) continue;
    const weight = n - 3;
    weightedSum += weight * Math.atanh(clamp(r, -R_LIMIT, R_LIMIT));
    totalWeight += weight;
  }
  return totalWeight > 0 ? Math.tanh(weightedSum / totalWeight) : null;
}

/**
 * The bootstrap behind `bootstrapPooled`, returning null instead of
 * throwing when no iteration produced a pooled value. Same preconditions
 * and RangeErrors otherwise.
 */
export function tryBootstrapPooled(
  shows: ReadonlyArray<BootstrapShow>,
  statistic: BootstrapStatistic,
  opts: { iterations?: number; seed?: number } = {},
): BootstrapInterval | null {
  const iterations = opts.iterations ?? BOOTSTRAP_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_BOOTSTRAP_ITERATIONS) {
    throw new RangeError(`bootstrap iterations must be an integer from 1 to ${MAX_BOOTSTRAP_ITERATIONS}`);
  }
  if (statistic !== "spearman" && statistic !== "partialSpearman") throw new RangeError("unknown statistic");
  const random = mulberry32(opts.seed ?? BOOTSTRAP_SEED);

  const samples = shows.map((show) => {
    requirePaired(show.x, show.y);
    if (statistic === "partialSpearman") {
      if (show.z === undefined) throw new RangeError("partialSpearman needs z for every show");
      requirePaired(show.x, show.z);
    }
    const n = show.x.length;
    return {
      show,
      n,
      x: new Array<number>(n),
      y: new Array<number>(n),
      z: new Array<number>(statistic === "partialSpearman" ? n : 0),
    };
  });

  const pooledValues: number[] = [];
  const items: Array<{ r: number | null; n: number }> = samples.map((sample) => ({ r: null, n: sample.n }));
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (const [index, sample] of samples.entries()) {
      const { show, n, x, y, z } = sample;
      for (let k = 0; k < n; k += 1) {
        const pick = Math.floor(random() * n);
        x[k] = show.x[pick]!;
        y[k] = show.y[pick]!;
        if (show.z !== undefined && statistic === "partialSpearman") z[k] = show.z[pick]!;
      }
      items[index]!.r =
        statistic === "spearman"
          ? pearsonOf(averageRanks(x), averageRanks(y))
          : partialOfRanks(averageRanks(x), averageRanks(y), averageRanks(z));
    }
    const pooled = fisherPool(items);
    if (pooled !== null) pooledValues.push(pooled);
  }

  if (pooledValues.length === 0) return null;
  pooledValues.sort((a, b) => a - b);
  return { low: percentile(pooledValues, 0.025), high: percentile(pooledValues, 0.975), iterations: pooledValues.length };
}

/**
 * A 95% interval for the pooled correlation by bootstrap. Each iteration
 * resamples episodes with replacement within each show, keeping each show's
 * n, computes the per-show statistic (Spearman of x and y, or partial
 * Spearman of x and y given z), and pools the shows with `fisherPool`. The
 * interval is the 2.5th and 97.5th percentiles of the pooled values.
 * Iterations whose pooled value is null are skipped, and `iterations` in the
 * result is the number that were kept, so the skipped count is the number
 * asked for minus that. Defaults: 10,000 iterations and seed 20261019. The
 * same input and seed always give the same result.
 *
 * Throws RangeError for unequal or non-finite samples, a missing z for
 * partialSpearman, an iteration count outside 1 to 1,000,000, a seed outside
 * 0 to 2^32 - 1, or when no iteration produced a pooled value.
 */
export function bootstrapPooled(
  shows: Array<{ x: number[]; y: number[]; z?: number[] }>,
  statistic: BootstrapStatistic,
  opts?: { iterations?: number; seed?: number },
): BootstrapInterval {
  const interval = tryBootstrapPooled(shows, statistic, opts);
  if (interval === null) throw new RangeError("no bootstrap iteration produced a pooled value");
  return interval;
}

/**
 * The descriptive ratio from the pre-registration. Within each show,
 * episodes are ordered by fit (ties keep their input order), and the bottom
 * and top fifths are taken, each floor(n / 5) episodes and never fewer than
 * 1. The adjusted values of all bottom fifths are pooled, as are those of
 * all top fifths, and the result is exp(median(top) - median(bottom)). For
 * adjusted log views that reads as "top-fit episodes drew this many times the
 * views of bottom-fit ones". Shows with fewer than 2 episodes are skipped.
 * Returns null when no show is left. Throws RangeError for unequal or
 * non-finite samples.
 */
export function medianRatioTopBottomQuintile(shows: Array<{ fit: number[]; adjusted: number[] }>): number | null {
  const top: number[] = [];
  const bottom: number[] = [];
  for (const { fit, adjusted } of shows) {
    requirePaired(fit, adjusted);
    const n = fit.length;
    if (n < 2) continue;
    const size = Math.max(1, Math.floor(n / 5));
    const order = fit.map((_, index) => index).sort((a, b) => fit[a]! - fit[b]! || a - b);
    for (let k = 0; k < size; k += 1) bottom.push(adjusted[order[k]!]!);
    for (let k = n - size; k < n; k += 1) top.push(adjusted[order[k]!]!);
  }
  if (top.length === 0) return null;
  return Math.exp(median(top) - median(bottom));
}
