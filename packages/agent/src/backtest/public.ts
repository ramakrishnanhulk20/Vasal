import { z } from "zod";
import { GUEST_BOOTSTRAP_SEED, guestBootstrap, guestSeries, onePerGuest, withoutMisreadRows } from "../../scripts/backtest-robustness.js";
import { analyse } from "./analyse.js";
import { IsoInstant, MIN_DURATION_SEC, WINDOW_FROM, WINDOW_TO } from "./eligibility.js";
import {
  DropCountsSchema,
  ShowOutcomeSchema,
  type BacktestResult,
  type Dataset,
  type DropCounts,
  type HypothesisResult,
  type ShowOutcome,
} from "./types.js";

/** A dataset folder is named for the UTC instant of its pull, as scripts/backtest.ts names it. */
export const DATASET_NAME = /^[0-9]{8}T[0-9]{6}Z$/;

// The order the pipeline applies these rules to an upload. "other" sums four
// rules that are spread through that order (hidden views second, unreadable
// titles fifth, name not in title seventh, no fame last), so it goes last.
export const PUBLIC_RULES = ["otherShow", "outsideWindow", "tooShort", "notOneGuest", "guestNotFound", "noFitScore", "other"] as const;
export const EXCLUSION_REASONS = ["no_podcast_match", "ambiguous_podcast", "no_channel"] as const;

export type PublicRule = (typeof PUBLIC_RULES)[number];
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

// A Record over every counter, so a counter added to DropCounts does not
// compile until it is placed. Show counters are null: those shows are listed
// under "excluded" instead.
const RULE_OF: Record<keyof DropCounts, PublicRule | null> = {
  notThisShow: "otherShow",
  hiddenViews: "other",
  notInWindow: "outsideWindow",
  tooShort: "tooShort",
  extractFailed: "other",
  noSingleGuest: "notOneGuest",
  nameNotInTitle: "other",
  guestNotResolved: "guestNotFound",
  noFitScore: "noFitScore",
  noFame: "other",
  showNoChannel: null,
  showNoPodcastMatch: null,
  showAmbiguousPodcast: null,
  showTooFewEpisodes: null,
};

// tooFewEpisodes has no public reason. Such a show also had uploads read and
// dropped, which would break the uploadsRead sum, so it is refused, not relabelled.
const REASON_OF: Record<Exclude<ShowOutcome["status"], "kept">, ExclusionReason | null> = {
  noChannel: "no_channel",
  noPodcastMatch: "no_podcast_match",
  ambiguousPodcast: "ambiguous_podcast",
  tooFewEpisodes: null,
};

const SHOW_COUNTER_OF: Record<ExclusionReason, keyof DropCounts> = {
  no_channel: "showNoChannel",
  no_podcast_match: "showNoPodcastMatch",
  ambiguous_podcast: "showAmbiguousPodcast",
};

const Count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Rho = z.number().min(-1).max(1);
const ShowName = z.string().min(1).max(300);

const StoredHypothesisSchema = z
  .object({
    pooledRho: Rho.nullable(),
    interval: z.object({ low: Rho, high: Rho, iterations: Count }).strict().nullable(),
    decision: z.enum(["supported", "not supported", "insufficient data"]),
  })
  .strict();

/** result.json as scripts/backtest.ts writes it, read back like any input. */
export const StoredResultSchema = z
  .object({
    status: z.enum(["analysed", "insufficient data"]),
    sample: z.object({ shows: Count, episodes: Count }).strict(),
    shows: z
      .array(
        z
          .object({
            name: ShowName,
            n: Count,
            cutShort: z.boolean(),
            rhoFitViews: Rho.nullable(),
            partialRhoFitViewsGivenFame: Rho.nullable(),
          })
          .strict(),
      )
      .max(100),
    h1: StoredHypothesisSchema,
    h2: StoredHypothesisSchema,
    descriptive: z.object({ medianAdjustedViewRatioTopToBottomFitQuintile: z.number().positive().nullable() }).strict(),
    drops: DropCountsSchema,
    showOutcomes: z.array(ShowOutcomeSchema).max(100),
    bootstrap: z.object({ iterations: Count, seed: Count }).strict(),
    datasetBuiltAt: IsoInstant,
    method: z.array(z.string().max(5_000)).max(100),
  })
  .strict();

const PublicHypothesisSchema = z.object({ rho: Rho, low: Rho, high: Rho, supported: z.boolean() }).strict();
const PublicIntervalSchema = z.object({ low: Rho, high: Rho }).strict();

/**
 * The whole public file, key for key. Strict objects and fixed array
 * lengths, so a key or a per-episode list that is not named here cannot be
 * written. The key order here is the order in the file.
 */
export const PublicBacktestSchema = z
  .object({
    dataset: z.string().regex(DATASET_NAME),
    datasetBuiltAt: IsoInstant,
    window: z.object({ from: z.iso.date(), to: z.iso.date() }).strict(),
    minimumMinutes: z.number().int().positive(),
    sample: z.object({ shows: Count, episodes: Count }).strict(),
    h1: PublicHypothesisSchema,
    h2: PublicHypothesisSchema,
    bootstrap: z.object({ iterations: Count, seed: Count }).strict(),
    fifths: z
      .array(z.object({ fifth: z.number().int().min(1).max(5), medianRatio: z.number().positive(), episodes: Count }).strict())
      .length(5),
    shows: z
      .array(z.object({ name: ShowName, episodes: Count, cutShort: z.boolean(), rho: Rho, rhoGivenFame: Rho }).strict())
      .max(100),
    excluded: z.array(z.object({ name: ShowName, reason: z.enum(EXCLUSION_REASONS) }).strict()).max(100),
    uploadsRead: Count,
    drops: z.array(z.object({ rule: z.enum(PUBLIC_RULES), count: Count }).strict()).length(PUBLIC_RULES.length),
    precision: z
      .object({ checked: Count, correct: Count })
      .strict()
      .refine((check) => check.correct <= check.checked, "correct cannot exceed checked"),
    sensitivity: z.object({ episodes: Count, h1: PublicHypothesisSchema, h2: PublicHypothesisSchema }).strict(),
    guestLevel: z
      .object({
        guests: Count,
        h1: PublicIntervalSchema,
        h2: PublicIntervalSchema,
        oneRowPerGuest: z.object({ h1: Rho, h2: Rho }).strict(),
        resamples: z.object({ h1: Count, h2: Count }).strict(),
        seed: Count,
      })
      .strict(),
  })
  .strict();

export type PublicBacktest = z.infer<typeof PublicBacktestSchema>;
export type PublicFifth = PublicBacktest["fifths"][number];
type PublicHypothesis = PublicBacktest["h1"];
type Statistic = "spearman" | "partialSpearman";

// stats.ts keeps its median private. This is the same rule, and the public
// script holds fifth 5 to the stored ratio bit for bit, which it can only
// match if the rule is identical.
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * The fit fifth, 1 (lowest fit) to 5, of each episode of one show, in input
 * order. It uses the grouping of medianRatioTopBottomQuintile in stats.ts:
 * episodes ordered by fit with ties kept in input order, and the bottom and
 * top fifths floor(n / 5) episodes each, never fewer than 1. The
 * pre-registration names only those two. The episodes between them are
 * split into fifths 2, 3 and 4 as evenly as possible, with any extra going
 * to the lower fifths. Returns null for fewer than 2 episodes, which that
 * ratio skips. Throws RangeError for a fit that is not a finite number.
 */
export function fitFifths(fit: readonly number[]): number[] | null {
  if (!fit.every(Number.isFinite)) throw new RangeError("fit fifths need finite numbers");
  const n = fit.length;
  if (n < 2) return null;
  const size = Math.max(1, Math.floor(n / 5));
  const middle = n - 2 * size;
  const order = fit.map((_, index) => index).sort((a, b) => fit[a]! - fit[b]! || a - b);
  const fifths = new Array<number>(n);
  order.forEach((index, position) => {
    fifths[index] = position < size ? 1 : position >= n - size ? 5 : 2 + Math.floor(((position - size) * 3) / middle);
  });
  return fifths;
}

/**
 * The descriptive ratio for every fit fifth. Each show is grouped by
 * `fitFifths`, each fifth's adjusted values are pooled across shows, and
 * fifth k's ratio is exp(median(fifth k) - median(fifth 1)), so fifth 1 is 1
 * and fifth 5 is exactly medianRatioTopBottomQuintile's value. `episodes` is
 * the size of each pooled fifth. Throws RangeError for unequal or non-finite
 * samples, or when a fifth is left with no episode.
 */
export function fifthRatios(shows: ReadonlyArray<{ fit: readonly number[]; adjusted: readonly number[] }>): PublicFifth[] {
  const pooled: number[][] = [[], [], [], [], []];
  for (const { fit, adjusted } of shows) {
    if (fit.length !== adjusted.length) throw new RangeError("fit and adjusted views must have the same length");
    if (!adjusted.every(Number.isFinite)) throw new RangeError("fit fifths need finite numbers");
    fitFifths(fit)?.forEach((fifth, index) => pooled[fifth - 1]!.push(adjusted[index]!));
  }
  if (pooled.some((values) => values.length === 0)) throw new RangeError("a fit fifth has no episode");
  const bottom = median(pooled[0]!);
  return pooled.map((values, index) => ({ fifth: index + 1, medianRatio: Math.exp(median(values) - bottom), episodes: values.length }));
}

/** The pipeline's upload counters as the public rules, in PUBLIC_RULES order. */
export function publicDrops(drops: DropCounts): Array<{ rule: PublicRule; count: number }> {
  const counts = new Map<PublicRule, number>(PUBLIC_RULES.map((rule) => [rule, 0]));
  for (const [counter, rule] of Object.entries(RULE_OF) as Array<[keyof DropCounts, PublicRule | null]>) {
    if (rule !== null) counts.set(rule, (counts.get(rule) ?? 0) + drops[counter]);
  }
  return PUBLIC_RULES.map((rule) => ({ rule, count: counts.get(rule) ?? 0 }));
}

/**
 * Every show that was not kept, in show-list order, with its public reason.
 * Throws RangeError for a show dropped for too few episodes, which has no
 * public reason.
 */
export function excludedShows(outcomes: readonly ShowOutcome[]): Array<{ name: string; reason: ExclusionReason }> {
  return outcomes.flatMap((outcome) => {
    if (outcome.status === "kept") return [];
    const reason = REASON_OF[outcome.status];
    if (reason === null) throw new RangeError("a show dropped for too few episodes has no public reason");
    return [{ name: outcome.name, reason }];
  });
}

function publicHypothesis(result: HypothesisResult): PublicHypothesis {
  if (result.pooledRho === null || result.interval === null) throw new RangeError("a hypothesis has no correlation or no interval");
  return { rho: result.pooledRho, low: result.interval.low, high: result.interval.high, supported: result.decision === "supported" };
}

export type PublicInput = {
  dataset: Dataset;
  stored: BacktestResult;
  datasetName: string;
  precision: { checked: number; correct: number };
};

/**
 * Builds the public backtest file from a stored dataset and its result.json.
 * The hypotheses, sample, bootstrap settings and fifths are recomputed from
 * the dataset with analyse() and the stats functions; the per-show values
 * are copied from `stored`; the post-hoc rerun without misread rows and the
 * repeat-guest check come from scripts/backtest-robustness.ts at its
 * published settings. Nothing per episode is returned, and the result has
 * passed PublicBacktestSchema. It does not compare the recomputed numbers
 * with `stored`; the public script does that before it writes.
 *
 * Throws RangeError when the dataset has too few kept shows for an analysed
 * result, a hypothesis or check has no value, a show was dropped for too few
 * episodes, or the excluded shows disagree with the show drop counters.
 * Throws ZodError when the output breaks PublicBacktestSchema.
 */
export function buildPublic({ dataset, stored, datasetName, precision }: PublicInput): PublicBacktest {
  const fresh = analyse(dataset);
  if (fresh.status !== "analysed") throw new RangeError("the dataset has too few kept shows for a public result");

  const excluded = excludedShows(dataset.shows);
  for (const reason of EXCLUSION_REASONS) {
    if (excluded.filter((show) => show.reason === reason).length !== dataset.drops[SHOW_COUNTER_OF[reason]]) {
      throw new RangeError("the excluded shows disagree with the show drop counters");
    }
  }

  const series = guestSeries(dataset);
  const rerun = analyse(withoutMisreadRows(dataset).dataset);
  const guestInterval = (statistic: Statistic) => {
    const interval = guestBootstrap(series, statistic);
    if (interval === null) throw new RangeError("the guest bootstrap produced no interval");
    return interval;
  };
  const oneRow = (statistic: Statistic) => {
    const { rho } = onePerGuest(series, statistic);
    if (rho === null) throw new RangeError("the one-row-per-guest check produced no correlation");
    return rho;
  };
  const guestH1 = guestInterval("spearman");
  const guestH2 = guestInterval("partialSpearman");

  return PublicBacktestSchema.parse({
    dataset: datasetName,
    datasetBuiltAt: dataset.builtAt,
    window: { from: WINDOW_FROM, to: WINDOW_TO },
    minimumMinutes: MIN_DURATION_SEC / 60,
    sample: fresh.sample,
    h1: publicHypothesis(fresh.h1),
    h2: publicHypothesis(fresh.h2),
    bootstrap: fresh.bootstrap,
    fifths: fifthRatios(series),
    shows: stored.shows.map((show) => {
      if (show.rhoFitViews === null || show.partialRhoFitViewsGivenFame === null) throw new RangeError("a kept show has no correlation");
      return { name: show.name, episodes: show.n, cutShort: show.cutShort, rho: show.rhoFitViews, rhoGivenFame: show.partialRhoFitViewsGivenFame };
    }),
    excluded,
    uploadsRead: dataset.shows.filter((show) => show.status === "kept").reduce((total, show) => total + show.uploadsRead, 0),
    drops: publicDrops(dataset.drops),
    precision,
    sensitivity: { episodes: rerun.sample.episodes, h1: publicHypothesis(rerun.h1), h2: publicHypothesis(rerun.h2) },
    guestLevel: {
      guests: series.reduce((total, show) => total + show.guests.length, 0),
      h1: { low: guestH1.low, high: guestH1.high },
      h2: { low: guestH2.low, high: guestH2.high },
      oneRowPerGuest: { h1: oneRow("spearman"), h2: oneRow("partialSpearman") },
      // The resamples kept, which can be fewer than asked for when one gives no value.
      resamples: { h1: guestH1.iterations, h2: guestH2.iterations },
      seed: GUEST_BOOTSTRAP_SEED,
    },
  });
}

/**
 * Every place `output` breaks the aggregates-only rule against the dataset
 * it came from, as "path: kind" lines that never quote the offending value.
 * A string must be a show name from the dataset, the build time, a window
 * date, a fixed label, or the folder name at "dataset". A number that is not
 * whole must not equal any stored fit or fame. No array may be longer than
 * the show list or the rule list, so no per-episode list fits.
 *
 * Not covered: whole numbers are counts here, so they are not compared with
 * view counts, which would match by chance. A value that has been
 * transformed (rounded, scaled) is not recognised; the schema's fixed keys
 * are what keep such values out.
 */
export function leakFindings(output: unknown, dataset: Dataset): string[] {
  const strings = new Set<string>([
    ...dataset.shows.map((show) => show.name),
    dataset.builtAt,
    WINDOW_FROM,
    WINDOW_TO,
    ...PUBLIC_RULES,
    ...EXCLUSION_REASONS,
  ]);
  const raw = new Set<number>(dataset.rows.flatMap((row) => [row.fit, row.fame]));
  const longest = Math.max(dataset.shows.length, PUBLIC_RULES.length);
  const findings: string[] = [];

  const walk = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      if (!(strings.has(value) || (path === "dataset" && DATASET_NAME.test(value)))) {
        findings.push(`${path}: a string that is not a show name, a fixed label or the dataset's own name or date`);
      }
    } else if (typeof value === "number") {
      if (!Number.isInteger(value) && raw.has(value)) findings.push(`${path}: a stored fit or fame value`);
    } else if (Array.isArray(value)) {
      if (value.length > longest) findings.push(`${path}: a list longer than the show list, which only a per-episode list would be`);
      value.forEach((item, index) => walk(item, `${path}.${index}`));
    } else if (typeof value === "object" && value !== null) {
      for (const [key, item] of Object.entries(value)) walk(item, path === "" ? key : `${path}.${key}`);
    } else if (typeof value !== "boolean") {
      findings.push(`${path}: a value that is not a string, number, boolean, list or object`);
    }
  };
  walk(output, "");
  return findings;
}

/** The file's exact text: two-space JSON and a trailing newline. */
export function publicJson(output: PublicBacktest): string {
  return `${JSON.stringify(output, null, 2)}\n`;
}
