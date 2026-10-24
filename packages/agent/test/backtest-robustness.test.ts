// Covers the pure parts of scripts/backtest-robustness.ts on synthetic data:
// which rows the post-hoc rerun removes, how rows group into guests, the
// guest-level bootstrap and the one-row-per-guest pooling. It does not cover
// main() (argument handling, file reading, the printed text), or whether
// these are the right checks to run. The real dataset's numbers come from
// running the script on it.
import { describe, expect, it } from "vitest";
import { analyse } from "../src/backtest/analyse.js";
import { mulberry32 } from "../src/backtest/random.js";
import { olsResiduals, tryBootstrapPooled } from "../src/backtest/stats.js";
import type { Dataset, DatasetRow, DropCounts, ShowOutcome } from "../src/backtest/types.js";
import {
  GUEST_BOOTSTRAP_ITERATIONS,
  guestBootstrap,
  guestSeries,
  onePerGuest,
  pooledRho,
  resampleGuests,
  withoutMisreadRows,
  type GuestSeries,
} from "../scripts/backtest-robustness.js";

const NOW = new Date("2026-10-19T00:00:00.000Z");
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

type ShowSpec = { guests: number; episodesPerGuest?: number; titleOf?: (row: number) => string | undefined };

// Fit drives views, so every show leans positive. Person ids repeat across
// shows on purpose: the same person on two shows is still two guests.
function synthetic(specs: ShowSpec[], seed = 5): Dataset {
  const random = mulberry32(seed);
  const shows: ShowOutcome[] = [];
  const rows: DatasetRow[] = [];
  specs.forEach((spec, s) => {
    const name = `Synthetic Show ${s}`;
    let n = 0;
    for (let g = 0; g < spec.guests; g += 1) {
      const fit = random();
      const fame = random();
      for (let e = 0; e < (spec.episodesPerGuest ?? 1); e += 1) {
        const ageDays = 80 + Math.floor(random() * 600);
        rows.push({
          showName: name,
          videoId: `v${s}${String(n).padStart(9, "0")}`,
          title: spec.titleOf?.(n) ?? `Guest ${g} | ${name}`,
          publishedAt: new Date(NOW.getTime() - ageDays * DAY_MS).toISOString(),
          ageDays,
          views: Math.round(Math.exp(10 + 3 * fit + 0.5 * Math.log(ageDays) + 0.6 * (random() - 0.5))),
          guestName: `Guest ${g}`,
          personId: `synthetic-person-${g}`,
          fit,
          fame,
        });
        n += 1;
      }
    }
    shows.push({
      name,
      youtubeChannelId: `UC${`s${s}`.padEnd(22, "x")}`,
      podcastId: `synthetic-podcast-${s}`,
      status: "kept",
      uploadsRead: n,
      eligibleEpisodes: n,
      resolvedGuests: n,
      rows: n,
      cutShort: false,
    });
  });
  return { builtAt: NOW.toISOString(), shows, rows, drops: { ...NO_DROPS } };
}

const sixShows = (episodesPerGuest = 1) => synthetic(Array.from({ length: 6 }, () => ({ guests: 40, episodesPerGuest })));

describe("withoutMisreadRows", () => {
  it("removes Fact Check and Conan & Sona rows in any case, keeps the rest, and resets each show's row count so the analysis accepts it", () => {
    const misread: Record<number, string> = { 0: "Fact Check: Guest 0", 1: "FACT CHECK with Guest 1", 2: "Guest 2 checks the facts" };
    const specials: Record<number, string> = { 0: "Conan & Sona In Morocco", 1: "Conan and Sona Visit Italy" };
    const dataset = synthetic([
      { guests: 40, titleOf: (row) => misread[row] },
      { guests: 40, titleOf: (row) => specials[row] },
      ...Array.from({ length: 4 }, () => ({ guests: 40 })),
    ]);

    const { dataset: trimmed, removed } = withoutMisreadRows(dataset);

    expect(removed).toEqual({ factCheck: 2, conanAndSona: 2 });
    expect(trimmed.rows).toHaveLength(236);
    expect(trimmed.rows.some((row) => row.title === "Guest 2 checks the facts")).toBe(true);
    expect(trimmed.shows.map((show) => show.rows)).toEqual([38, 38, 40, 40, 40, 40]);
    expect(analyse(trimmed).sample).toEqual({ shows: 6, episodes: 236 });
    expect(dataset.rows).toHaveLength(240);
    expect(dataset.shows[0]?.rows).toBe(40);
  });

  it("leaves a show that falls under 30 rows in place, so the analysis refuses the rerun", () => {
    const dataset = synthetic([{ guests: 31, titleOf: (row) => (row < 2 ? "Fact Check" : undefined) }]);
    const { dataset: trimmed } = withoutMisreadRows(dataset);
    expect(trimmed.shows[0]?.rows).toBe(29);
    expect(() => analyse(trimmed)).toThrow(RangeError);
  });
});

describe("guestSeries", () => {
  it("groups each kept show's rows by guest in order of first appearance, skips shows not kept, and counts a guest on two shows twice", () => {
    const dataset = synthetic([{ guests: 3, episodesPerGuest: 2 }, { guests: 4 }]);
    const firstRow = dataset.rows[0];
    if (firstRow === undefined) throw new Error("no rows");
    // A third episode of guest 0, after the show's other rows, still joins that guest's group.
    dataset.rows.splice(6, 0, { ...firstRow, videoId: "v0999999999" });
    dataset.shows[0] = { ...dataset.shows[0]!, rows: 7 };
    dataset.shows.push({ ...dataset.shows[1]!, name: "Not Kept", status: "noPodcastMatch", rows: 0 });

    const series = guestSeries(dataset);

    expect(series.map((show) => show.guests)).toEqual([[[0, 1, 6], [2, 3], [4, 5]], [[0], [1], [2], [3]]]);
    const showRows = dataset.rows.filter((row) => row.showName === "Synthetic Show 1");
    expect(series[1]?.adjusted).toEqual(olsResiduals(showRows.map((row) => Math.log(row.views + 1)), showRows.map((row) => Math.log(row.ageDays))));
    expect(series[1]?.fit).toEqual(showRows.map((row) => row.fit));
    expect(series.reduce((total, show) => total + show.guests.length, 0)).toBe(7);
  });
});

describe("guestBootstrap", () => {
  it("draws whole guests: every drawn guest brings all of their episodes", () => {
    const draws = [0.9, 0, 0.5];
    const random = () => draws.shift() ?? 0;
    expect(resampleGuests([[0, 1, 2], [3], [4, 5]], random)).toEqual([4, 5, 0, 1, 2, 3]);
  });

  it("with one episode per guest, draws exactly what the published episode bootstrap draws", () => {
    // With 41 iterations both percentile rules land on whole positions (1
    // and 39), so the two intervals must match exactly.
    const series = guestSeries(sixShows());
    for (const statistic of ["spearman", "partialSpearman"] as const) {
      const episodes = tryBootstrapPooled(
        series.map((show) => ({ x: show.fit, y: show.adjusted, z: show.fame })),
        statistic,
        { iterations: 41, seed: 7 },
      );
      expect(guestBootstrap(series, statistic, { iterations: 41, seed: 7 }), statistic).toEqual(episodes);
    }
  });

  it("is repeatable, runs 2,000 resamples by default, and refuses an iteration count outside 1 to 1,000,000", () => {
    const series = guestSeries(sixShows(2));
    const once = guestBootstrap(series, "spearman", { iterations: 50, seed: 3 });
    expect(guestBootstrap(series, "spearman", { iterations: 50, seed: 3 })).toEqual(once);
    expect(once?.low).toBeGreaterThan(0);
    expect(guestBootstrap(series, "partialSpearman")?.iterations).toBe(GUEST_BOOTSTRAP_ITERATIONS);
    for (const iterations of [0, 1.5, 1_000_001]) {
      expect(() => guestBootstrap(series, "spearman", { iterations }), String(iterations)).toThrow(RangeError);
    }
  });
});

describe("onePerGuest", () => {
  it("pools one row per guest with the mean of their adjusted views", () => {
    // Episode by episode the link is weak (about 0.2), but each guest's mean
    // rises with fit, so the collapsed correlation is perfect, pooled just
    // inside 1.
    const show: GuestSeries = {
      fit: [0.1, 0.1, 0.2, 0.2, 0.3, 0.3, 0.4, 0.4],
      fame: [0.5, 0.5, 0.2, 0.2, 0.9, 0.9, 0.1, 0.1],
      adjusted: [5, -5, -9, 11, 12, -8, -7, 13],
      guests: [[0, 1], [2, 3], [4, 5], [6, 7]],
    };
    const collapsed = onePerGuest([show], "spearman");
    expect(collapsed.guests).toBe(4);
    expect(collapsed.rho).toBeCloseTo(1, 5);
    expect(pooledRho([show], "spearman")).toBeLessThan(0.5);
  });

  it("matches the episode-level value when every guest has one episode", () => {
    const series = guestSeries(sixShows());
    for (const statistic of ["spearman", "partialSpearman"] as const) {
      expect(onePerGuest(series, statistic)).toEqual({ rho: pooledRho(series, statistic), guests: 240 });
    }
  });
});
