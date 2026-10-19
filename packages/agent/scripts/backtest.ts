// The offline backtest: does Qloo guest fit predict YouTube views? The
// method is fixed in docs/backtest-preregistration.md. A dry run checks the
// pinned show list and prints the plan with no network and no keys;
// --analyse recomputes every published number from a stored dataset.
//
// Usage: npx tsx scripts/backtest.ts --dry-run | --analyse <dataset.json>
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { analyse, MIN_SHOWS } from "../src/backtest/analyse.js";
import { MIN_DURATION_SEC, WINDOW_FROM, WINDOW_TO } from "../src/backtest/eligibility.js";
import { FIT_BATCH_SIZE, MAX_UPLOADS_PER_CHANNEL, MIN_EPISODES_PER_SHOW } from "../src/backtest/pipeline.js";
import { BOOTSTRAP_ITERATIONS, BOOTSTRAP_SEED } from "../src/backtest/stats.js";
import { DatasetSchema, ShowListSchema, type ShowConfig } from "../src/backtest/types.js";

const SHOWS_FILE = fileURLToPath(new URL("../../../docs/backtest-shows.json", import.meta.url));
const USAGE = "Usage: npx tsx scripts/backtest.ts --dry-run | --analyse <dataset.json>";
const LIVE_REFUSAL =
  "The live backtest needs QLOO_API_KEY, YOUTUBE_API_KEY and ANTHROPIC_API_KEY, and is wired in a later step.";

// The YouTube client reads 50 uploads per playlist page and 50 ids per
// stats call, at 1 unit each, after one channel lookup.
const YOUTUBE_PAGE_SIZE = 50;
const YOUTUBE_UNITS_PER_CHANNEL = 1 + 2 * Math.ceil(MAX_UPLOADS_PER_CHANNEL / YOUTUBE_PAGE_SIZE);
const YOUTUBE_FREE_DAILY_UNITS = 10_000;
// A full dataset is well under 100 MB; a bigger file is refused unread.
const MAX_DATASET_BYTES = 256 * 1024 * 1024;

const count = new Intl.NumberFormat("en-US");

function readArgs(argv: string[]): { mode: "dry-run" } | { mode: "analyse"; path: string } | { mode: "live" } | undefined {
  try {
    const { values } = parseArgs({
      args: argv,
      options: { "dry-run": { type: "boolean", default: false }, analyse: { type: "string" } },
      strict: true,
      allowPositionals: false,
    });
    if (values["dry-run"] && values.analyse !== undefined) return undefined;
    if (values["dry-run"]) return { mode: "dry-run" };
    if (values.analyse !== undefined) return values.analyse.trim() === "" ? undefined : { mode: "analyse", path: values.analyse };
    return { mode: "live" };
  } catch {
    return undefined;
  }
}

function issueLines(error: z.ZodError): string[] {
  return error.issues.slice(0, 5).map((issue) => `  at ${issue.path.join(".") || "(top level)"}: ${issue.message}`);
}

function readJson(path: string, maxBytes: number): unknown {
  if (statSync(path).size > maxBytes) throw new RangeError(`${path} is larger than ${count.format(maxBytes)} bytes`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function printPlan(shows: ShowConfig[]): void {
  const pinned = shows.filter((show) => show.youtubeChannelId !== null);
  const nameWidth = Math.max(...shows.map((show) => show.name.length));
  const handleWidth = Math.max(...pinned.map((show) => show.youtubeHandle?.length ?? 0));
  const searchesPerShow = MAX_UPLOADS_PER_CHANNEL;
  const insightsPerShow = Math.ceil(MAX_UPLOADS_PER_CHANNEL / FIT_BATCH_SIZE);

  console.log("Backtest dry run. No network call is made and no key is read.");
  console.log("Method: docs/backtest-preregistration.md");
  console.log(`Show list: docs/backtest-shows.json, ${shows.length} shows, valid.`);
  console.log("");
  console.log("Shows, in the pre-registered order:");
  for (const [index, show] of shows.entries()) {
    const label = `${String(index + 1).padStart(4)}. ${show.name.padEnd(nameWidth)}`;
    console.log(
      show.youtubeChannelId === null
        ? `${label}  no channel pinned, so it is dropped and counted as showNoChannel`
        : `${label}  ${(show.youtubeHandle ?? "").padEnd(handleWidth)}  ${show.youtubeChannelId}`,
    );
    if (show.titleMustContain !== undefined) {
      console.log(`${" ".repeat(6 + nameWidth)}  shared channel: titles must contain "${show.titleMustContain}"`);
    }
  }
  console.log("");
  console.log("Rules, in the order they are applied (drop counter in brackets):");
  for (const line of [
    "Show: has a pinned channel (showNoChannel).",
    "Show: a Qloo podcast whose normalised name equals the show's wins; only if there is none, one where one name is the other followed by more words. More than one podcast in the winning tier excludes the show (showNoPodcastMatch, showAmbiguousPodcast).",
    `Uploads: up to ${count.format(MAX_UPLOADS_PER_CHANNEL)} from the pinned channel's uploads playlist. YouTube search is never called. If the cap is hit and no upload read predates ${WINDOW_FROM}, the show is marked cut short and stays in.`,
    "Episode: on a shared channel, the normalised title contains the show's titleMustContain (notThisShow).",
    "Episode: has a public view count (hiddenViews).",
    `Episode: published from ${WINDOW_FROM} to ${WINDOW_TO} inclusive, UTC (notInWindow).`,
    `Episode: at least ${MIN_DURATION_SEC / 60} minutes long (tooShort).`,
    "Episode: the model names exactly one guest (noSingleGuest).",
    "Episode: that name appears in the title under the shared normaliser (nameNotInTitle).",
    "Episode: Qloo's top person result has the same normalised name (guestNotResolved).",
    "Episode: Qloo returns a fit score for that person (noFitScore).",
    "Episode: the same Qloo response gives that person's popularity, used as fame (noFame).",
    `Show: at least ${MIN_EPISODES_PER_SHOW} eligible episodes, then ${MIN_EPISODES_PER_SHOW} resolved guests, then ${MIN_EPISODES_PER_SHOW} rows (showTooFewEpisodes).`,
    `Analysis: Spearman of fit and age-adjusted views (H1) and partial Spearman given fame (H2), pooled with Fisher z weighted by n - 3, ${count.format(BOOTSTRAP_ITERATIONS)} bootstrap resamples with seed ${BOOTSTRAP_SEED}. Fewer than ${MIN_SHOWS} shows kept means insufficient data.`,
  ]) {
    console.log(`  ${line}`);
  }
  console.log("");
  console.log(`Call budget, as upper bounds for the ${pinned.length} shows with a pinned channel:`);
  console.log(
    `  YouTube: at most ${YOUTUBE_UNITS_PER_CHANNEL} units per channel (1 channel lookup, ${(YOUTUBE_UNITS_PER_CHANNEL - 1) / 2} upload pages, ${(YOUTUBE_UNITS_PER_CHANNEL - 1) / 2} stats calls), ${count.format(YOUTUBE_UNITS_PER_CHANNEL * pinned.length)} in all, against a free daily quota of ${count.format(YOUTUBE_FREE_DAILY_UNITS)}. Retries after server errors can add a few.`,
  );
  console.log(
    `  Qloo: 1 podcast search per show (${pinned.length}). Then, only for shows with at least ${MIN_EPISODES_PER_SHOW} eligible episodes, 1 person search per distinct guest name and 1 insights call per ${FIT_BATCH_SIZE} resolved guests: at most ${count.format(searchesPerShow)} and ${insightsPerShow} per show, ${count.format(pinned.length * (1 + searchesPerShow + insightsPerShow))} requests in all.`,
  );
  console.log(
    `  Model: 1 title read per upload that is in the window and at least ${MIN_DURATION_SEC / 60} minutes long, at most ${count.format(MAX_UPLOADS_PER_CHANNEL)} per channel and ${count.format(MAX_UPLOADS_PER_CHANNEL * pinned.length)} in all.`,
  );
  console.log(
    `  These bounds assume every channel has ${count.format(MAX_UPLOADS_PER_CHANNEL)} full-length, single-guest uploads in the window, so real counts will be lower.`,
  );
}

function main(): number {
  const args = readArgs(process.argv.slice(2));
  if (args === undefined) {
    console.error(USAGE);
    return 2;
  }

  if (args.mode === "live") {
    console.error(LIVE_REFUSAL);
    return 1;
  }

  if (args.mode === "dry-run") {
    let rawShows: unknown;
    try {
      rawShows = readJson(SHOWS_FILE, 1024 * 1024);
    } catch (error) {
      console.error(error instanceof SyntaxError ? "docs/backtest-shows.json is not valid JSON." : "Could not read docs/backtest-shows.json.");
      return 1;
    }
    const parsed = ShowListSchema.safeParse(rawShows);
    if (!parsed.success) {
      console.error("docs/backtest-shows.json does not match its schema:");
      for (const line of issueLines(parsed.error)) console.error(line);
      return 1;
    }
    printPlan(parsed.data);
    return 0;
  }

  let raw: unknown;
  try {
    raw = readJson(args.path, MAX_DATASET_BYTES);
  } catch (error) {
    console.error(error instanceof SyntaxError ? `${args.path} is not valid JSON.` : `Could not read ${args.path}.`);
    return 1;
  }
  const dataset = DatasetSchema.safeParse(raw);
  if (!dataset.success) {
    console.error(`${args.path} does not match the dataset schema:`);
    for (const line of issueLines(dataset.error)) console.error(line);
    return 1;
  }
  try {
    console.log(JSON.stringify(analyse(dataset.data), null, 2));
  } catch (error) {
    console.error(error instanceof RangeError ? `The dataset is inconsistent: ${error.message}.` : "The analysis stopped with an unexpected error.");
    return 1;
  }
  return 0;
}

process.exitCode = main();
