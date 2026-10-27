// Covers src/backtest/public.ts on synthetic data: the fit fifths and their
// ratios, the public drop rules and exclusions, how the builder takes the
// post-hoc checks from the robustness module, and that the file holds
// aggregates only. It does not cover scripts/backtest-public.ts (arguments,
// file reading, the self-check against result.json and the published
// values), which is proven by running it on the stored dataset, or whether
// these are the right numbers for the proof page.
import { beforeAll, describe, expect, it } from "vitest";
import { GUEST_BOOTSTRAP_SEED, guestBootstrap, guestSeries, onePerGuest, withoutMisreadRows } from "../scripts/backtest-robustness.js";
import { analyse } from "../src/backtest/analyse.js";
import {
  buildPublic,
  excludedShows,
  fifthRatios,
  fitFifths,
  leakFindings,
  publicDrops,
  publicJson,
  type PublicBacktest,
} from "../src/backtest/public.js";
import { mulberry32 } from "../src/backtest/random.js";
import { medianRatioTopBottomQuintile } from "../src/backtest/stats.js";
import type { BacktestResult, Dataset, DatasetRow, DropCounts, ShowOutcome } from "../src/backtest/types.js";

const BUILT_AT = "2026-10-19T00:00:00.000Z";
const DAY_MS = 86_400_000;
const NO_DROPS: DropCounts = {
  notThisShow: 0,
  notInWindow: 0,
  tooShort: 0,
  hiddenViews: 0,
  extractFailed: 0,
  noSingleGuest: 0,
  nameNotInTitle: 0,
  guestNotResolved: 0,
  noFitScore: 0,
  noFame: 0,
  showNoChannel: 0,
  showNoPodcastMatch: 0,
  showAmbiguousPodcast: 0,
  showTooFewEpisodes: 0,
};

type ShowSpec = { guests: number; episodesPerGuest: number; titleOf?: (row: number, guest: string) => string | undefined };

// Six kept shows of 40 rows, one with every guest on twice, three shows
// excluded at the show stage, and 10 dropped uploads per kept show. Show 1
// has three Fact Check titles and show 2 one Conan & Sona special.
function fixture(): Dataset {
  const random = mulberry32(11);
  const specs: ShowSpec[] = [
    { guests: 20, episodesPerGuest: 2 },
    { guests: 40, episodesPerGuest: 1, titleOf: (row, guest) => (row < 3 ? `Fact Check: ${guest}` : undefined) },
    { guests: 40, episodesPerGuest: 1, titleOf: (row, guest) => (row === 0 ? `Conan & Sona in Lisbon with ${guest}` : undefined) },
    ...Array.from({ length: 3 }, () => ({ guests: 40, episodesPerGuest: 1 })),
  ];
  const shows: ShowOutcome[] = [];
  const rows: DatasetRow[] = [];
  specs.forEach((spec, s) => {
    const name = `Fixture Show ${s}`;
    let n = 0;
    for (let g = 0; g < spec.guests; g += 1) {
      const guestName = `Fixture Guest ${s}-${g}`;
      const fit = random();
      const fame = random();
      for (let e = 0; e < spec.episodesPerGuest; e += 1) {
        const ageDays = 80 + Math.floor(random() * 600);
        rows.push({
          showName: name,
          videoId: `f${s}${String(n).padStart(9, "0")}`,
          title: spec.titleOf?.(n, guestName) ?? `Episode ${n}: ${guestName}`,
          publishedAt: new Date(Date.parse(BUILT_AT) - ageDays * DAY_MS).toISOString(),
          ageDays,
          views: Math.round(Math.exp(10 + 3 * fit + 0.5 * Math.log(ageDays) + 0.6 * (random() - 0.5))),
          guestName,
          personId: `fixture-person-${s}-${g}`,
          fit,
          fame,
        });
        n += 1;
      }
    }
    shows.push({
      name,
      youtubeChannelId: `UC${`f${s}`.padEnd(22, "x")}`,
      podcastId: `fixture-podcast-${s}`,
      status: "kept",
      uploadsRead: n + 10,
      eligibleEpisodes: n,
      resolvedGuests: n,
      rows: n,
      cutShort: s === 3,
    });
  });
  const dropped = (name: string, status: ShowOutcome["status"], channel: string | null): ShowOutcome => ({
    name,
    youtubeChannelId: channel,
    podcastId: null,
    status,
    uploadsRead: 0,
    eligibleEpisodes: 0,
    resolvedGuests: 0,
    rows: 0,
    cutShort: false,
  });
  shows.splice(2, 0, dropped("Fixture No Match", "noPodcastMatch", `UC${"nm".padEnd(22, "x")}`));
  shows.push(dropped("Fixture Two Matches", "ambiguousPodcast", `UC${"tm".padEnd(22, "x")}`), dropped("Fixture No Channel", "noChannel", null));
  const drops = { ...NO_DROPS, notThisShow: 25, tooShort: 35, showNoChannel: 1, showNoPodcastMatch: 1, showAmbiguousPodcast: 1 };
  return { builtAt: BUILT_AT, shows, rows, drops };
}

const PRECISION = { checked: 50, correct: 44 };
let dataset: Dataset;
let stored: BacktestResult;
let built: PublicBacktest;

beforeAll(() => {
  dataset = fixture();
  stored = analyse(dataset);
  built = buildPublic({ dataset, stored, datasetName: "20261019T000000Z", precision: PRECISION });
}, 60_000);

describe("fitFifths", () => {
  it("groups a show as the descriptive ratio does: ties in input order, floor(n / 5) at each end, the middle split evenly", () => {
    // Sorted: 0.1 0.2 | 0.3 0.4 0.5(i0) | 0.5(i2) 0.5(i5) 0.5(i8) | 0.6 0.7 | 0.8 0.9. The four tied
    // 0.5s straddle fifths 2 and 3 in input order, and the middle 8 split 3, 3, 2.
    const fit = [0.5, 0.1, 0.5, 0.9, 0.3, 0.5, 0.7, 0.2, 0.5, 0.8, 0.4, 0.6];
    expect(fitFifths(fit)).toEqual([2, 1, 3, 5, 2, 3, 4, 1, 3, 5, 2, 4]);
    expect(fitFifths([0.9, 0.1])).toEqual([5, 1]);
    expect(fitFifths([0.4])).toBeNull();
    expect(() => fitFifths([0.1, Number.NaN, 0.3])).toThrow(RangeError);
  });
});

describe("fifthRatios", () => {
  it("pools each fifth across shows: fifth 1 is 1, fifth 5 is exactly the descriptive ratio, and the sizes add up", () => {
    const evenly = { fit: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], adjusted: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18] };
    expect(fifthRatios([evenly])).toEqual([
      { fifth: 1, medianRatio: 1, episodes: 2 },
      { fifth: 2, medianRatio: Math.exp(4), episodes: 2 },
      { fifth: 3, medianRatio: Math.exp(8), episodes: 2 },
      { fifth: 4, medianRatio: Math.exp(12), episodes: 2 },
      { fifth: 5, medianRatio: Math.exp(16), episodes: 2 },
    ]);

    const random = mulberry32(3);
    const shows = [12, 31].map((n) => {
      const fit = Array.from({ length: n }, () => Math.round(random() * 8) / 8);
      return { fit, adjusted: fit.map((value) => value + random() - 0.5) };
    });
    const ratios = fifthRatios(shows);
    // 12 splits 2, 3, 3, 2, 2 and 31 splits 6, 7, 6, 6, 6.
    expect(ratios.map((fifth) => fifth.episodes)).toEqual([8, 10, 9, 8, 8]);
    expect(ratios[0]?.medianRatio).toBe(1);
    expect(ratios[4]?.medianRatio).toBe(medianRatioTopBottomQuintile(shows));
    expect(() => fifthRatios([{ fit: [1, 2], adjusted: [0, 1] }])).toThrow(RangeError);
  });
});

describe("drops and exclusions", () => {
  it("lists the upload drops in the pipeline's order with the scattered rules summed last, and names each excluded show", () => {
    const counts: DropCounts = {
      notThisShow: 1,
      hiddenViews: 2,
      notInWindow: 3,
      tooShort: 4,
      extractFailed: 5,
      noSingleGuest: 6,
      nameNotInTitle: 7,
      guestNotResolved: 8,
      noFitScore: 9,
      noFame: 10,
      showNoChannel: 100,
      showNoPodcastMatch: 100,
      showAmbiguousPodcast: 100,
      showTooFewEpisodes: 100,
    };
    expect(publicDrops(counts)).toEqual([
      { rule: "otherShow", count: 1 },
      { rule: "outsideWindow", count: 3 },
      { rule: "tooShort", count: 4 },
      { rule: "notOneGuest", count: 6 },
      { rule: "guestNotFound", count: 8 },
      { rule: "noFitScore", count: 9 },
      { rule: "other", count: 24 },
    ]);

    const shows = fixture().shows;
    expect(excludedShows(shows)).toEqual([
      { name: "Fixture No Match", reason: "no_podcast_match" },
      { name: "Fixture Two Matches", reason: "ambiguous_podcast" },
      { name: "Fixture No Channel", reason: "no_channel" },
    ]);
    expect(() => excludedShows([{ ...shows[0]!, status: "tooFewEpisodes" }])).toThrow(RangeError);
  });
});

describe("buildPublic", () => {
  it("recomputes the headline numbers from the dataset and copies each show's values from the stored result", () => {
    expect(built.dataset).toBe("20261019T000000Z");
    expect(built.datasetBuiltAt).toBe(BUILT_AT);
    expect(built.window).toEqual({ from: "2024-10-01", to: "2026-07-31" });
    expect(built.minimumMinutes).toBe(20);
    expect(built.sample).toEqual({ shows: 6, episodes: 240 });
    expect(built.h1).toEqual({
      rho: stored.h1.pooledRho,
      low: stored.h1.interval?.low,
      high: stored.h1.interval?.high,
      supported: stored.h1.decision === "supported",
    });
    expect(built.bootstrap).toEqual({ iterations: 10_000, seed: 20_261_019 });
    expect(built.fifths[4]?.medianRatio).toBe(stored.descriptive.medianAdjustedViewRatioTopToBottomFitQuintile);
    expect(built.fifths.reduce((total, fifth) => total + fifth.episodes, 0)).toBe(240);
    expect(built.shows).toEqual(
      stored.shows.map((show) => ({
        name: show.name,
        episodes: show.n,
        cutShort: show.cutShort,
        rho: show.rhoFitViews,
        rhoGivenFame: show.partialRhoFitViewsGivenFame,
      })),
    );
    expect(built.uploadsRead).toBe(300);
    expect(built.uploadsRead - built.drops.reduce((total, drop) => total + drop.count, 0)).toBe(built.sample.episodes);
    expect(built.precision).toEqual(PRECISION);
  });

  it("takes the rerun without misread titles and the repeat-guest check from the committed robustness module", () => {
    const rerun = analyse(withoutMisreadRows(dataset).dataset);
    const asPublic = (h: BacktestResult["h1"]) => ({ rho: h.pooledRho, low: h.interval?.low, high: h.interval?.high, supported: h.decision === "supported" });
    expect(built.sensitivity).toEqual({ episodes: 236, h1: asPublic(rerun.h1), h2: asPublic(rerun.h2) });
    expect(built.sensitivity.h1.rho).not.toBe(built.h1.rho);

    const series = guestSeries(dataset);
    const interval = (statistic: "spearman" | "partialSpearman") => {
      const found = guestBootstrap(series, statistic);
      return { low: found?.low, high: found?.high };
    };
    expect(built.guestLevel).toEqual({
      guests: 220,
      h1: interval("spearman"),
      h2: interval("partialSpearman"),
      oneRowPerGuest: { h1: onePerGuest(series, "spearman").rho, h2: onePerGuest(series, "partialSpearman").rho },
      resamples: { h1: guestBootstrap(series, "spearman")!.iterations, h2: guestBootstrap(series, "partialSpearman")!.iterations },
      seed: GUEST_BOOTSTRAP_SEED,
    });
  });

  it("holds aggregates only: exactly the whitelisted keys, no per-episode list, and no name, title, id, date or raw score", () => {
    const leafPaths = (value: unknown, path: string): string[] => {
      if (Array.isArray(value)) return [...new Set(value.flatMap((item) => leafPaths(item, `${path}[]`)))];
      if (typeof value === "object" && value !== null) {
        return Object.entries(value).flatMap(([key, item]) => leafPaths(item, path === "" ? key : `${path}.${key}`));
      }
      return [path];
    };
    const hypothesis = (prefix: string) => ["rho", "low", "high", "supported"].map((key) => `${prefix}.${key}`);
    expect(leafPaths(built, "")).toEqual([
      "dataset",
      "datasetBuiltAt",
      "window.from",
      "window.to",
      "minimumMinutes",
      "sample.shows",
      "sample.episodes",
      ...hypothesis("h1"),
      ...hypothesis("h2"),
      "bootstrap.iterations",
      "bootstrap.seed",
      "fifths[].fifth",
      "fifths[].medianRatio",
      "fifths[].episodes",
      "shows[].name",
      "shows[].episodes",
      "shows[].cutShort",
      "shows[].rho",
      "shows[].rhoGivenFame",
      "excluded[].name",
      "excluded[].reason",
      "uploadsRead",
      "drops[].rule",
      "drops[].count",
      "precision.checked",
      "precision.correct",
      "sensitivity.episodes",
      ...hypothesis("sensitivity.h1"),
      ...hypothesis("sensitivity.h2"),
      "guestLevel.guests",
      "guestLevel.h1.low",
      "guestLevel.h1.high",
      "guestLevel.h2.low",
      "guestLevel.h2.high",
      "guestLevel.oneRowPerGuest.h1",
      "guestLevel.oneRowPerGuest.h2",
      "guestLevel.resamples.h1",
      "guestLevel.resamples.h2",
      "guestLevel.seed",
    ]);

    const lists: Array<[string, number]> = [];
    const numbers: number[] = [];
    const collect = (value: unknown, path: string): void => {
      if (typeof value === "number") numbers.push(value);
      if (Array.isArray(value)) lists.push([path, value.length]);
      if (typeof value === "object" && value !== null) for (const [key, item] of Object.entries(value)) collect(item, key);
    };
    collect(built, "");
    expect(lists).toEqual([
      ["fifths", 5],
      ["shows", 6],
      ["excluded", 3],
      ["drops", 7],
    ]);
    const rawValues = new Set(dataset.rows.flatMap((row) => [row.fit, row.fame, row.views]));
    expect(numbers.filter((value) => rawValues.has(value))).toEqual([]);

    const json = publicJson(built);
    expect(json.startsWith('{\n  "dataset": "20261019T000000Z",\n')).toBe(true);
    expect(json.endsWith("}\n")).toBe(true);
    expect(JSON.parse(json)).toEqual(built);
    const secrets = [
      ...dataset.rows.flatMap((row) => [row.guestName, row.title, row.videoId, row.personId, row.publishedAt]),
      ...dataset.shows.flatMap((show) => [show.youtubeChannelId, show.podcastId].filter((id) => id !== null)),
    ];
    expect(secrets.length).toBeGreaterThan(1_000);
    expect(secrets.filter((secret) => json.includes(secret))).toEqual([]);

    expect(leakFindings(built, dataset)).toEqual([]);
    const firstRow = dataset.rows[0]!;
    expect(leakFindings({ ...built, shows: [{ ...built.shows[0]!, name: firstRow.guestName }] }, dataset)).toEqual([
      "shows.0.name: a string that is not a show name, a fixed label or the dataset's own name or date",
    ]);
    const perEpisode = leakFindings({ ...built, points: dataset.rows.map((row) => ({ fit: row.fit })) }, dataset);
    expect(perEpisode[0]).toBe("points: a list longer than the show list, which only a per-episode list would be");
    expect(perEpisode).toContain("points.0.fit: a stored fit or fame value");
  });
});
