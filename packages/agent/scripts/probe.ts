// Key-day probe: does Qloo hold the podcast, guest and audience data Vasal
// needs? Prints a coverage table. Raw responses go only to the git-ignored
// data/probe folder, because Qloo's terms forbid its data in a public repo.
//
// Usage: npm run probe -- [--dry-run] [--limit N] [--max-calls N]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { loadQlooConfig, type QlooConfig } from "../src/config.js";
import { createQlooClient } from "../src/qloo/client.js";
import { QlooError, type QlooErrorCode } from "../src/qloo/errors.js";
import { startHarness, type QlooHarness } from "../src/qloo/harness.js";
import { buildQlooRequest, type BuiltRequest, type EntityType, type QlooOperation } from "../src/qloo/request.js";
import type { QlooCompareResult, QlooDemographic, QlooEntity, QlooTrendRow } from "../src/qloo/schemas.js";

const NO_KEY_MESSAGE = "QLOO_API_KEY is not set. Add it to .env (see .env.example).";
const USAGE = "Usage: npm run probe -- [--dry-run] [--limit N] [--max-calls N]";

const PODCAST: EntityType = "urn:entity:podcast";
const PERSON: EntityType = "urn:entity:person";
const DEFAULT_MAX_CALLS = 450;
const LIST_TAKE = 20;
const TOP_PEOPLE = 3;
const TREND_WEEKS = 12;
// Each request starts at least 500 ms after the last, so the probe sends 2
// a second or fewer. The live server takes 8 of Qloo's 10 a second, and an
// offline script outside the hosted meter takes the other 2. Client retries
// and the harness's own calls do not wait for this gap.
const MIN_GAP_MS = 500;
// qloo_recommend with an id signal makes one /entities lookup and one
// /v2/insights call inside the harness, each with up to 3 attempts.
const HARNESS_RECOMMEND_RESERVE = 6;
const DAY_MS = 86_400_000;

const SHOWS_FILE = fileURLToPath(new URL("./probe-shows.json", import.meta.url));
const PROBE_DATA_DIR = fileURLToPath(new URL("../data/probe", import.meta.url));

const ShowsSchema = z.array(z.object({ name: z.string().min(1).max(300) }).strict()).min(1);
type Show = z.infer<typeof ShowsSchema>[number];

type Failure = { kind: "error"; code: QlooErrorCode; status?: number } | { kind: "budget" };
type Outcome<T> = { kind: "ok"; data: T } | { kind: "planned" } | Failure;

const isFailure = <T>(outcome: Outcome<T>): outcome is Failure => outcome.kind === "error" || outcome.kind === "budget";

function readArgs(argv: string[]): { dryRun: boolean; limit: number | undefined; maxCalls: number } | undefined {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        "dry-run": { type: "boolean", default: false },
        limit: { type: "string" },
        "max-calls": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    });
    const count = z.coerce.number().int().min(1).max(10_000);
    return {
      dryRun: values["dry-run"],
      limit: values.limit === undefined ? undefined : count.parse(values.limit),
      maxCalls: values["max-calls"] === undefined ? DEFAULT_MAX_CALLS : count.parse(values["max-calls"]),
    };
  } catch {
    return undefined;
  }
}

// ISO weeks, Monday to Sunday, ending with the last week that has finished.
function lastFullWeeks(weeks: number, now: Date): { startDate: string; endDate: string } {
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const thisMondayMs = todayMs - ((now.getUTCDay() + 6) % 7) * DAY_MS;
  const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { startDate: isoDate(thisMondayMs - weeks * 7 * DAY_MS), endDate: isoDate(thisMondayMs - DAY_MS) };
}

const normaliseName = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

function failureCell(outcome: Failure): string {
  if (outcome.kind === "budget") return "budget";
  return outcome.status !== undefined ? String(outcome.status) : outcome.code.replace(/^QLOO_/, "").toLowerCase();
}

const withFailures = (cell: string, failures: string[]) =>
  failures.length === 0 ? cell : `${cell} (${[...new Set(failures)].join(",")})`;

function describeRequest(request: BuiltRequest): string {
  return `${request.method} ${request.path}  ${request.params.map(([key, value]) => `${key}=${value}`).join(" ")}`;
}

class RequestBudget {
  used = 0;
  constructor(readonly max: number) {}
  take(count: number): boolean {
    if (this.used + count > this.max) return false;
    this.used += count;
    return true;
  }
}

type Capture = { status: number | undefined; body: string | undefined; refused: boolean };

// Every HTTP attempt passes here, retries included, so the hard stop counts
// what Qloo actually receives. The raw body is kept for the data folder even
// when the client later rejects it as QLOO_SCHEMA.
function countedFetch(budget: RequestBudget, capture: Capture): typeof fetch {
  const counted: typeof fetch = async (input, init) => {
    if (!budget.take(1)) {
      capture.refused = true;
      throw new Error("request budget exhausted");
    }
    const response = await fetch(input, init);
    capture.status = response.status;
    capture.body = await response.clone().text();
    return response;
  };
  return counted;
}

function decodeBody(body: string | undefined): unknown {
  if (body === undefined) return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

type Row = Record<(typeof COLUMNS)[number][0], string>;

const COLUMNS = [
  ["show", "show"],
  ["found", "podcast found"],
  ["matched", "name matched"],
  ["people", "people returned"],
  ["popularity", "popularity filter changed results"],
  ["demographics", "demographics ok"],
  ["trending", "trending ok"],
  ["compare", "compare ok"],
  ["upcoming", "upcoming releases"],
] as const;

function renderTable(rows: Row[]): string {
  const widths = COLUMNS.map(([key, title]) => Math.max(title.length, ...rows.map((row) => row[key].length)));
  const line = (cells: string[]) =>
    cells
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join(" | ")
      .trimEnd();
  return [
    line(COLUMNS.map(([, title]) => title)),
    widths.map((width) => "-".repeat(width)).join("-+-"),
    ...rows.map((row) => line(COLUMNS.map(([key]) => row[key]))),
  ].join("\n");
}

const RecommendInput = z
  .object({
    properties: z
      .object({
        target_type: z.object({ enum: z.array(z.string()) }).passthrough(),
        signals: z
          .object({ type: z.literal("array"), items: z.object({ type: z.literal("string") }).passthrough() })
          .passthrough(),
        limit: z.object({ maximum: z.number().optional() }).passthrough().optional(),
      })
      .passthrough(),
  })
  .passthrough();

// Built from the schema the harness advertises, so a contract change shows
// up here as a clear skip instead of a rejected call.
function recommendArgs(tool: Tool, signal: string): Record<string, unknown> | undefined {
  const schema = RecommendInput.safeParse(tool.inputSchema);
  if (!schema.success) return undefined;
  const targetType = schema.data.properties.target_type.enum.find((value) => value === "person" || value === PERSON);
  if (targetType === undefined) return undefined;
  const limit = schema.data.properties.limit;
  return {
    target_type: targetType,
    signals: [signal],
    ...(limit === undefined ? {} : { limit: Math.min(5, limit.maximum ?? 5) }),
  };
}

const ToolEnvelope = z
  .object({
    structuredContent: z
      .object({
        status: z.string().optional(),
        result_count: z.number().optional(),
        error: z.object({ code: z.string().optional() }).passthrough().optional(),
        provenance: z.object({ requests: z.array(z.unknown()).optional() }).passthrough().optional(),
        adapter: z.object({ ready: z.boolean().optional() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

async function main(): Promise<number> {
  const options = readArgs(process.argv.slice(2));
  if (options === undefined) {
    console.error(USAGE);
    return 2;
  }
  const { dryRun, limit, maxCalls } = options;
  const shows = ShowsSchema.parse(JSON.parse(readFileSync(SHOWS_FILE, "utf8"))).slice(0, limit);

  let config: QlooConfig;
  try {
    config = loadQlooConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Qloo settings are invalid.");
    return 1;
  }
  if (!dryRun && config.apiKey === undefined) {
    console.error(NO_KEY_MESSAGE);
    return 1;
  }
  const baseUrl = config.baseUrl;

  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const trendWindow = lastFullWeeks(TREND_WEEKS, now);

  const budget = new RequestBudget(maxCalls);
  const capture: Capture = { status: undefined, body: undefined, refused: false };
  const client =
    dryRun || config.apiKey === undefined
      ? undefined
      : createQlooClient({ apiKey: config.apiKey, baseUrl, fetchImpl: countedFetch(budget, capture) });
  const runDir = join(PROBE_DATA_DIR, now.toISOString().replace(/[:.]/g, "-"));
  if (client !== undefined) mkdirSync(runDir, { recursive: true });

  let sequence = 0;
  let plannedRequests = 0;
  let lastStartMs = 0;
  let stoppedByBudget = false;
  let harnessReserved = 0;
  let harnessReported = 0;
  const onceOnlyLines: string[] = [];

  const saveRaw = (label: string, record: Record<string, unknown>) => {
    const file = join(runDir, `${String(sequence).padStart(3, "0")}-${slug(label)}.json`);
    writeFileSync(file, `${JSON.stringify({ label, ...record }, null, 2)}\n`);
  };

  const run = async <T>(label: string, op: QlooOperation): Promise<Outcome<T>> => {
    sequence += 1;
    let request: BuiltRequest;
    try {
      request = buildQlooRequest(baseUrl, op);
    } catch (error) {
      if (client === undefined) throw error;
      return { kind: "error", code: "QLOO_BAD_INPUT" };
    }
    if (client === undefined) {
      plannedRequests += 1;
      console.log(`${String(sequence).padStart(4)}  ${describeRequest(request)}   [${label}]`);
      return { kind: "planned" };
    }
    if (stoppedByBudget || budget.used >= budget.max) {
      stoppedByBudget = true;
      return { kind: "budget" };
    }

    const waitMs = lastStartMs + MIN_GAP_MS - Date.now();
    if (waitMs > 0) await delay(waitMs);
    lastStartMs = Date.now();
    capture.status = undefined;
    capture.body = undefined;
    capture.refused = false;

    const logged = { request: { path: request.path, params: request.params } };
    try {
      const result = await client.call<T>(op);
      saveRaw(label, { ...logged, outcome: "ok", httpStatus: result.status, body: decodeBody(capture.body) });
      return { kind: "ok", data: result.data };
    } catch (error) {
      if (!(error instanceof QlooError)) throw error;
      saveRaw(label, { ...logged, outcome: error.code, httpStatus: capture.status, body: decodeBody(capture.body) });
      if (capture.refused) {
        stoppedByBudget = true;
        return { kind: "budget" };
      }
      return error.status === undefined
        ? { kind: "error", code: error.code }
        : { kind: "error", code: error.code, status: error.status };
    }
  };

  const tally = {
    found: 0,
    matched: 0,
    withPeople: 0,
    popularityCompared: 0,
    popularityChanged: 0,
    podcastDemographicsOk: 0,
    podcastDemographicsTried: 0,
    peopleDemographicsOk: 0,
    peopleTried: 0,
    trendingOk: 0,
    compareOk: 0,
    compareTried: 0,
    upcoming: 0,
  };

  const probeShow = async (show: Show, index: number): Promise<{ row: Row; podcastId: string | undefined }> => {
    const row: Row = {
      show: show.name,
      found: "-",
      matched: "-",
      people: "-",
      popularity: "-",
      demographics: "-",
      trending: "-",
      compare: "-",
      upcoming: "-",
    };
    const tag = `${show.name}:`;

    const search = await run<QlooEntity[]>(`${tag} search`, { op: "search", query: show.name, types: [PODCAST], take: 5 });
    let podcastId: string | undefined;
    if (search.kind === "planned") {
      podcastId = `PLACEHOLDER-PODCAST-${index + 1}`;
    } else if (search.kind === "ok") {
      const top = search.data[0];
      row.found = top === undefined ? "no" : "yes";
      if (top !== undefined) {
        podcastId = top.entity_id;
        tally.found += 1;
        const matched = normaliseName(top.name) === normaliseName(show.name);
        row.matched = matched ? "yes" : "no";
        if (matched) tally.matched += 1;
      }
    } else {
      row.found = failureCell(search);
    }
    if (podcastId === undefined) return { row, podcastId };

    const peopleOp: QlooOperation = {
      op: "insights",
      filterType: PERSON,
      signalEntities: [podcastId],
      take: LIST_TAKE,
      explainability: true,
    };
    const people = await run<QlooEntity[]>(`${tag} people`, peopleOp);
    const capped = await run<QlooEntity[]>(`${tag} people popularity max 0.8`, { ...peopleOp, popularityMax: 0.8 });

    let topPeople: string[] = [];
    if (people.kind === "planned") {
      topPeople = Array.from({ length: TOP_PEOPLE }, (_, k) => `PLACEHOLDER-PERSON-${index + 1}-${k + 1}`);
    } else if (people.kind === "ok") {
      row.people = String(people.data.length);
      if (people.data.length > 0) tally.withPeople += 1;
      topPeople = people.data.slice(0, TOP_PEOPLE).map((person) => person.entity_id);
    } else {
      row.people = failureCell(people);
    }
    if (people.kind === "ok" && capped.kind === "ok") {
      const ids = (list: QlooEntity[]) => list.map((entity) => entity.entity_id).join(",");
      const changed = ids(people.data) !== ids(capped.data);
      tally.popularityCompared += 1;
      if (changed) tally.popularityChanged += 1;
      row.popularity =
        people.data.length === 0 && capped.data.length === 0 ? "no (both empty)" : changed ? "yes" : "no";
    } else if (isFailure(capped)) {
      row.popularity = failureCell(capped);
    }

    const podcastDemographics = await run<QlooDemographic[]>(`${tag} podcast demographics`, {
      op: "demographics",
      signalEntities: [podcastId],
    });
    let podcastCell = "-";
    if (podcastDemographics.kind === "ok") {
      tally.podcastDemographicsTried += 1;
      const ok = podcastDemographics.data.length > 0;
      if (ok) tally.podcastDemographicsOk += 1;
      podcastCell = ok ? "Y" : "0";
    } else if (isFailure(podcastDemographics)) {
      tally.podcastDemographicsTried += 1;
      podcastCell = failureCell(podcastDemographics);
    }

    let demographicsOk = 0;
    let trendingOk = 0;
    const demographicsFailures: string[] = [];
    const trendingFailures: string[] = [];
    for (const [k, personId] of topPeople.entries()) {
      const demographics = await run<QlooDemographic[]>(`${tag} person ${k + 1} demographics`, {
        op: "demographics",
        signalEntities: [personId],
      });
      const trending = await run<QlooTrendRow[]>(`${tag} person ${k + 1} trending`, {
        op: "trending",
        filterType: PERSON,
        entity: personId,
        ...trendWindow,
      });
      if (demographics.kind === "ok" && demographics.data.length > 0) demographicsOk += 1;
      if (trending.kind === "ok" && trending.data.length > 0) trendingOk += 1;
      if (isFailure(demographics)) demographicsFailures.push(failureCell(demographics));
      if (isFailure(trending)) trendingFailures.push(failureCell(trending));
    }
    if (people.kind === "ok") {
      tally.peopleTried += topPeople.length;
      tally.peopleDemographicsOk += demographicsOk;
      tally.trendingOk += trendingOk;
      row.demographics = withFailures(`${podcastCell} ${demographicsOk}/${topPeople.length}`, demographicsFailures);
      row.trending = withFailures(`${trendingOk}/${topPeople.length}`, trendingFailures);
    } else {
      row.demographics = `${podcastCell} -`;
    }

    const topPerson = topPeople[0];
    if (topPerson !== undefined) {
      const compare = await run<QlooCompareResult>(`${tag} compare podcast vs top person`, {
        op: "compare",
        a: [podcastId],
        b: [topPerson],
        take: 10,
      });
      if (compare.kind === "ok") {
        tally.compareTried += 1;
        if (compare.data.tags.length > 0) tally.compareOk += 1;
        row.compare = compare.data.tags.length > 0 ? "Y" : "0";
      } else if (isFailure(compare)) {
        tally.compareTried += 1;
        row.compare = failureCell(compare);
      }
    }

    const upcomingOps: Array<[string, QlooOperation]> = [
      ["movies", { op: "insights", filterType: "urn:entity:movie", signalEntities: [podcastId], take: LIST_TAKE, releaseYearMin: currentYear }],
      ["tv shows", { op: "insights", filterType: "urn:entity:tv_show", signalEntities: [podcastId], take: LIST_TAKE, releaseYearMin: currentYear }],
      ["books", { op: "insights", filterType: "urn:entity:book", signalEntities: [podcastId], take: LIST_TAKE, publicationYearMin: currentYear }],
    ];
    const upcomingCells: string[] = [];
    let upcomingTotal = 0;
    for (const [what, op] of upcomingOps) {
      const outcome = await run<QlooEntity[]>(`${tag} upcoming ${what}`, op);
      if (outcome.kind === "ok") {
        upcomingTotal += outcome.data.length;
        upcomingCells.push(String(outcome.data.length));
      } else if (isFailure(outcome)) {
        upcomingCells.push(failureCell(outcome));
      }
    }
    if (upcomingCells.length > 0) {
      tally.upcoming += upcomingTotal;
      row.upcoming = `${upcomingTotal} (${upcomingCells.join("/")})`;
    }

    return { row, podcastId };
  };

  const checkGameSpelling = async (signal: string | undefined) => {
    for (const spelling of ["urn:entity:videogame", "urn:entity:video_game"] as const) {
      if (signal === undefined) {
        onceOnlyLines.push(`${spelling}: skipped, the first show has no podcast id`);
        continue;
      }
      const outcome = await run<QlooEntity[]>(`game type ${spelling}`, {
        op: "insights",
        filterType: spelling,
        signalEntities: [signal],
        take: 5,
      });
      if (outcome.kind === "ok") {
        onceOnlyLines.push(`${spelling}: accepted, ${outcome.data.length} results`);
      } else if (isFailure(outcome)) {
        const refused = outcome.kind === "error" && outcome.code === "QLOO_FORBIDDEN_TYPE";
        onceOnlyLines.push(`${spelling}: ${refused ? "refused with 403" : `failed, ${failureCell(outcome)}`}`);
      }
    }
  };

  const checkHarness = async (show: Show, podcastId: string | undefined) => {
    const signal = podcastId ?? show.name;
    if (client === undefined) {
      onceOnlyLines.push("harness: start qloo mcp and call qloo_capabilities (no Qloo request)");
      onceOnlyLines.push(
        `harness: call qloo_recommend, target_type person, signals [${signal}], up to ${HARNESS_RECOMMEND_RESERVE} Qloo requests reserved`,
      );
      return;
    }
    let harness: QlooHarness;
    try {
      harness = await startHarness(config);
    } catch (error) {
      onceOnlyLines.push(`harness: failed to start (${error instanceof QlooError ? error.code : "unexpected error"})`);
      return;
    }
    try {
      const tools = await harness.listTools();
      const capabilities = ToolEnvelope.safeParse(await harness.callTool("qloo_capabilities", {}));
      const ready = capabilities.success ? capabilities.data.structuredContent?.adapter?.ready : undefined;
      onceOnlyLines.push(`harness: ${tools.length} allowed tools listed, qloo_capabilities ready=${String(ready ?? "unknown")}`);

      const tool = tools.find((candidate) => candidate.name === "qloo_recommend");
      const toolArgs = tool === undefined ? undefined : recommendArgs(tool, signal);
      if (toolArgs === undefined) {
        onceOnlyLines.push("harness: qloo_recommend skipped, its advertised input schema has no person target");
        return;
      }
      if (stoppedByBudget || !budget.take(HARNESS_RECOMMEND_RESERVE)) {
        onceOnlyLines.push("harness: qloo_recommend skipped, not enough budget left");
        return;
      }
      harnessReserved = HARNESS_RECOMMEND_RESERVE;
      sequence += 1;
      const raw = await harness.callTool("qloo_recommend", toolArgs);
      saveRaw(`harness qloo_recommend ${show.name}`, { tool: "qloo_recommend", arguments: toolArgs, body: raw });
      const envelope = ToolEnvelope.safeParse(raw);
      const content = envelope.success ? envelope.data.structuredContent : undefined;
      harnessReported = content?.provenance?.requests?.length ?? 0;
      const failure = content?.error?.code === undefined ? "" : `, error ${content.error.code}`;
      onceOnlyLines.push(
        `harness: qloo_recommend status ${content?.status ?? "unknown"}, ${content?.result_count ?? 0} results${failure}, ${harnessReported} Qloo requests reported`,
      );
    } catch (error) {
      onceOnlyLines.push(`harness: call failed (${error instanceof QlooError ? error.code : "unexpected error"})`);
    } finally {
      await harness.close();
    }
  };

  console.log(
    client === undefined
      ? `Dry run: planned Qloo operations for ${shows.length} shows. No network call is made.`
      : `Probing ${shows.length} shows on ${baseUrl.host}, hard stop at ${maxCalls} requests.`,
  );

  const rows: Row[] = [];
  for (const [index, show] of shows.entries()) {
    const { row, podcastId } = await probeShow(show, index);
    rows.push(row);
    if (index === 0) {
      await checkGameSpelling(podcastId);
      await checkHarness(show, podcastId);
    }
    if (client !== undefined) console.log(`[${index + 1}/${shows.length}] ${show.name}: done, ${budget.used} requests so far`);
    if (stoppedByBudget) break;
  }

  if (client === undefined) {
    console.log("");
    for (const line of onceOnlyLines) console.log(`      ${line}`);
    console.log("");
    console.log(
      `Total planned: ${plannedRequests} direct Qloo requests, plus up to ${HARNESS_RECOMMEND_RESERVE} through the harness. Retries can add more.`,
    );
    console.log(
      plannedRequests + HARNESS_RECOMMEND_RESERVE > maxCalls
        ? `That is over --max-calls ${maxCalls}, so a live run would stop early.`
        : `A live run stops hard at --max-calls ${maxCalls}.`,
    );
    return 0;
  }

  const ratio = (ok: number, tried: number) => `${ok}/${tried}`;
  console.log("");
  console.log(renderTable(rows));
  console.log("");
  console.log("demographics ok: the podcast's result, then people with data out of people tried.");
  console.log("A number in a cell is the HTTP status of a failed call. budget means the hard stop was hit.");
  console.log("");
  for (const line of onceOnlyLines) console.log(line);
  console.log("");
  console.log(
    [
      `Totals: ${rows.length} shows probed`,
      `podcast found ${ratio(tally.found, rows.length)}`,
      `name matched ${ratio(tally.matched, tally.found)}`,
      `people returned ${ratio(tally.withPeople, tally.found)}`,
      `popularity filter changed results ${ratio(tally.popularityChanged, tally.popularityCompared)}`,
      `podcast demographics ${ratio(tally.podcastDemographicsOk, tally.podcastDemographicsTried)}`,
      `people demographics ${ratio(tally.peopleDemographicsOk, tally.peopleTried)}`,
      `trending ${ratio(tally.trendingOk, tally.peopleTried)}`,
      `compare ${ratio(tally.compareOk, tally.compareTried)}`,
      `upcoming releases ${tally.upcoming}`,
    ].join(", "),
  );
  console.log(
    `Calls used: ${budget.used} of ${maxCalls}: ${budget.used - harnessReserved} direct requests including retries, plus ${harnessReserved} reserved for the harness, which reported ${harnessReported}.`,
  );
  if (stoppedByBudget) console.log(`Stopped early: --max-calls ${maxCalls} reached.`);
  console.log(`Raw responses: ${runDir}`);
  return 0;
}

process.exitCode = await main();
