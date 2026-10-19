// The operator's jobs, one command each. Every command prints a short plain
// report and exits 1 when it finds a problem, so it can run from a scheduler.
// They connect as the database owner (OWNER_DATABASE_URL), because the app
// role cannot set caps, flip the kill switch, promote runs or delete rows
// (C6.3, C6.6).
//
// Usage: npx tsx scripts/ops.ts [--dev] <command>, see USAGE below.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { OpsConfigError, openDevDb, openOwnerDb } from "../src/ops/db.js";
import { formatHealth, healthReport } from "../src/ops/health.js";
import { loadPolicy, PolicyError } from "../src/ops/policy.js";
import {
  checkPosition,
  formatPreview,
  formatPromoted,
  listPromoted,
  previewRun,
  PromoteError,
  promoteRun,
  unpromoteRun,
} from "../src/ops/promote.js";
import { pruneExpired } from "../src/ops/prune.js";
import { rollBuckets, type BucketRoll, type BucketState } from "../src/ops/roll.js";
import { ServerError } from "../src/server/errors.js";
import { createRun, finishRun, listShowcase, putBoard, setRunStatus } from "../src/server/runs.js";
import type { Db } from "../src/store/db.js";
import { StoreError } from "../src/store/errors.js";
import { liveRunsEnabled, setFlag } from "../src/store/flags.js";
import { migrate } from "../src/store/migrate.js";

const POLICY_FILE = fileURLToPath(new URL("./budget-policy.json", import.meta.url));
const ROLES_FILE = fileURLToPath(new URL("../src/store/roles.sql", import.meta.url));

const USAGE = `Usage: npx tsx scripts/ops.ts [--dev] <command>

  migrate                 apply src/store/schema.sql
  roles                   print roles.sql and the psql steps that create the app role
  budgets                 set today's caps from scripts/budget-policy.json (run daily)
  prune                   delete expired cache rows, per-second buckets and old visitor counters
  flag live-runs on|off   switch live runs on the site on or off
  health                  print the health report
  promote <runId> <position> [--yes]
                          print a run's board; with --yes, put it on the home page at position 1 to 12
  unpromote <runId>       take a run off the home page
  showcase                list the runs on the home page
  selftest                with --dev only: budgets, health, flag live-runs off, health, then
                          promote, list and unpromote a synthetic finished run

--dev uses a throwaway in-memory database with the schema applied and live
runs on. Without it every command except roles needs OWNER_DATABASE_URL.
--yes is accepted only by promote.`;

const PROMOTE_HINT = "Read the board above. Run again with --yes to put it on the home page.";

type PlainCommand = "migrate" | "roles" | "budgets" | "prune" | "health" | "showcase" | "selftest";
// One member per name, so a check on the name narrows the whole command.
type Command =
  | { [Name in PlainCommand]: { name: Name } }[PlainCommand]
  | { name: "flag"; liveRuns: boolean }
  | { name: "promote"; runId: string; position: number; yes: boolean }
  | { name: "unpromote"; runId: string };

// Digits only, so " 3", "3.0" and "0x3" are refused rather than read as 3.
const positionFrom = (text: string): number => (/^\d{1,2}$/.test(text) ? Number(text) : Number.NaN);

const grouped = new Intl.NumberFormat("en-US");
const utc = (date: Date) => `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;

function readArgs(argv: string[]): { dev: boolean; command: Command } | undefined {
  let parsed: { values: { dev?: boolean | undefined; yes?: boolean | undefined }; positionals: string[] };
  try {
    parsed = parseArgs({
      args: argv,
      options: { dev: { type: "boolean", default: false }, yes: { type: "boolean", default: false } },
      allowPositionals: true,
      strict: true,
    });
  } catch {
    return undefined;
  }
  const dev = parsed.values.dev === true;
  const yes = parsed.values.yes === true;
  const [name, ...rest] = parsed.positionals;
  if (name === "promote") {
    const [runId, position] = rest;
    if (rest.length !== 2 || runId === undefined || position === undefined) return undefined;
    return { dev, command: { name, runId, position: positionFrom(position), yes } };
  }
  if (yes) return undefined;
  if (name === "unpromote") {
    const [runId] = rest;
    if (rest.length !== 1 || runId === undefined) return undefined;
    return { dev, command: { name, runId } };
  }
  if (name === "flag") {
    if (rest.length !== 2 || rest[0] !== "live-runs" || (rest[1] !== "on" && rest[1] !== "off")) return undefined;
    return { dev, command: { name, liveRuns: rest[1] === "on" } };
  }
  if (rest.length !== 0) return undefined;
  if (
    name === "migrate" ||
    name === "roles" ||
    name === "budgets" ||
    name === "prune" ||
    name === "health" ||
    name === "showcase" ||
    name === "selftest"
  ) {
    return { dev, command: { name } };
  }
  return undefined;
}

function describeState(state: BucketState | null): string {
  if (state === null) return "unreadable";
  return `${`cap ${grouped.format(state.cap)}`.padEnd(16)} ${`used ${grouped.format(state.used)}`.padEnd(14)} window ends ${utc(state.windowEnd)}`;
}

function describeChange(bucket: BucketRoll): string {
  if (bucket.changed.length === 0) return "no change";
  return bucket.changed
    .map((change) => ({ created: "created", cap: "cap changed", window: "new window, used reset to 0" })[change])
    .join(", ");
}

async function runBudgets(db: Db): Promise<boolean> {
  const now = new Date();
  const policy = await loadPolicy(POLICY_FILE);
  const outcome = await rollBuckets(db, policy, now);
  if (!outcome.covered) {
    console.log(`Budgets at ${utc(now)}: no profile in scripts/budget-policy.json covers today, so nothing was set.`);
    console.log("Problems:");
    console.log("  - Add a profile for today. Until then every bucket fails closed once its window ends.");
    return false;
  }

  console.log(`Budgets at ${utc(now)}, from the profile ${outcome.profile.from} up to ${outcome.profile.to}:`);
  const problems: string[] = [];
  for (const bucket of outcome.buckets) {
    console.log(`  ${bucket.key.padEnd(18)} ${describeState(bucket.after)}   ${describeChange(bucket)}`);
    if (bucket.after === null) problems.push(`${bucket.key} could not be read back after it was set.`);
    else if (bucket.after.windowEnd.getTime() !== bucket.windowEndWanted.getTime()) {
      problems.push(
        `${bucket.key} keeps a window set some other way, ending ${utc(bucket.after.windowEnd)} instead of ${utc(bucket.windowEndWanted)}. It moves to the policy's window once that one ends.`,
      );
    }
  }
  printProblems(problems);
  return problems.length === 0;
}

async function runPrune(db: Db): Promise<boolean> {
  const counts = await pruneExpired(db, new Date());
  console.log(
    `Pruned ${grouped.format(counts.cacheRows)} expired cache rows, ${grouped.format(counts.secondBuckets)} per-second buckets and ${grouped.format(counts.visitorCounters)} old visitor counters.`,
  );
  return true;
}

async function runFlag(db: Db, liveRuns: boolean): Promise<boolean> {
  await setFlag(db, "live_runs", liveRuns);
  const readBack = await liveRunsEnabled(db);
  console.log(`Live runs are now ${readBack ? "on" : "off"}.`);
  if (readBack === liveRuns) return true;
  printProblems([`The flag was set ${liveRuns ? "on" : "off"} but reads back ${readBack ? "on" : "off"}.`]);
  return false;
}

async function runHealth(db: Db): Promise<{ ok: boolean; problems: string[] }> {
  const report = await healthReport(db, new Date());
  for (const line of formatHealth(report)) console.log(line);
  return { ok: report.problems.length === 0, problems: report.problems };
}

function runRoles(): boolean {
  console.log(readFileSync(ROLES_FILE, "utf8").trimEnd());
  console.log("");
  console.log("This command only prints. Run these yourself, from packages/agent, with the owner's connection string:");
  for (const step of [
    "1. npx tsx scripts/ops.ts migrate",
    '2. psql "<owner connection string>" -v ON_ERROR_STOP=1 -f src/store/roles.sql',
    '3. psql "<owner connection string>", then type \\password vasal_app and enter a new password twice. psql sends it hashed, so it never sits in a file or your shell history.',
    "4. Give the web and agent servers DATABASE_URL with user vasal_app, that password, and the same host and database. The owner's string stays in OWNER_DATABASE_URL for these commands only.",
    "5. npx tsx scripts/ops.ts health",
  ]) {
    console.log(`  ${step}`);
  }
  return true;
}

async function runPromote(db: Db, runId: string, position: number, yes: boolean): Promise<boolean> {
  const place = checkPosition(position);
  if (!yes) {
    const preview = await previewRun(db, runId);
    for (const line of formatPreview(preview)) console.log(line);
    if (preview.refusal !== null) return false;
    console.log("");
    console.log(PROMOTE_HINT);
    return true;
  }
  await promoteRun(db, runId, place);
  console.log(`Run ${runId} is on the home page at position ${place}.`);
  return true;
}

async function runUnpromote(db: Db, runId: string): Promise<boolean> {
  const position = await unpromoteRun(db, runId);
  console.log(`Run ${runId} is off the home page, and position ${position} is free.`);
  return true;
}

// A promoted run the home page does not show is a problem worth exit 1.
async function runShowcase(db: Db): Promise<boolean> {
  const promoted = await listPromoted(db);
  const shown = await listShowcase(db);
  for (const line of formatPromoted(promoted, shown)) console.log(line);
  return promoted.every((run) => shown.some((view) => view.runId === run.runId && view.position === run.position));
}

// Synthetic guests in the shape the agent runner stores, so the self-test
// holds no Qloo data (C7.3).
const SELFTEST_GUESTS = [1, 2, 3].map((n) => ({
  personId: `00000000-0000-4000-8000-00000000060${n}`,
  name: `Synthetic Guest ${n}`,
  fit: (90 - n * 10) / 100,
  fitKnown: true,
  fitRank: n,
  reach: "bookable",
  rising: { state: "steady", points: 0 },
  bringsNew: null,
  sharedTags: [],
  angle: "A synthetic angle for the self-test.",
  showName: "Synthetic Show",
}));

async function finishedSyntheticRun(db: Db): Promise<string> {
  const runId = await createRun(db, { show: "Synthetic Show", exclude: [] });
  await setRunStatus(db, runId, "running");
  await putBoard(db, runId, SELFTEST_GUESTS);
  await finishRun(db, runId, "done", { name: "done", data: { guests: SELFTEST_GUESTS.length } });
  return runId;
}

async function selftestShowcase(db: Db): Promise<string[]> {
  const failures: string[] = [];
  const runId = await finishedSyntheticRun(db);
  console.log(`$ ops --dev promote ${runId} 1`);
  if (!(await runPromote(db, runId, 1, false))) failures.push("the preview refused the synthetic run");
  if ((await listPromoted(db)).length !== 0) failures.push("the preview changed the showcase");
  console.log("");
  console.log(`$ ops --dev promote ${runId} 1 --yes`);
  await runPromote(db, runId, 1, true);
  console.log("");
  console.log("$ ops --dev showcase");
  if (!(await runShowcase(db))) failures.push("the showcase reported a promoted run it does not show");
  const [shown, ...others] = await listShowcase(db);
  if (shown?.runId !== runId || shown.position !== 1 || shown.guests.length !== 3 || others.length !== 0) {
    failures.push("the home page did not list the promoted run with its 3 guests");
  }
  console.log("");
  console.log(`$ ops --dev unpromote ${runId}`);
  await runUnpromote(db, runId);
  console.log("");
  console.log("$ ops --dev showcase");
  await runShowcase(db);
  if ((await listShowcase(db)).length !== 0 || (await listPromoted(db)).length !== 0) {
    failures.push("the run was still on the home page after unpromote");
  }
  return failures;
}

async function runSelftest(db: Db): Promise<boolean> {
  const failures: string[] = [];
  console.log("$ ops --dev budgets");
  if (!(await runBudgets(db))) failures.push("budgets reported a problem");
  console.log("");
  console.log("$ ops --dev health");
  const first = await runHealth(db);
  if (!first.ok) failures.push("the first health check was not clean");
  console.log("");
  console.log("$ ops --dev flag live-runs off");
  if (!(await runFlag(db, false))) failures.push("live runs did not switch off");
  console.log("");
  console.log("$ ops --dev health");
  const second = await runHealth(db);
  const expected = ["Live runs are off, so the site shows saved runs only."];
  if (JSON.stringify(second.problems) !== JSON.stringify(expected)) failures.push("the second health check did not report live runs off, alone");
  console.log("");
  failures.push(...(await selftestShowcase(db)));
  console.log("");
  if (failures.length === 0) {
    console.log(
      "Self-test passed: budgets set cleanly, health was clean, health flagged live runs once they were off, and a synthetic finished run went on the home page and came off again.",
    );
    return true;
  }
  console.log(`Self-test failed: ${failures.join("; ")}.`);
  return false;
}

function printProblems(problems: string[]): void {
  if (problems.length === 0) {
    console.log("No problems.");
    return;
  }
  console.log("Problems:");
  for (const problem of problems) console.log(`  - ${problem}`);
}

// Only errors whose messages are fixed text are shown. Anything else could
// carry a connection string or a driver message, so it gets a fixed line.
function messageOf(error: unknown): string {
  if (error instanceof PolicyError) return [error.message, ...error.issues.map((issue) => `  ${issue}`)].join("\n");
  if (error instanceof OpsConfigError || error instanceof StoreError || error instanceof ServerError || error instanceof PromoteError) {
    return error.message;
  }
  return "The command stopped with an unexpected error.";
}

async function main(): Promise<number> {
  const args = readArgs(process.argv.slice(2));
  if (args === undefined) {
    console.error(USAGE);
    return 2;
  }
  const { dev, command } = args;
  if (command.name === "roles") return runRoles() ? 0 : 1;
  if (command.name === "selftest" && !dev) {
    console.error("selftest switches live runs off, so it runs only with --dev.");
    return 2;
  }

  let db: Db | undefined;
  try {
    db = dev ? await openDevDb() : openOwnerDb();
    if (dev) console.log("Using a throwaway in-memory database. Nothing here touches a hosted database.\n");
    switch (command.name) {
      case "migrate":
        await migrate(db);
        console.log("Schema applied. Every statement in schema.sql ran in one transaction.");
        return 0;
      case "budgets":
        return (await runBudgets(db)) ? 0 : 1;
      case "prune":
        return (await runPrune(db)) ? 0 : 1;
      case "flag":
        return (await runFlag(db, command.liveRuns)) ? 0 : 1;
      case "health":
        return (await runHealth(db)).ok ? 0 : 1;
      case "promote":
        return (await runPromote(db, command.runId, command.position, command.yes)) ? 0 : 1;
      case "unpromote":
        return (await runUnpromote(db, command.runId)) ? 0 : 1;
      case "showcase":
        return (await runShowcase(db)) ? 0 : 1;
      case "selftest":
        return (await runSelftest(db)) ? 0 : 1;
    }
    const unhandled: never = command;
    return unhandled;
  } catch (error) {
    console.error(messageOf(error));
    return 1;
  } finally {
    await db?.close().catch(() => {});
  }
}

process.exitCode = await main();
