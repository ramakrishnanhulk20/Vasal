// Post-hoc robustness checks on a stored backtest dataset. Both were added
// after docs/backtest-results.md was first published, and neither is part of
// the pre-registered result. It reads only the dataset file: no network call,
// no key, no database.
//
// Usage: npm run backtest:robustness -- <dataset.json>
import { readFileSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import type { z } from "zod";
import { analyse } from "../src/backtest/analyse.js";
import { mulberry32 } from "../src/backtest/random.js";
import {
  fisherPool,
  olsResiduals,
  partialSpearman,
  spearman,
  tryBootstrapPooled,
  type BootstrapStatistic,
} from "../src/backtest/stats.js";
import { DatasetSchema, type Dataset, type HypothesisResult } from "../src/backtest/types.js";

const USAGE = "Usage: npm run backtest:robustness -- <dataset.json>";
// The same limit as scripts/backtest.ts --analyse: a bigger file is refused unread.
const MAX_DATASET_BYTES = 256 * 1024 * 1024;
const MAX_ITERATIONS = 1_000_000;

// The two kinds of row the hand precision check found misread. An Armchair
// Expert "Fact Check" episode names an earlier guest who is not on it, and in
// the Conan & Sona travel specials the co-host was read as the guest.
const FACT_CHECK = /fact check/i;
const CONAN_AND_SONA = /conan\s*(&|and)\s*sona/i;

// Fixed when the reviewer asked for the guest-level check on 24 Oct, so the
// published interval reruns exactly.
export const GUEST_BOOTSTRAP_ITERATIONS = 2_000;
export const GUEST_BOOTSTRAP_SEED = 20_261_024;

export type MisreadKind = "factCheck" | "conanAndSona";

/** Per kept show: the analysis inputs, and each guest's row indexes in order of first appearance. */
export type GuestSeries = { fit: number[]; fame: number[]; adjusted: number[]; guests: number[][] };

type Sample = { fit: number[]; fame: number[]; adjusted: number[] };

/** Which misread kind a title is, or null for a row the check keeps. */
export function misreadKind(title: string): MisreadKind | null {
  if (FACT_CHECK.test(title)) return "factCheck";
  if (CONAN_AND_SONA.test(title)) return "conanAndSona";
  return null;
}

/**
 * The dataset without its misread rows, with each kept show's recorded row
 * count set to the rows left, because analyse() refuses a count that does
 * not match. Returns how many rows of each kind were removed. A show left
 * with fewer than 30 rows is not dropped here, so analyse() then refuses the
 * whole dataset rather than quietly changing the sample.
 */
export function withoutMisreadRows(dataset: Dataset): { dataset: Dataset; removed: Record<MisreadKind, number> } {
  const removed: Record<MisreadKind, number> = { factCheck: 0, conanAndSona: 0 };
  const rows = dataset.rows.filter((row) => {
    const kind = misreadKind(row.title);
    if (kind !== null) removed[kind] += 1;
    return kind === null;
  });
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.showName, (counts.get(row.showName) ?? 0) + 1);
  const shows = dataset.shows.map((show) => (show.status === "kept" ? { ...show, rows: counts.get(show.name) ?? 0 } : show));
  return { dataset: { ...dataset, shows, rows }, removed };
}

/**
 * Builds, per kept show in dataset order, the fit, fame and adjusted views
 * exactly as analyse() does, and groups the rows by Qloo person id. A guest
 * on two shows is two guests, because fit is measured against each show.
 * Throws RangeError when a kept show's adjusted views cannot be computed.
 */
export function guestSeries(dataset: Dataset): GuestSeries[] {
  return dataset.shows
    .filter((show) => show.status === "kept")
    .map((show) => {
      const rows = dataset.rows.filter((row) => row.showName === show.name);
      const adjusted = olsResiduals(
        rows.map((row) => Math.log(row.views + 1)),
        rows.map((row) => Math.log(row.ageDays)),
      );
      if (adjusted === null) throw new RangeError("a kept show has no adjusted views");
      const byGuest = new Map<string, number[]>();
      rows.forEach((row, index) => {
        const indexes = byGuest.get(row.personId);
        if (indexes === undefined) byGuest.set(row.personId, [index]);
        else indexes.push(index);
      });
      return { fit: rows.map((row) => row.fit), fame: rows.map((row) => row.fame), adjusted, guests: [...byGuest.values()] };
    });
}

/** Per-show Spearman (H1) or partial Spearman given fame (H2), pooled with fisherPool as analyse() pools. */
export function pooledRho(samples: readonly Sample[], statistic: BootstrapStatistic): number | null {
  return fisherPool(
    samples.map((sample) => ({
      r: statistic === "spearman" ? spearman(sample.fit, sample.adjusted) : partialSpearman(sample.fit, sample.adjusted, sample.fame),
      n: sample.fit.length,
    })),
  );
}

// The order statistic at floor(p * (n - 1)), as the check was first run.
// stats.ts interpolates between neighbours instead, which can move the third
// decimal, so this check keeps its own rule.
function orderStatistic(sorted: readonly number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[index] ?? Number.NaN;
}

/**
 * One show's resample: as many guests as the show has, drawn with
 * replacement by `random`, each bringing the row indexes of all of their
 * episodes, in draw order.
 */
export function resampleGuests(guests: readonly (readonly number[])[], random: () => number): number[] {
  const picked: number[] = [];
  for (let k = 0; k < guests.length; k += 1) picked.push(...(guests[Math.floor(random() * guests.length)] ?? []));
  return picked;
}

/**
 * A 95% interval for the pooled correlation that resamples guests instead of
 * episodes: each iteration takes `resampleGuests` of every show, in show
 * order, from one seeded generator. Iterations with no pooled value are
 * skipped, and `iterations` in the result counts those kept. Defaults: 2,000
 * iterations, seed 20261024. Returns null when no iteration gave a value.
 * Throws RangeError for an iteration count outside 1 to 1,000,000 or a seed
 * mulberry32 refuses.
 */
export function guestBootstrap(
  series: readonly GuestSeries[],
  statistic: BootstrapStatistic,
  opts: { iterations?: number; seed?: number } = {},
): { low: number; high: number; iterations: number } | null {
  const iterations = opts.iterations ?? GUEST_BOOTSTRAP_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_ITERATIONS) {
    throw new RangeError(`iterations must be an integer from 1 to ${MAX_ITERATIONS}`);
  }
  const random = mulberry32(opts.seed ?? GUEST_BOOTSTRAP_SEED);
  const values: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const resampled = series.map((show) => {
      const picked = resampleGuests(show.guests, random);
      return {
        fit: picked.map((i) => show.fit[i] ?? Number.NaN),
        fame: picked.map((i) => show.fame[i] ?? Number.NaN),
        adjusted: picked.map((i) => show.adjusted[i] ?? Number.NaN),
      };
    });
    const value = pooledRho(resampled, statistic);
    if (value !== null && Number.isFinite(value)) values.push(value);
  }
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  return { low: orderStatistic(values, 0.025), high: orderStatistic(values, 0.975), iterations: values.length };
}

/**
 * The pooled correlation with one row per guest per show: that guest's fit
 * and fame, which are the same on every one of their episodes of a show, and
 * the mean adjusted views of those episodes. Returns it with the number of
 * guests pooled.
 */
export function onePerGuest(series: readonly GuestSeries[], statistic: BootstrapStatistic): { rho: number | null; guests: number } {
  const collapsed = series.map((show) => {
    const first = (values: number[]) => show.guests.map((indexes) => values[indexes[0] ?? -1] ?? Number.NaN);
    return {
      fit: first(show.fit),
      fame: first(show.fame),
      adjusted: show.guests.map((indexes) => indexes.reduce((sum, i) => sum + (show.adjusted[i] ?? Number.NaN), 0) / indexes.length),
    };
  });
  return { rho: pooledRho(collapsed, statistic), guests: collapsed.reduce((total, show) => total + show.fit.length, 0) };
}

const count = new Intl.NumberFormat("en-US");
const three = (value: number | null | undefined) => (value === null || value === undefined ? "none" : value.toFixed(3));

function issueLines(error: z.ZodError): string[] {
  return error.issues.slice(0, 5).map((issue) => `  at ${issue.path.join(".") || "(top level)"}: ${issue.message}`);
}

function readDataset(path: string): Dataset | undefined {
  let raw: unknown;
  try {
    if (statSync(path).size > MAX_DATASET_BYTES) {
      console.error(`${path} is larger than ${count.format(MAX_DATASET_BYTES)} bytes.`);
      return undefined;
    }
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(error instanceof SyntaxError ? `${path} is not valid JSON.` : `Could not read ${path}.`);
    return undefined;
  }
  const parsed = DatasetSchema.safeParse(raw);
  if (!parsed.success) {
    console.error(`${path} does not match the dataset schema:`);
    for (const line of issueLines(parsed.error)) console.error(line);
    return undefined;
  }
  return parsed.data;
}

function hypothesisLine(label: string, result: HypothesisResult): string {
  const interval = result.interval === null ? "no interval" : `95% interval ${three(result.interval.low)} to ${three(result.interval.high)}`;
  return `  ${label}: pooled rho ${three(result.pooledRho)}, ${interval}, ${result.decision}`;
}

function guestLines(series: readonly GuestSeries[]): string[] {
  return (["spearman", "partialSpearman"] as const).map((statistic) => {
    const label = statistic === "spearman" ? "H1" : "H2";
    const published = tryBootstrapPooled(
      series.map((show) => ({ x: show.fit, y: show.adjusted, z: show.fame })),
      statistic,
    );
    const guests = guestBootstrap(series, statistic);
    const collapsed = onePerGuest(series, statistic);
    return [
      `  ${label}: pooled rho ${three(pooledRho(series, statistic))}.`,
      `Episode bootstrap, as published: ${three(published?.low)} to ${three(published?.high)}.`,
      `Guest bootstrap: ${three(guests?.low)} to ${three(guests?.high)} (${count.format(guests?.iterations ?? 0)} resamples, seed ${GUEST_BOOTSTRAP_SEED}).`,
      `One row per guest: ${three(collapsed.rho)} over ${count.format(collapsed.guests)} guests.`,
    ].join(" ");
  });
}

async function main(): Promise<number> {
  let path: string | undefined;
  try {
    const { positionals } = parseArgs({ args: process.argv.slice(2), options: {}, strict: true, allowPositionals: true });
    path = positionals.length === 1 && positionals[0]?.trim() !== "" ? positionals[0] : undefined;
  } catch {
    path = undefined;
  }
  if (path === undefined) {
    console.error(USAGE);
    return 2;
  }

  const dataset = readDataset(path);
  if (dataset === undefined) return 1;

  try {
    const series = guestSeries(dataset);
    const kept = series.length;
    const guests = series.reduce((total, show) => total + show.guests.length, 0);
    const trimmed = withoutMisreadRows(dataset);
    const rerun = analyse(trimmed.dataset);
    const removed = trimmed.removed.factCheck + trimmed.removed.conanAndSona;

    console.log("Post-hoc robustness checks. Neither is part of the pre-registered result.");
    console.log(`Dataset: ${count.format(dataset.rows.length)} rows, ${kept} kept shows, ${count.format(guests)} guests counted within each show.`);
    console.log("");
    console.log("Check 1, the pre-registered analysis without misread rows:");
    console.log(
      `  Removed ${removed} rows (${trimmed.removed.factCheck} Fact Check, ${trimmed.removed.conanAndSona} Conan & Sona), ${count.format(rerun.sample.episodes)} left.`,
    );
    console.log(hypothesisLine("H1", rerun.h1));
    console.log(hypothesisLine("H2", rerun.h2));
    console.log("");
    console.log("Check 2, repeat guests:");
    for (const line of guestLines(series)) console.log(line);
    return 0;
  } catch (error) {
    console.error(error instanceof RangeError ? `The dataset is inconsistent: ${error.message}.` : "The checks stopped with an unexpected error.");
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main();
