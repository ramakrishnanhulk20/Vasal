import { MIN_DURATION_SEC, WINDOW_FROM, WINDOW_TO } from "./eligibility.js";
import { FIT_BATCH_SIZE, MAX_UPLOADS_PER_CHANNEL, MIN_EPISODES_PER_SHOW } from "./pipeline.js";
import {
  BOOTSTRAP_ITERATIONS,
  BOOTSTRAP_SEED,
  fisherPool,
  medianRatioTopBottomQuintile,
  olsResiduals,
  partialSpearman,
  spearman,
  tryBootstrapPooled,
  type BootstrapStatistic,
} from "./stats.js";
import {
  DatasetSchema,
  type BacktestResult,
  type Dataset,
  type DatasetRow,
  type HypothesisResult,
  type ShowResult,
} from "./types.js";

export const MIN_SHOWS = 6;

const METHOD: readonly string[] = [
  "Fixed in advance in docs/backtest-preregistration.md, before any Qloo data existed.",
  `Episodes: published from ${WINDOW_FROM} to ${WINDOW_TO} (UTC), at least ${MIN_DURATION_SEC / 60} minutes long, with exactly one guest named in the title. Uploads are read only from each show's pinned YouTube channel, at most the ${MAX_UPLOADS_PER_CHANNEL.toLocaleString("en-US")} most recent; a show whose capped list never reaches back before the window is marked cut short and kept. On a channel shared with other shows, an upload counts only if its normalised title contains the show's normalised name.`,
  "Podcast: an exact normalised name match wins. Only when there is none do names where one is the other followed by more words count. More than one podcast in the winning tier excludes the show.",
  "Guests: a language model reads each title and names the guest. A name is kept only if it appears in that title after the shared normaliser (NFKC, invisible characters removed, typographic quote marks folded to ASCII, lower case, whitespace collapsed).",
  "Resolution: each name is searched in Qloo as a person, and the top result is kept only if its normalised name equals the extracted name.",
  `Fit: Qloo's affinity score for the guest, with the show's podcast entity as the signal, asked for in batches of at most ${FIT_BATCH_SIZE}. Fame: the guest's Qloo popularity percentile from the same response; a guest with no fame is dropped, because H2 needs it.`,
  "Adjusted views: within each show, the residual of an ordinary least squares fit of log(views + 1) on log(days since publication).",
  "H1: the Spearman rank correlation of fit and adjusted views within each show, pooled across shows with the Fisher z transform, each show weighted by n - 3.",
  "H2: the same, using a partial Spearman correlation of fit and adjusted views that controls for fame.",
  `Intervals: ${BOOTSTRAP_ITERATIONS.toLocaleString("en-US")} bootstrap resamples of episodes within each show, seed ${BOOTSTRAP_SEED}; the 95% interval is the 2.5th and 97.5th percentiles of the pooled correlation.`,
  "Descriptive: the ratio of median adjusted views between the top and bottom fifths of fit, with the fifths taken within each show and then pooled.",
  "Decision: a hypothesis is supported only if its pooled correlation is above 0 and the lower end of its 95% interval is above 0. Otherwise it is not supported.",
  `Sample: a show is kept only with at least ${MIN_EPISODES_PER_SHOW} episodes that pass every rule. With fewer than ${MIN_SHOWS} shows kept, the result is insufficient data and no correlation is claimed.`,
];

type ShowSeries = { name: string; n: number; cutShort: boolean; fit: number[]; fame: number[]; adjusted: number[] | null };

const insufficient = (): HypothesisResult => ({ pooledRho: null, interval: null, decision: "insufficient data" });

function hypothesis(series: ShowSeries[], statistic: BootstrapStatistic): HypothesisResult {
  const usable = series.filter((show): show is ShowSeries & { adjusted: number[] } => show.adjusted !== null);
  const perShow = series.map((show) => ({ r: perShowRho(show, statistic), n: show.n }));
  const pooledRho = fisherPool(perShow);
  const interval =
    pooledRho === null
      ? null
      : tryBootstrapPooled(
          usable.map((show) => ({ x: show.fit, y: show.adjusted, z: show.fame })),
          statistic,
        );
  const supported = pooledRho !== null && pooledRho > 0 && interval !== null && interval.low > 0;
  return { pooledRho, interval, decision: supported ? "supported" : "not supported" };
}

function perShowRho(show: ShowSeries, statistic: BootstrapStatistic): number | null {
  if (show.adjusted === null) return null;
  return statistic === "spearman" ? spearman(show.fit, show.adjusted) : partialSpearman(show.fit, show.adjusted, show.fame);
}

/**
 * Recomputes every number of the backtest from a stored dataset (threat
 * model C9.3): per-show n, cut-short flag and correlations, the pooled H1 and H2
 * correlations with their bootstrap intervals and decisions, the
 * descriptive top-to-bottom fifth ratio, the drop counts and the method
 * text. With fewer than 6 kept shows every hypothesis is "insufficient
 * data" and no correlation or ratio is reported. It reads no clock and no
 * random state beyond the fixed seed, so the same dataset always gives
 * byte-identical JSON.
 *
 * Throws a ZodError when the dataset does not match its schema, and
 * RangeError when it breaks the pipeline's own rules: a kept show listed
 * twice, a row for a show that was not kept, a kept show with fewer than 30
 * rows, or a row count that differs from the show's recorded count.
 */
export function analyse(dataset: Dataset): BacktestResult {
  const data = DatasetSchema.parse(dataset);
  const kept = data.shows.filter((show) => show.status === "kept");
  const rowsByShow = new Map<string, DatasetRow[]>(kept.map((show) => [show.name, []]));
  if (rowsByShow.size !== kept.length) throw new RangeError("the dataset lists a kept show twice");
  for (const row of data.rows) {
    const rows = rowsByShow.get(row.showName);
    if (rows === undefined) throw new RangeError("the dataset has a row for a show that was not kept");
    rows.push(row);
  }

  const series: ShowSeries[] = kept.map((show) => {
    const rows = rowsByShow.get(show.name) ?? [];
    if (rows.length < MIN_EPISODES_PER_SHOW || rows.length !== show.rows) {
      throw new RangeError("the dataset breaks the inclusion rule for a kept show");
    }
    return {
      name: show.name,
      n: rows.length,
      cutShort: show.cutShort,
      fit: rows.map((row) => row.fit),
      fame: rows.map((row) => row.fame),
      adjusted: olsResiduals(
        rows.map((row) => Math.log(row.views + 1)),
        rows.map((row) => Math.log(row.ageDays)),
      ),
    };
  });

  const enough = series.length >= MIN_SHOWS;
  const shows: ShowResult[] = series.map((show) => ({
    name: show.name,
    n: show.n,
    cutShort: show.cutShort,
    rhoFitViews: enough ? perShowRho(show, "spearman") : null,
    partialRhoFitViewsGivenFame: enough ? perShowRho(show, "partialSpearman") : null,
  }));
  const usable = series.flatMap((show) => (show.adjusted === null ? [] : [{ fit: show.fit, adjusted: show.adjusted }]));

  return {
    status: enough ? "analysed" : "insufficient data",
    sample: { shows: series.length, episodes: data.rows.length },
    shows,
    h1: enough ? hypothesis(series, "spearman") : insufficient(),
    h2: enough ? hypothesis(series, "partialSpearman") : insufficient(),
    descriptive: { medianAdjustedViewRatioTopToBottomFitQuintile: enough ? medianRatioTopBottomQuintile(usable) : null },
    drops: data.drops,
    showOutcomes: data.shows,
    bootstrap: { iterations: BOOTSTRAP_ITERATIONS, seed: BOOTSTRAP_SEED },
    datasetBuiltAt: data.builtAt,
    method: [...METHOD],
  };
}
