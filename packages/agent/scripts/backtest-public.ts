// Writes the backtest's public numbers for the proof page to
// packages/web/src/published/backtest.json, from a stored dataset folder's
// dataset.json and result.json. Qloo's hackathon guide keeps its response
// data out of public repositories, so the file holds aggregates only: no
// name, title, id, raw score or per-episode value (threat model C7.3). No
// network call, no key. Before anything is written, every number is checked
// against result.json and the published post-hoc values; a failed check
// writes nothing and exits 1.
//
// Usage: npm run backtest:public -w packages/agent [-- --dataset <dir>]
// A relative <dir> is read from packages/agent.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { analyse } from "../src/backtest/analyse.js";
import {
  buildPublic,
  DATASET_NAME,
  leakFindings,
  publicJson,
  StoredResultSchema,
  type PublicBacktest,
} from "../src/backtest/public.js";
import { DatasetSchema, type BacktestResult, type Dataset } from "../src/backtest/types.js";

const USAGE = "Usage: npm run backtest:public -w packages/agent [-- --dataset <dir>]";
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DEFAULT_DATASET = fileURLToPath(new URL("../data/backtest/20261021T105230Z", import.meta.url));
const OUTPUT_FILE = fileURLToPath(new URL("../../web/src/published/backtest.json", import.meta.url));
// The same limit as scripts/backtest.ts --analyse: a bigger file is refused unread.
const MAX_DATASET_BYTES = 256 * 1024 * 1024;
const MAX_RESULT_BYTES = 16 * 1024 * 1024;

// The hand check of the 50-row precision sample, published in
// docs/backtest-results.md ("44 of the 50 were right"). It cannot be
// computed from the dataset.
const PRECISION = { checked: 50, correct: 44 };

// The post-hoc numbers as docs/backtest-results.md publishes them, to three
// decimals. The self-check holds the recomputed values to these.
const PUBLISHED = {
  sensitivity: { episodes: 683, h1: ["0.149", "0.070", "0.226"], h2: ["0.100", "0.017", "0.184"] },
  guestLevel: { guests: 603, h1: ["0.065", "0.211"], h2: ["0.020", "0.167"], oneRowPerGuest: ["0.153", "0.111"] },
} as const;

const three = (value: number | null | undefined) => (value === null || value === undefined ? "none" : value.toFixed(3));
const count = new Intl.NumberFormat("en-US");

function issuePaths(error: z.ZodError): string[] {
  return error.issues.slice(0, 5).map((issue) => `  at ${issue.path.join(".") || "(top level)"}: ${issue.message}`);
}

function readJson(path: string, maxBytes: number): unknown {
  if (statSync(path).size > maxBytes) throw new RangeError(`${path} is larger than ${count.format(maxBytes)} bytes`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function readParsed<T>(path: string, schema: z.ZodType<T>, maxBytes: number): T | undefined {
  let raw: unknown;
  try {
    raw = readJson(path, maxBytes);
  } catch (error) {
    console.error(error instanceof SyntaxError ? `${path} is not valid JSON.` : `Could not read ${path}.`);
    return undefined;
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    console.error(`${path} does not match its schema:`);
    for (const line of issuePaths(result.error)) console.error(line);
    return undefined;
  }
  return result.data;
}

function readFolder(folder: string): { dataset: Dataset; stored: BacktestResult } | undefined {
  const dataset = readParsed(join(folder, "dataset.json"), DatasetSchema, MAX_DATASET_BYTES);
  if (dataset === undefined) return undefined;
  const stored = readParsed(join(folder, "result.json"), StoredResultSchema, MAX_RESULT_BYTES);
  return stored === undefined ? undefined : { dataset, stored };
}

/** Every way the built file disagrees with result.json, the published values or the aggregates-only rule. */
function selfCheck(output: PublicBacktest, dataset: Dataset, stored: BacktestResult): string[] {
  const failures: string[] = [];
  const expect = (ok: boolean, what: string) => {
    if (!ok) failures.push(what);
  };

  expect(JSON.stringify(analyse(dataset)) === JSON.stringify(stored), "result.json is not exactly what the dataset regenerates");
  for (const key of ["h1", "h2"] as const) {
    const mine = output[key];
    const theirs = stored[key];
    expect(
      mine.rho === theirs.pooledRho &&
        mine.low === theirs.interval?.low &&
        mine.high === theirs.interval?.high &&
        mine.supported === (theirs.decision === "supported"),
      `${key} differs from result.json`,
    );
  }
  expect(
    output.bootstrap.iterations === stored.bootstrap.iterations && output.bootstrap.seed === stored.bootstrap.seed,
    "the bootstrap settings differ from result.json",
  );
  expect(
    output.fifths[4]?.medianRatio === stored.descriptive.medianAdjustedViewRatioTopToBottomFitQuintile,
    "fifth 5's ratio differs from result.json's descriptive ratio",
  );
  expect(output.fifths[0]?.medianRatio === 1, "fifth 1's ratio is not 1");
  expect(
    output.fifths.reduce((total, fifth) => total + fifth.episodes, 0) === output.sample.episodes,
    "the fifth sizes do not add up to the episodes kept",
  );
  expect(
    output.sample.shows === stored.sample.shows && output.sample.episodes === stored.sample.episodes,
    "the sample differs from result.json",
  );
  expect(
    output.uploadsRead - output.drops.reduce((total, drop) => total + drop.count, 0) === output.sample.episodes,
    "uploads read minus every drop is not the episodes kept",
  );

  const { sensitivity, guestLevel } = output;
  expect(sensitivity.episodes === PUBLISHED.sensitivity.episodes, "the rerun without misread rows kept a different number of episodes");
  for (const key of ["h1", "h2"] as const) {
    const values = [sensitivity[key].rho, sensitivity[key].low, sensitivity[key].high].map(three);
    expect(
      values.join() === PUBLISHED.sensitivity[key].join() && sensitivity[key].supported,
      `the rerun's ${key} differs from the published ${PUBLISHED.sensitivity[key].join(", ")}`,
    );
    const interval = [guestLevel[key].low, guestLevel[key].high].map(three);
    expect(interval.join() === PUBLISHED.guestLevel[key].join(), `the guest bootstrap's ${key} differs from the published interval`);
  }
  expect(guestLevel.guests === PUBLISHED.guestLevel.guests, "the guest count differs from the published one");
  expect(
    [guestLevel.oneRowPerGuest.h1, guestLevel.oneRowPerGuest.h2].map(three).join() === PUBLISHED.guestLevel.oneRowPerGuest.join(),
    "the one-row-per-guest values differ from the published ones",
  );

  for (const finding of leakFindings(output, dataset)) failures.push(`not an aggregate: ${finding}`);
  return failures;
}

function hypothesisLine(label: string, h: { rho: number; low: number; high: number; supported: boolean }): string {
  return `  ${label}: rho ${three(h.rho)}, 95% interval ${three(h.low)} to ${three(h.high)}, ${h.supported ? "supported" : "not supported"}`;
}

function main(): number {
  let folder: string;
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: { dataset: { type: "string" } },
      strict: true,
      allowPositionals: false,
    });
    if (values.dataset !== undefined && values.dataset.trim() === "") throw new TypeError("empty dataset");
    folder = resolve(values.dataset ?? DEFAULT_DATASET);
  } catch {
    console.error(USAGE);
    return 2;
  }
  const datasetName = basename(folder);
  if (!DATASET_NAME.test(datasetName)) {
    console.error("The dataset folder must be named for its pull, like 20261021T105230Z.");
    return 2;
  }

  const input = readFolder(folder);
  if (input === undefined) return 1;

  let output: PublicBacktest;
  try {
    output = buildPublic({ ...input, datasetName, precision: PRECISION });
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error("The public file failed its own schema, so nothing was written:");
      for (const line of issuePaths(error)) console.error(line);
    } else {
      console.error(error instanceof RangeError ? `The dataset is inconsistent: ${error.message}.` : "The build stopped with an unexpected error.");
    }
    return 1;
  }

  const failures = selfCheck(output, input.dataset, input.stored);
  if (failures.length > 0) {
    console.error("Self-check failed, so nothing was written:");
    for (const failure of failures) console.error(`  ${failure}`);
    return 1;
  }

  const text = publicJson(output);
  mkdirSync(dirname(OUTPUT_FILE), { recursive: true });
  writeFileSync(OUTPUT_FILE, text, "utf8");

  const { sensitivity, guestLevel } = output;
  console.log(`Wrote ${relative(REPO_ROOT, OUTPUT_FILE).replaceAll("\\", "/")}, ${count.format(Buffer.byteLength(text))} bytes, from ${datasetName}.`);
  console.log(`Sample: ${output.sample.shows} shows, ${count.format(output.sample.episodes)} episodes, from ${count.format(output.uploadsRead)} uploads read.`);
  console.log(hypothesisLine("H1", output.h1));
  console.log(hypothesisLine("H2", output.h2));
  console.log(`  Fifths (median adjusted views over the bottom fifth): ${output.fifths.map((f) => `${f.fifth} ${three(f.medianRatio)} (${f.episodes})`).join(", ")}`);
  console.log(`Post-hoc rerun without misread rows, ${count.format(sensitivity.episodes)} episodes:`);
  console.log(hypothesisLine("H1", sensitivity.h1));
  console.log(hypothesisLine("H2", sensitivity.h2));
  console.log(
    `Post-hoc repeat guests, ${count.format(guestLevel.guests)} guests: guest bootstrap H1 ${three(guestLevel.h1.low)} to ${three(guestLevel.h1.high)}, H2 ${three(guestLevel.h2.low)} to ${three(guestLevel.h2.high)}; one row per guest H1 ${three(guestLevel.oneRowPerGuest.h1)}, H2 ${three(guestLevel.oneRowPerGuest.h2)}.`,
  );
  console.log("Self-check passed: result.json regenerates from the dataset, the published post-hoc values match, and the file holds aggregates only.");
  return 0;
}

process.exitCode = main();
