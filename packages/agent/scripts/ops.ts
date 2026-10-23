// The operator's jobs, one command each. Every command prints a short plain
// report and exits 1 when it finds a problem, so it can run from a scheduler.
// They connect as the database owner (OWNER_DATABASE_URL), because the app
// role cannot set caps, flip the kill switch or the MCP switch, revoke agent
// keys, promote runs or delete rows (C6.3, C6.6, D1.6). bootstrap alone
// connects as the database superuser, once, to create that owner.
//
// Usage: npx tsx scripts/ops.ts [--dev | --tunnel <port>] <command>, see USAGE below.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadQlooConfig, type QlooConfig } from "../src/config.js";
import {
  authenticateToken,
  issueToken,
  listTokens,
  MCP_ENABLED_FLAG,
  mcpEnabled,
  revokeAllTokens,
  revokeToken,
  TOKEN_LIST_LIMIT,
} from "../src/mcp/tokens.js";
import {
  applyRoles,
  bootstrapOwner,
  hexPasswordFrom,
  OpsConfigError,
  openBootstrapDb,
  openDevDb,
  openOwnerDb,
  RoleSetupError,
  ROLES_FILE,
  tunnelPortFrom,
} from "../src/ops/db.js";
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
import { createSeedAgent, seedShow } from "../src/ops/seed.js";
import { loadAgentSettings } from "../src/server/config.js";
import { ServerError } from "../src/server/errors.js";
import { createRun, finishRun, listShowcase, putBoard, setRunStatus } from "../src/server/runs.js";
import type { Db } from "../src/store/db.js";
import { StoreError } from "../src/store/errors.js";
import { liveRunsEnabled, setFlag } from "../src/store/flags.js";
import { migrate } from "../src/store/migrate.js";

const POLICY_FILE = fileURLToPath(new URL("./budget-policy.json", import.meta.url));

const USAGE = `Usage: npx tsx scripts/ops.ts [--dev | --tunnel <port>] <command>

  bootstrap               once, as the database superuser: create the owner role vasal_owner
                          with the password in VASAL_OWNER_PASSWORD
  migrate                 apply src/store/schema.sql
  roles [--apply]         print roles.sql and the setup steps; with --apply, run it as the
                          owner and set vasal_app's password from VASAL_APP_PASSWORD
  budgets                 set today's caps from scripts/budget-policy.json (run daily, after
                          00:00 UTC; each window stays open until 02:00 UTC for a late run)
  prune                   delete expired cache rows, per-second buckets, old visitor and MCP
                          counters, and agent keys expired over a week that no run points to
  flag live-runs on|off   switch live runs on the site on or off
  flag mcp on|off         switch the MCP door on or off: key issue and every MCP request
  health                  print the health report
  mcp list                list agent keys: id, created, expires, revoked (never the key or its hash)
  mcp revoke <tokenId>    revoke one agent key at once
  mcp revoke-all          revoke every agent key at once
  promote <runId> <position> [--yes]
                          print a run's board; with --yes, put it on the home page at position 1 to 12
  seed "<show>" [--pick N]
                          preview the shows that match, writing nothing; with --pick, run the
                          real agent on candidate N and build a board for promote. It spends
                          only qloo:day:offline, qloo:month and anthropic:day:offline
  unpromote <runId>       take a run off the home page
  showcase                list the runs on the home page
  selftest                with --dev only: budgets, health, flag live-runs off, health, then
                          promote, list and unpromote a synthetic finished run, then flag mcp
                          on, mcp list, mcp revoke and mcp revoke-all on synthetic keys

--dev uses a throwaway in-memory database with the schema applied and live
runs on. Without it bootstrap needs BOOTSTRAP_DATABASE_URL, and every other
command except roles without --apply needs OWNER_DATABASE_URL.
--tunnel <port> connects to 127.0.0.1:<port> instead, through a tunnel to the
database PGDATABASE: bootstrap as PGUSER with PGPASSWORD, every other command
as vasal_owner with VASAL_OWNER_PASSWORD.
--yes is accepted only by promote, --apply only by roles, and --pick only by seed.`;

const PROMOTE_HINT = "Read the board above. Run again with --yes to put it on the home page.";

type PlainCommand = "bootstrap" | "migrate" | "budgets" | "prune" | "health" | "showcase" | "selftest";
// One member per name, so a check on the name narrows the whole command.
type Command =
  | { [Name in PlainCommand]: { name: Name } }[PlainCommand]
  | { name: "roles"; apply: boolean }
  | { name: "flag"; flag: Switch; on: boolean }
  | { name: "mcp"; action: "list" | "revoke-all" }
  | { name: "mcp"; action: "revoke"; tokenId: string }
  | { name: "promote"; runId: string; position: number; yes: boolean }
  | { name: "unpromote"; runId: string }
  | { name: "seed"; show: string; pick: number | undefined };

type Switch = "live-runs" | "mcp";
// Each switch the operator can flip, the app_flags row behind it, and how
// the read back is named in the report.
const SWITCHES: Record<Switch, { flag: string; label: string; read: (db: Db) => Promise<boolean> }> = {
  "live-runs": { flag: "live_runs", label: "Live runs", read: liveRunsEnabled },
  mcp: { flag: MCP_ENABLED_FLAG, label: "MCP", read: mcpEnabled },
};

// Digits only, so " 3", "3.0" and "0x3" are refused rather than read as 3.
const positionFrom = (text: string): number => (/^\d{1,2}$/.test(text) ? Number(text) : Number.NaN);
// A run stores at most 10 candidates (putCandidates), so no higher pick exists.
const MAX_PICK = 10;
// Counted in code points, the way createRun counts the show it is passed.
const MAX_SEED_SHOW_CHARS = 200;

const grouped = new Intl.NumberFormat("en-US");
const utc = (date: Date) => `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;

type Args = { dev: boolean; tunnelPort: number | undefined; command: Command };

// --tunnel is a connection, so it is refused with --dev and with the commands
// that never connect: roles without --apply, and selftest, which is --dev only.
export function readArgs(argv: string[]): Args | undefined {
  let parsed: {
    values: {
      dev?: boolean | undefined;
      yes?: boolean | undefined;
      apply?: boolean | undefined;
      tunnel?: string | undefined;
      pick?: string | undefined;
    };
    positionals: string[];
  };
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        dev: { type: "boolean", default: false },
        yes: { type: "boolean", default: false },
        apply: { type: "boolean", default: false },
        tunnel: { type: "string" },
        pick: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch {
    return undefined;
  }
  const dev = parsed.values.dev === true;
  let tunnelPort: number | undefined;
  if (parsed.values.tunnel !== undefined) {
    try {
      tunnelPort = tunnelPortFrom(parsed.values.tunnel);
    } catch {
      return undefined;
    }
  }
  if (dev && tunnelPort !== undefined) return undefined;
  const pick = parsed.values.pick === undefined ? undefined : positionFrom(parsed.values.pick);
  if (pick !== undefined && !(pick >= 1 && pick <= MAX_PICK)) return undefined;
  const command = readCommand(parsed.positionals, parsed.values.yes === true, parsed.values.apply === true, pick);
  if (command === undefined) return undefined;
  if (pick !== undefined && command.name !== "seed") return undefined;
  if (tunnelPort !== undefined && ((command.name === "roles" && !command.apply) || command.name === "selftest")) return undefined;
  return { dev, tunnelPort, command };
}

function readCommand(positionals: string[], yes: boolean, apply: boolean, pick: number | undefined): Command | undefined {
  const [name, ...rest] = positionals;
  if (name === "roles") return rest.length === 0 && !yes ? { name, apply } : undefined;
  if (name === "seed") {
    const [show] = rest;
    if (rest.length !== 1 || show === undefined || yes || apply) return undefined;
    // The same normalising the website's run body applies (app.ts), so both
    // doors hand the agent the same text for the same typed name.
    const text = show.normalize("NFC").trim();
    if (text === "" || [...text].length > MAX_SEED_SHOW_CHARS) return undefined;
    return { name, show: text, pick };
  }
  if (apply) return undefined;
  if (name === "promote") {
    const [runId, position] = rest;
    if (rest.length !== 2 || runId === undefined || position === undefined) return undefined;
    return { name, runId, position: positionFrom(position), yes };
  }
  if (yes) return undefined;
  if (name === "unpromote") {
    const [runId] = rest;
    if (rest.length !== 1 || runId === undefined) return undefined;
    return { name, runId };
  }
  if (name === "flag") {
    const [flag, state] = rest;
    if (rest.length !== 2 || (flag !== "live-runs" && flag !== "mcp") || (state !== "on" && state !== "off")) return undefined;
    return { name, flag, on: state === "on" };
  }
  if (name === "mcp") {
    const [action, tokenId] = rest;
    if ((action === "list" || action === "revoke-all") && rest.length === 1) return { name, action };
    if (action === "revoke" && rest.length === 2 && tokenId !== undefined) return { name, action, tokenId };
    return undefined;
  }
  if (rest.length !== 0) return undefined;
  if (
    name === "bootstrap" ||
    name === "migrate" ||
    name === "budgets" ||
    name === "prune" ||
    name === "health" ||
    name === "showcase" ||
    name === "selftest"
  ) {
    return { name };
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
  console.log(
    `Pruned ${grouped.format(counts.mcpTokens)} agent keys expired over a week, ${grouped.format(counts.mcpTokenDaily)} old agent key counters and ${grouped.format(counts.mcpKeyIssue)} old key-issue counters.`,
  );
  return true;
}

async function runFlag(db: Db, which: Switch, on: boolean): Promise<boolean> {
  const { flag, label, read } = SWITCHES[which];
  await setFlag(db, flag, on);
  const readBack = await read(db);
  console.log(`${label} ${which === "mcp" ? "is" : "are"} now ${readBack ? "on" : "off"}.`);
  if (readBack === on) return true;
  printProblems([`The flag was set ${on ? "on" : "off"} but reads back ${readBack ? "on" : "off"}.`]);
  return false;
}

// Lists ids and times only. A key's hash is never printed, and the key itself
// is never stored anywhere this could read it from (D1.1, D1.4).
async function runMcpList(db: Db): Promise<boolean> {
  const { total, tokens } = await listTokens(db);
  const shown = total > TOKEN_LIST_LIMIT ? `, showing the newest ${grouped.format(TOKEN_LIST_LIMIT)}` : "";
  console.log(`${grouped.format(total)} agent ${total === 1 ? "key" : "keys"}${shown}${total === 0 ? "." : ":"}`);
  for (const token of tokens) {
    console.log(`  ${token.id}  created ${utc(token.createdAt)}  expires ${utc(token.expiresAt)}  ${token.revoked ? "revoked" : "active"}`);
  }
  const unreadable = Math.min(total, TOKEN_LIST_LIMIT) - tokens.length;
  if (unreadable <= 0) return true;
  printProblems([`${grouped.format(unreadable)} key rows could not be read and were left out.`]);
  return false;
}

const TOKEN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function runMcpRevoke(db: Db, tokenId: string): Promise<boolean> {
  if (!TOKEN_ID.test(tokenId)) {
    console.log("That is not a key id. Copy the id from mcp list: lower-case letters, digits and dashes.");
    return false;
  }
  if (!(await revokeToken(db, tokenId))) {
    printProblems([`No agent key has the id ${tokenId}.`]);
    return false;
  }
  console.log(`Agent key ${tokenId} is revoked. Its next request is refused.`);
  return true;
}

async function runMcpRevokeAll(db: Db): Promise<boolean> {
  const changed = await revokeAllTokens(db);
  console.log(`Revoked ${grouped.format(changed)} agent ${changed === 1 ? "key" : "keys"}. Every key is now refused.`);
  return true;
}

async function runHealth(db: Db): Promise<{ ok: boolean; problems: string[] }> {
  const report = await healthReport(db, new Date());
  for (const line of formatHealth(report)) console.log(line);
  return { ok: report.problems.length === 0, problems: report.problems };
}

function runRoles(): boolean {
  console.log(readFileSync(ROLES_FILE, "utf8").trimEnd());
  console.log("");
  console.log("This command only prints. To set the roles up, run these from packages/agent, in order:");
  for (const step of [
    "1. Make two passwords, VASAL_OWNER_PASSWORD and VASAL_APP_PASSWORD, each with: node -e \"console.log(require('node:crypto').randomBytes(32).toString('hex'))\"",
    "2. Once, as the database superuser: npx tsx scripts/ops.ts bootstrap, with BOOTSTRAP_DATABASE_URL set, or --tunnel <port> with PGUSER, PGPASSWORD and PGDATABASE. It creates the owner role vasal_owner.",
    "3. As vasal_owner, from OWNER_DATABASE_URL or --tunnel <port>: npx tsx scripts/ops.ts migrate, so the owner owns every table.",
    "4. As vasal_owner: npx tsx scripts/ops.ts roles --apply. It runs the SQL above and sets vasal_app's password as a SCRAM verifier made on this machine, so the password itself never reaches the server.",
    "5. Give the web and agent servers DATABASE_URL with user vasal_app, VASAL_APP_PASSWORD, and the same host and database. The owner's string stays with these commands only.",
    "6. npx tsx scripts/ops.ts health",
  ]) {
    console.log(`  ${step}`);
  }
  return true;
}

// Prints what was done in fixed words. The password, the verifier and the
// connection string are never printed.
async function runBootstrap(db: Db): Promise<boolean> {
  const password = hexPasswordFrom(process.env, "VASAL_OWNER_PASSWORD");
  const { created } = await bootstrapOwner(db, password);
  console.log(
    created
      ? "Created the role vasal_owner: LOGIN and CREATEROLE, with no SUPERUSER, CREATEDB, REPLICATION or BYPASSRLS."
      : "The role vasal_owner already existed with the right attributes, so it was kept.",
  );
  console.log("Set the password of vasal_owner from VASAL_OWNER_PASSWORD.");
  console.log("Granted USAGE and CREATE on schema public to vasal_owner.");
  return true;
}

async function runApplyRoles(db: Db): Promise<boolean> {
  const password = hexPasswordFrom(process.env, "VASAL_APP_PASSWORD");
  const { created } = await applyRoles(db, password);
  console.log(
    `Applied src/store/roles.sql as one batch: ${created ? "created the role vasal_app" : "the role vasal_app already existed with the right attributes and was kept"}, and set its grants.`,
  );
  console.log("Set the password of vasal_app from VASAL_APP_PASSWORD.");
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

// Show names and publishers come from Apple and Qloo. Control characters (an
// escape starts a terminal command) and format characters (direction and
// invisible ones) are removed and the text is cut, so that text cannot drive
// the operator's terminal or hide part of itself (C3.6). The board lines get
// formatPreview's own rule in promote.ts.
const MAX_PRINTED_NAME_CHARS = 120;
const printableName = (text: string): string =>
  [...text.replace(/[\p{Cc}\p{Cf}]/gu, "")].slice(0, MAX_PRINTED_NAME_CHARS).join("");

async function runSeed(db: Db, show: string, pick: number | undefined): Promise<boolean> {
  let qloo: QlooConfig;
  try {
    qloo = loadQlooConfig();
  } catch (error) {
    // loadQlooConfig's messages name a variable, never its value.
    console.log(error instanceof Error ? error.message : "The Qloo settings could not be read.");
    return false;
  }
  const settings = loadAgentSettings(process.env);
  if (qloo.apiKey === undefined || settings.anthropicApiKey === null) {
    console.log("seed needs QLOO_API_KEY and ANTHROPIC_API_KEY in the environment or the repo-root .env.");
    return false;
  }
  console.log(
    `Seeding with ${settings.model}, effort ${settings.effort}, trends ${settings.trends ? "on" : "off"}. Qloo calls charge qloo:day:offline and qloo:month; model tokens charge anthropic:day:offline.`,
  );
  const agent = createSeedAgent(db, {
    qlooApiKey: qloo.apiKey,
    qlooBaseUrl: qloo.baseUrl,
    anthropicApiKey: settings.anthropicApiKey,
    model: settings.model,
    effort: settings.effort,
    trends: settings.trends,
  });
  const outcome = await seedShow(db, agent, show, pick);

  if (outcome.kind === "preview") {
    console.log(`Candidates for "${printableName(show)}". No run was written.`);
    for (const candidate of outcome.candidates) {
      console.log(
        `  ${candidate.rank}. ${printableName(candidate.name)} by ${printableName(candidate.publisher)} (Qloo: ${printableName(candidate.qlooName)})`,
      );
    }
    console.log("Run again with --pick <number> to research one and build its board.");
    return true;
  }
  if (outcome.kind === "failed") {
    console.log(`The seed run ${outcome.runId ?? "(none)"} failed with ${outcome.code}.`);
    return false;
  }

  console.log(
    `Run ${outcome.runId} finished with ${outcome.guests} guests on the board, from candidate ${outcome.picked.rank}: ${printableName(outcome.picked.name)}.`,
  );
  if (outcome.pastGuests !== null) {
    console.log(
      outcome.pastGuests.checked
        ? `Left out ${outcome.pastGuests.skipped} ${outcome.pastGuests.skipped === 1 ? "person who has" : "people who have"} been on the show before.`
        : "Past guests were not checked: the show's feed could not be read.",
    );
  }
  // The same board and refusal runPromote prints without --yes, then the
  // command that promotes it.
  const preview = await previewRun(db, outcome.runId);
  for (const line of formatPreview(preview)) console.log(line);
  if (preview.refusal !== null) return false;
  console.log("");
  console.log(`Put it on the home page: npx tsx scripts/ops.ts promote ${outcome.runId} <position> --yes`);
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

// Prints as usual and also hands back what was printed, so the self-test can
// check the operator's view itself, not only the data behind it.
async function printed<T>(work: () => Promise<T>): Promise<{ result: T; text: string }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
    original(...args);
  };
  try {
    return { result: await work(), text: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

// Two synthetic keys issued inside this process. Neither key is ever printed;
// they exist only so the commands have something to list and revoke.
async function selftestMcp(db: Db): Promise<string[]> {
  const failures: string[] = [];
  console.log("$ ops --dev flag mcp on");
  if (!(await runFlag(db, "mcp", true))) failures.push("MCP did not switch on");
  const kept = await issueToken(db);
  const leaked = await issueToken(db);

  console.log("");
  console.log("$ ops --dev mcp list");
  const list = await printed(() => runMcpList(db));
  if (!list.result || !list.text.includes(kept.id) || !list.text.includes(leaked.id)) failures.push("mcp list did not show both keys");
  if (/vsl_|[0-9a-f]{64}/.test(list.text)) failures.push("mcp list printed a key or a hash");

  console.log("");
  console.log(`$ ops --dev mcp revoke ${leaked.id}`);
  if (!(await runMcpRevoke(db, leaked.id))) failures.push("mcp revoke reported a problem");
  if ((await authenticateToken(db, leaked.token)) !== null) failures.push("the revoked key still worked");
  if ((await authenticateToken(db, kept.token))?.id !== kept.id) failures.push("revoking one key stopped the other");

  console.log("");
  console.log("$ ops --dev mcp revoke-all");
  if (!(await runMcpRevokeAll(db))) failures.push("mcp revoke-all reported a problem");
  if ((await authenticateToken(db, kept.token)) !== null) failures.push("a key still worked after revoke-all");

  console.log("");
  console.log("$ ops --dev health");
  const health = await printed(() => runHealth(db));
  if (!health.text.includes("  MCP: on") || !health.text.includes("  Agent keys: 0 live, 2 revoked")) {
    failures.push("health did not show MCP on with 2 revoked keys");
  }

  console.log("");
  console.log("$ ops --dev flag mcp off");
  if (!(await runFlag(db, "mcp", false))) failures.push("MCP did not switch off");
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
  if (!(await runFlag(db, "live-runs", false))) failures.push("live runs did not switch off");
  console.log("");
  console.log("$ ops --dev health");
  const second = await runHealth(db);
  const expected = ["Live runs are off, so the site shows saved runs only."];
  if (JSON.stringify(second.problems) !== JSON.stringify(expected)) failures.push("the second health check did not report live runs off, alone");
  console.log("");
  failures.push(...(await selftestShowcase(db)));
  console.log("");
  failures.push(...(await selftestMcp(db)));
  console.log("");
  if (failures.length === 0) {
    console.log(
      "Self-test passed: budgets set cleanly, health was clean, health flagged live runs once they were off, a synthetic finished run went on the home page and came off again, and MCP switched on, listed two synthetic keys with no hash, revoked one, then all, and switched off.",
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
  if (
    error instanceof OpsConfigError ||
    error instanceof RoleSetupError ||
    error instanceof StoreError ||
    error instanceof ServerError ||
    error instanceof PromoteError
  ) {
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
  const { dev, tunnelPort, command } = args;
  if (command.name === "roles" && !command.apply) return runRoles() ? 0 : 1;
  if (command.name === "selftest" && !dev) {
    console.error("selftest switches live runs off, so it runs only with --dev.");
    return 2;
  }
  if (dev && (command.name === "bootstrap" || command.name === "roles")) {
    console.error("bootstrap and roles --apply set up roles on a hosted database, so they never run with --dev.");
    return 2;
  }
  if (dev && command.name === "seed") {
    console.error("seed builds showcase runs on the hosted database, so it never runs with --dev.");
    return 2;
  }

  const connection = tunnelPort === undefined ? {} : { tunnelPort };
  let db: Db | undefined;
  try {
    if (dev) db = await openDevDb();
    else db = command.name === "bootstrap" ? openBootstrapDb(process.env, connection) : openOwnerDb(process.env, connection);
    if (dev) console.log("Using a throwaway in-memory database. Nothing here touches a hosted database.\n");
    switch (command.name) {
      case "bootstrap":
        return (await runBootstrap(db)) ? 0 : 1;
      case "roles":
        return (await runApplyRoles(db)) ? 0 : 1;
      case "migrate":
        await migrate(db);
        console.log("Schema applied. Every statement in schema.sql ran in one transaction.");
        return 0;
      case "budgets":
        return (await runBudgets(db)) ? 0 : 1;
      case "prune":
        return (await runPrune(db)) ? 0 : 1;
      case "flag":
        return (await runFlag(db, command.flag, command.on)) ? 0 : 1;
      case "mcp":
        if (command.action === "list") return (await runMcpList(db)) ? 0 : 1;
        if (command.action === "revoke") return (await runMcpRevoke(db, command.tokenId)) ? 0 : 1;
        return (await runMcpRevokeAll(db)) ? 0 : 1;
      case "health":
        return (await runHealth(db)).ok ? 0 : 1;
      case "promote":
        return (await runPromote(db, command.runId, command.position, command.yes)) ? 0 : 1;
      case "unpromote":
        return (await runUnpromote(db, command.runId)) ? 0 : 1;
      case "showcase":
        return (await runShowcase(db)) ? 0 : 1;
      case "seed":
        return (await runSeed(db, command.show, command.pick)) ? 0 : 1;
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

const OPS_TIME_LIMIT_MS = 10 * 60 * 1_000;

/**
 * Runs `work` and always ends the process, so a scheduled job can never hang
 * on a stuck connection: it exits with the code `work` returns, with 1 and
 * one fixed UNEXPECTED line if `work` throws, and with 1 and one OPS_TIMEOUT
 * line if `work` has not settled within `limitMs` (default 10 minutes). The
 * timer is unref'd, so it never holds a finished process open, and `exit`
 * (default process.exit) is called once. Neither line holds an error message.
 */
export async function runToExit(
  work: () => Promise<number>,
  opts: { limitMs?: number; exit?: (code: number) => void } = {},
): Promise<void> {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let exited = false;
  const exitOnce = (code: number): void => {
    if (exited) return;
    exited = true;
    clearTimeout(timer);
    exit(code);
  };
  const timer = setTimeout(() => {
    console.error(JSON.stringify({ level: "error", route: "ops", code: "OPS_TIMEOUT" }));
    exitOnce(1);
  }, opts.limitMs ?? OPS_TIME_LIMIT_MS);
  timer.unref();

  let code: number;
  try {
    code = await work();
  } catch {
    console.error(JSON.stringify({ level: "error", route: "ops", code: "UNEXPECTED" }));
    code = 1;
  }
  // process.exit can cut off output still queued for a terminal, so it waits
  // for both streams to take what was written. The timer stays armed in case
  // a stream never drains.
  process.stdout.write("", () => process.stderr.write("", () => exitOnce(code)));
}

if (import.meta.main) await runToExit(main);
