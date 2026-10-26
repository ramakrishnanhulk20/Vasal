// The offline backtest: does Qloo guest fit predict YouTube views? The
// method is fixed in docs/backtest-preregistration.md. With no flag it pulls
// the data for real and analyses it; a dry run checks the pinned show list
// and prints the plan with no network and no keys; --analyse recomputes the
// pre-registered results from a stored dataset. The post-hoc checks are
// recomputed by scripts/backtest-robustness.ts.
//
// The live pull spends the offline Qloo share (qloo:day:offline and
// qloo:month:offline, still inside the shared month and per-second limits)
// through the same metered client as the server (C5.1, C9.2). Its output holds Qloo-derived values, so it goes
// only to the git-ignored data/backtest folder (C7.3).
//
// Usage: npx tsx scripts/backtest.ts [--limit-shows N] [--dev-db]
//        npx tsx scripts/backtest.ts --dry-run | --analyse <dataset.json>
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { AgentError } from "../src/agent/errors.js";
import { createGuestExtractor } from "../src/agent/extract-guest.js";
import { createAnthropicModel } from "../src/agent/model.js";
import { analyse, MIN_SHOWS } from "../src/backtest/analyse.js";
import { MIN_DURATION_SEC, WINDOW_FROM, WINDOW_TO } from "../src/backtest/eligibility.js";
import { createLivePipelineDeps, precisionSample, precisionSampleCsv } from "../src/backtest/live.js";
import { buildDataset, FIT_BATCH_SIZE, MAX_UPLOADS_PER_CHANNEL, MIN_EPISODES_PER_SHOW } from "../src/backtest/pipeline.js";
import { BOOTSTRAP_ITERATIONS, BOOTSTRAP_SEED } from "../src/backtest/stats.js";
import { DatasetSchema, ShowListSchema, type BacktestResult, type HypothesisResult, type ShowConfig } from "../src/backtest/types.js";
import { loadQlooConfig } from "../src/config.js";
import { loadRepoEnv, OpsConfigError, openDevDb, openOwnerDb } from "../src/ops/db.js";
import { loadPolicy, PolicyError } from "../src/ops/policy.js";
import { rollBuckets } from "../src/ops/roll.js";
import { createQlooClient } from "../src/qloo/client.js";
import { QlooError } from "../src/qloo/errors.js";
import { createMeteredQloo } from "../src/qloo/metered.js";
import type { Db } from "../src/store/db.js";
import { StoreError } from "../src/store/errors.js";
import { reserve, reserveWithReceipt, settleToUsage, waitForQlooSlot } from "../src/store/meter.js";
import { recordQuota } from "../src/store/quota.js";
import { createYouTubeClient } from "../src/youtube/client.js";
import { YouTubeError } from "../src/youtube/errors.js";

const SHOWS_FILE = fileURLToPath(new URL("../../../docs/backtest-shows.json", import.meta.url));
const POLICY_FILE = fileURLToPath(new URL("./budget-policy.json", import.meta.url));
const OUTPUT_ROOT = fileURLToPath(new URL("../data/backtest/", import.meta.url));
const USAGE = [
  "Usage: npx tsx scripts/backtest.ts [--limit-shows N] [--dev-db]",
  "       npx tsx scripts/backtest.ts --dry-run | --analyse <dataset.json>",
].join("\n");

const LIVE_KEYS = ["QLOO_API_KEY", "YOUTUBE_API_KEY", "ANTHROPIC_API_KEY"] as const;
const OWNER_DB = "OWNER_DATABASE_URL";
const OFFLINE_QLOO_DAY = "qloo:day:offline";
const OFFLINE_QLOO_MONTH = "qloo:month:offline";
// The live server takes 8 of Qloo's 10 calls a second, and an offline script
// outside the hosted meter takes the other 2. A --dev-db pull meters itself
// in a throwaway database the server never sees, so it holds itself to 2.
const DEV_DB_PER_SECOND_CAP = 2;
const YOUTUBE_DAY = "youtube:day";
// The backtest's title reads draw on their own token share, so a data pull can
// never use up the day's tokens that live runs on the site depend on.
const ANTHROPIC_DAY = "anthropic:day:offline";
const DEFAULT_MODEL = "claude-haiku-5-5";
const DEFAULT_EFFORT = "medium";
// The same rules the agent server applies to these variables.
const MODEL_ID = /^claude-[a-z0-9-]{3,60}$/;
const EFFORTS = ["low", "medium", "high"] as const;
const PRINTABLE_KEY = /^[\x21-\x7E]{1,500}$/;
const MAX_LIMIT_SHOWS = 100;

// The YouTube client reads 50 uploads per playlist page and 50 ids per
// stats call, at 1 unit each, after one channel lookup.
const YOUTUBE_PAGE_SIZE = 50;
const YOUTUBE_UNITS_PER_CHANNEL = 1 + 2 * Math.ceil(MAX_UPLOADS_PER_CHANNEL / YOUTUBE_PAGE_SIZE);
const YOUTUBE_FREE_DAILY_UNITS = 10_000;
// A full dataset is well under 100 MB; a bigger file is refused unread.
const MAX_DATASET_BYTES = 256 * 1024 * 1024;

const count = new Intl.NumberFormat("en-US");

type Args =
  | { mode: "dry-run" }
  | { mode: "analyse"; path: string }
  | { mode: "live"; limitShows: number | null; devDb: boolean };

function readArgs(argv: string[]): Args | undefined {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        "dry-run": { type: "boolean", default: false },
        analyse: { type: "string" },
        "limit-shows": { type: "string" },
        "dev-db": { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    const liveOnly = values["limit-shows"] !== undefined || values["dev-db"];
    if (values["dry-run"] && values.analyse !== undefined) return undefined;
    if (values["dry-run"]) return liveOnly ? undefined : { mode: "dry-run" };
    if (values.analyse !== undefined) {
      return liveOnly || values.analyse.trim() === "" ? undefined : { mode: "analyse", path: values.analyse };
    }
    const limit = values["limit-shows"];
    if (limit === undefined) return { mode: "live", limitShows: null, devDb: values["dev-db"] };
    if (!/^[0-9]{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > MAX_LIMIT_SHOWS) return undefined;
    return { mode: "live", limitShows: Number(limit), devDb: values["dev-db"] };
  } catch {
    return undefined;
  }
}

function missingForLive(devDb: boolean): string[] {
  const wanted = devDb ? [...LIVE_KEYS] : [...LIVE_KEYS, OWNER_DB];
  return wanted.filter((name) => (process.env[name] ?? "").trim() === "");
}

function liveRefusal(missing: string[]): string {
  return [
    `The live backtest needs ${LIVE_KEYS.join(", ")} and ${OWNER_DB} (or --dev-db for a throwaway database in place of ${OWNER_DB}).`,
    `Missing: ${missing.join(", ")}. Nothing was sent anywhere.`,
  ].join("\n");
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
    "Episode: the model cannot read the title (extractFailed).",
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

function readShows(): ShowConfig[] | undefined {
  let rawShows: unknown;
  try {
    rawShows = readJson(SHOWS_FILE, 1024 * 1024);
  } catch (error) {
    console.error(error instanceof SyntaxError ? "docs/backtest-shows.json is not valid JSON." : "Could not read docs/backtest-shows.json.");
    return undefined;
  }
  const parsed = ShowListSchema.safeParse(rawShows);
  if (!parsed.success) {
    console.error("docs/backtest-shows.json does not match its schema:");
    for (const line of issueLines(parsed.error)) console.error(line);
    return undefined;
  }
  return parsed.data;
}

function modelSettings(): { model: string; effort: (typeof EFFORTS)[number] } | string {
  const model = (process.env["VASAL_MODEL"] ?? "").trim() || DEFAULT_MODEL;
  const effort = (process.env["VASAL_EFFORT"] ?? "").trim() || DEFAULT_EFFORT;
  if (!MODEL_ID.test(model)) return "VASAL_MODEL must be a Claude model id such as claude-haiku-5-5.";
  const known = EFFORTS.find((level) => level === effort);
  if (known === undefined) return "VASAL_EFFORT must be low, medium or high.";
  return { model, effort: known };
}

// Only errors whose messages are fixed text are shown in full. Anything else
// could quote a request, a key or a connection string, so only its type shows.
function stopReason(error: unknown): string {
  if (error instanceof QlooError || error instanceof YouTubeError || error instanceof AgentError || error instanceof StoreError) {
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof PolicyError) return [error.message, ...error.issues].join(" ");
  if (error instanceof OpsConfigError || error instanceof RangeError) return error.message;
  return `an unexpected ${error instanceof Error ? error.name : "failure"}`;
}

// A UTC timestamp with no colons, so the folder name is valid on Windows.
const folderStamp = (date: Date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

const rho = (value: number | null) => (value === null ? "none" : value.toFixed(3));

function hypothesisLine(label: string, result: HypothesisResult): string {
  const interval = result.interval === null ? "no interval" : `95% interval ${rho(result.interval.low)} to ${rho(result.interval.high)}`;
  return `  ${label}: pooled rho ${rho(result.pooledRho)}, ${interval}, ${result.decision}`;
}

function printSummary(result: BacktestResult, folder: string, calls: { calls: number; cacheHits: number }): void {
  console.log("");
  console.log(`Result: ${result.status}, ${result.sample.shows} shows and ${count.format(result.sample.episodes)} episodes kept.`);
  console.log(hypothesisLine("H1, fit against age-adjusted views", result.h1));
  console.log(hypothesisLine("H2, the same controlling for fame", result.h2));
  const ratio = result.descriptive.medianAdjustedViewRatioTopToBottomFitQuintile;
  console.log(`  Median adjusted views, top fit fifth over bottom fifth: ${ratio === null ? "none" : ratio.toFixed(3)}`);
  console.log("Shows:");
  for (const show of result.showOutcomes) {
    console.log(`  ${show.name}: ${show.status}, ${show.rows} rows${show.cutShort ? ", cut short at the upload cap" : ""}`);
  }
  const drops = Object.entries(result.drops).filter(([, n]) => n > 0);
  console.log(`Drops: ${drops.length === 0 ? "none" : drops.map(([reason, n]) => `${reason} ${count.format(n)}`).join(", ")}`);
  console.log(`Qloo: ${count.format(calls.calls)} calls sent, ${count.format(calls.cacheHits)} answered from the cache.`);
  console.log(`Written to ${folder} (git-ignored: dataset.json and result.json hold Qloo-derived values).`);
}

async function runLive(limitShows: number | null, devDb: boolean): Promise<number> {
  loadRepoEnv();
  const missing = missingForLive(devDb);
  if (missing.length > 0) {
    console.error(liveRefusal(missing));
    return 1;
  }

  const shows = readShows();
  if (shows === undefined) return 1;
  if (limitShows !== null && limitShows > shows.length) {
    console.error(`--limit-shows is ${limitShows}, but the show list has ${shows.length} shows.`);
    return 2;
  }
  const selected = limitShows === null ? shows : shows.slice(0, limitShows);

  let qlooConfig: ReturnType<typeof loadQlooConfig>;
  try {
    qlooConfig = loadQlooConfig();
  } catch (error) {
    // loadQlooConfig's messages name a variable, never its value.
    console.error(error instanceof Error ? error.message : "The Qloo settings could not be read.");
    return 1;
  }
  const settings = modelSettings();
  if (typeof settings === "string") {
    console.error(settings);
    return 1;
  }
  const qlooKey = qlooConfig.apiKey ?? "";
  const youtubeKey = (process.env["YOUTUBE_API_KEY"] ?? "").trim();
  const anthropicKey = (process.env["ANTHROPIC_API_KEY"] ?? "").trim();
  if (!PRINTABLE_KEY.test(anthropicKey)) {
    console.error("ANTHROPIC_API_KEY has spaces or characters a key cannot contain. Copy the key into .env again.");
    return 1;
  }

  let db: Db | undefined;
  try {
    db = devDb ? await openDevDb() : openOwnerDb();
    const store = db;
    if (devDb) {
      const rolled = await rollBuckets(store, await loadPolicy(POLICY_FILE), new Date());
      if (!rolled.covered) {
        console.error("No profile in scripts/budget-policy.json covers today, so the throwaway database has no budget.");
        return 1;
      }
      console.log("Using a throwaway in-memory database with today's budget profile.");
      console.log("Its counters are not shared with the hosted database, so calls made now do not count against the site's caps.");
    }
    if (limitShows !== null) {
      console.log(`Trial run on the first ${selected.length} shows only. This is not the pre-registered result.`);
    }

    // No retries inside the client, so every Qloo attempt takes its own slot
    // from the offline share of the shared meter (C5.1, C5.2).
    const client = createQlooClient({ apiKey: qlooKey, baseUrl: qlooConfig.baseUrl, maxRetries: 0, onQuota: (quota) => recordQuota(store, quota) });
    const offline = { dayKey: OFFLINE_QLOO_DAY, extraKeys: [OFFLINE_QLOO_MONTH] };
    const slot = devDb ? { ...offline, perSecondCap: DEV_DB_PER_SECOND_CAP } : offline;
    const qloo = createMeteredQloo({
      client,
      db: store,
      baseUrl: qlooConfig.baseUrl,
      waitForSlot: (target) => waitForQlooSlot(target, slot),
    });
    const youtube = createYouTubeClient({
      apiKey: youtubeKey,
      reserveUnits: (units) => reserve(store, [{ key: YOUTUBE_DAY, amount: units }]),
    });
    const model = createAnthropicModel({
      apiKey: anthropicKey,
      model: settings.model,
      effort: settings.effort,
      reserveTokens: async (tokens) => {
        const receipt = await reserveWithReceipt(store, [{ key: ANTHROPIC_DAY, amount: tokens }]);
        return receipt === null ? false : settleToUsage(store, receipt);
      },
    });
    const pulledAt = new Date();
    const deps = createLivePipelineDeps({ db: store, qloo, youtube, extractGuest: createGuestExtractor(model), now: () => pulledAt });

    console.log(`Pulling ${selected.length} shows with ${settings.model}. This takes a while; every call is metered.`);
    const dataset = await buildDataset(selected, deps);

    // The dataset is written before the analysis runs, so a long pull is
    // never lost; --analyse can rerun the numbers from it.
    const folder = join(OUTPUT_ROOT, folderStamp(pulledAt));
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "dataset.json"), `${JSON.stringify(dataset, null, 2)}\n`, { flag: "wx" });
    writeFileSync(join(folder, "precision-sample.csv"), precisionSampleCsv(precisionSample(dataset.rows)), { flag: "wx" });
    const result = analyse(dataset);
    writeFileSync(join(folder, "result.json"), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });

    printSummary(result, folder, qloo.stats());
    return 0;
  } catch (error) {
    console.error(`The backtest stopped: ${stopReason(error)}`);
    return 1;
  } finally {
    await db?.close().catch(() => {});
  }
}

async function main(): Promise<number> {
  const args = readArgs(process.argv.slice(2));
  if (args === undefined) {
    console.error(USAGE);
    return 2;
  }

  if (args.mode === "live") return runLive(args.limitShows, args.devDb);

  if (args.mode === "dry-run") {
    const shows = readShows();
    if (shows === undefined) return 1;
    printPlan(shows);
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

process.exitCode = await main();
