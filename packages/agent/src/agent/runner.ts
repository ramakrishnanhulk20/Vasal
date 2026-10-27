import { z } from "zod";
import { FeedError } from "../feeds/errors.js";
import { FeedHandles } from "../feeds/handles.js";
import { createDirectoryCache, type DirectoryLookup, type ShowCandidate } from "../feeds/lookup.js";
import type { ParsedFeed } from "../feeds/rss.js";
import { QlooError } from "../qloo/errors.js";
import type { MeteredQloo, MeteredRawQloo } from "../qloo/metered.js";
import type { QlooEntity } from "../qloo/schemas.js";
import type { AgentPort } from "../server/agent-port.js";
import { ServerError } from "../server/errors.js";
import {
  appendEvent,
  claimRunStatus,
  finishRun,
  getBoardGuest,
  getCandidate,
  getRun,
  markBriefDone,
  markBriefFailed,
  putBoard,
  putBrief,
  putCandidates,
  setRunStatus,
  storedCandidateRow,
  storedReach,
  type FeedSource,
  type RunSurface,
} from "../server/runs.js";
import type { Db } from "../store/db.js";
import { reserveWithReceipt, settleToUsage, waitForQlooSlot } from "../store/meter.js";
import { cleanText } from "../text/normalize.js";
import { buildBoard, type BoardEntry } from "./board.js";
import { writeBrief as writeGuestBrief } from "./brief.js";
import { createRunContext, type OperatorArchive, type PastGuestCheck, type RunContext } from "./context.js";
import { AgentError } from "./errors.js";
import { DEFAULT_LIMITS, runResearch, stepFor, type StepEvent } from "./loop.js";
import type { ModelClient } from "./model.js";
import { resolveShow } from "./resolve.js";
import { attachHarness, dropPerson, hasDied, runTool, type ToolName } from "./tools.js";
import { guessWithoutQloo, publisherForPrompt, WITHOUT_QLOO_UNAVAILABLE, type WithoutQlooEvent } from "./without-qloo.js";

export type AgentFeeds = {
  searchShows: (term: string, opts?: DirectoryLookup) => Promise<ShowCandidate[]>;
  lookupShow: (appleId: string, opts?: DirectoryLookup) => Promise<ShowCandidate | null>;
  safeFetch: (url: URL, opts?: { totalTimeoutMs?: number }) => Promise<{ body: string }>;
  parseFeed: (xml: string) => ParsedFeed;
};

/**
 * safeFetch's own default. A confirmed run's feed read gets this or the time
 * the run has left, whichever is shorter; the ops backfill gets all of it.
 */
export const FEED_TIMEOUT_MS = 15_000;
const MIN_BOARD = 3;
const UNEXPECTED = "UNEXPECTED";
const MAX_FIT_IDS = 25;
const MAX_EPISODE_TITLES = 40;
const MAX_SHOW_NAME_CHARS = 200;
const QLOO_ID = /^[A-Za-z0-9-]{8,64}$/;
const FILL_TOOLS: readonly ToolName[] = ["audience_of", "trend_of", "shared_taste"];

/**
 * What an operator may add to one run's past-guest check, and only from the
 * ops commands: hosts the feed does not name, and older episodes the feed no
 * longer reaches. Neither is stored or shown; the board event records only
 * how many archive titles were added.
 */
export type OperatorInput = { readonly hosts?: readonly string[]; readonly archive?: OperatorArchive | null };

/**
 * A stored candidate as continueRun reads it back, through the same limits
 * it was written under; a row that does not fit counts as missing (C6.5).
 * It is storedCandidateRow, the one schema the ops commands and the
 * past-guest view read candidates with too, so its provenance always comes
 * out set: a row stored without one reads as "directory" when its
 * feedHandleSource is "directory" and "pasted" otherwise.
 */
export const CandidateRow = storedCandidateRow;

const BoardRow = z
  .object({
    personId: z.string().regex(QLOO_ID),
    name: z.string().min(1).max(200),
    fit: z.number(),
    fitKnown: z.boolean(),
    fitRank: z.number().int().min(1),
    reach: storedReach,
    rising: z.object({ state: z.enum(["rising", "steady", "falling", "unknown"]), points: z.number().nullable() }).strict(),
    bringsNew: z.object({ segment: z.string().max(100), label: z.string().max(100), gap: z.number() }).strict().nullable(),
    sharedTags: z.array(z.string().max(200)).max(5),
    angle: z.string().max(400),
    showName: z.string().min(1).max(200),
  })
  .strict();

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

// Fixed English names, so the label never depends on the server's locale
// and no feed text reaches it.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function monthYear(since: string): string | null {
  const [year, month] = since.split("-");
  const name = MONTHS[Number(month) - 1];
  return year === undefined || name === undefined ? null : `${name} ${year}`;
}

// How far the past-guest check reached, in counts and a month written by
// code, so the run never says "checked" without saying how much (G17).
function feedStep(check: PastGuestCheck): StepEvent {
  if (!check.checked) return { tool: "feed", ok: false, label: "The show's feed gave no episode titles, so past guests are not checked" };
  const back = check.since === null ? null : monthYear(check.since);
  return {
    tool: "feed",
    ok: true,
    label: `Read ${plural(check.titles, "episode title", "episode titles")}${back === null ? "" : ` back to ${back}`} from the show's feed`,
  };
}

type SurfaceBudget = { qlooDayKey: string; qlooExtraKeys: readonly string[]; modelKey: string };

/**
 * The buckets each surface spends from (D3.1, D3.3). A website run charges
 * qloo:day and anthropic:day. An MCP run charges qloo:day:mcp and its own
 * month, qloo:month:mcp, on top of the shared qloo:month and per-second
 * limit, and anthropic:day:mcp for model tokens, so it never touches the
 * website's day shares. main.ts builds one Qloo client and one model per
 * surface from this table.
 */
export const SURFACE_BUDGETS: Readonly<Record<RunSurface, SurfaceBudget>> = {
  web: { qlooDayKey: "qloo:day", qlooExtraKeys: [], modelKey: "anthropic:day" },
  mcp: { qlooDayKey: "qloo:day:mcp", qlooExtraKeys: ["qloo:month:mcp"], modelKey: "anthropic:day:mcp" },
};

function budgetOf(surface: unknown): SurfaceBudget {
  if (surface !== "web" && surface !== "mcp") throw new ServerError("SRV_BAD_INPUT");
  return SURFACE_BUDGETS[surface];
}

/**
 * The Qloo meter for one surface: waitForQlooSlot with that surface's day
 * bucket and extra buckets from SURFACE_BUDGETS. Passed to createMeteredQloo
 * as its waitForSlot, with the call's signal, which ends the wait when it
 * fires. Throws ServerError("SRV_BAD_INPUT") for any surface other than
 * "web" or "mcp", and whatever waitForQlooSlot throws.
 */
export async function waitForSurfaceQlooSlot(db: Db, surface: RunSurface, signal?: AbortSignal): Promise<boolean> {
  const budget = budgetOf(surface);
  return waitForQlooSlot(db, { dayKey: budget.qlooDayKey, extraKeys: [...budget.qlooExtraKeys], ...(signal === undefined ? {} : { signal }) });
}

/**
 * The model-token meter for one surface: reserves `amount` from that
 * surface's model bucket in SURFACE_BUDGETS (reserveWithReceipt). Passed to
 * createAnthropicModel as its reserveTokens. Returns false, charging
 * nothing, when the bucket refuses, and otherwise the settle callback
 * settleToUsage gives, which moves the reservation to the tokens the call
 * really used: what went unused comes back and an over-run is charged.
 * Throws ServerError("SRV_BAD_INPUT") for any surface other than "web" or
 * "mcp", and whatever reserveWithReceipt throws.
 */
export async function reserveSurfaceTokens(db: Db, surface: RunSurface, amount: number): Promise<false | ((used: number) => Promise<void>)> {
  const receipt = await reserveWithReceipt(db, [{ key: budgetOf(surface).modelKey, amount }]);
  return receipt === null ? false : settleToUsage(db, receipt);
}

function knownCode(error: unknown): string | null {
  return error instanceof AgentError || error instanceof QlooError || error instanceof FeedError ? error.code : null;
}

/**
 * Reads a show's feed once, through a FeedHandles handle issued here for
 * `url` and `source`, with safeFetch's totalTimeoutMs, and parses it. Every
 * episode the parser kept comes back, because a guest from years back is
 * still a past guest. Gives null on any FeedError, so the caller reports past
 * guests as not checked rather than implying there were none, and rethrows
 * anything else. continueRun, the ops backfill and ops recheck all read
 * feeds this way.
 */
export async function fetchShowFeed(
  feeds: Pick<AgentFeeds, "safeFetch" | "parseFeed">,
  url: URL,
  source: "directory" | "visitor",
  totalTimeoutMs: number,
): Promise<ParsedFeed | null> {
  const handles = new FeedHandles();
  const handle = handles.issue(url, source);
  try {
    const { body } = await feeds.safeFetch(handles.resolve(handle), { totalTimeoutMs });
    return feeds.parseFeed(body);
  } catch (error) {
    if (!(error instanceof FeedError)) throw error;
    return null;
  }
}

/**
 * The run context for one confirmed show and its feed (null when it could
 * not be read), built the one way continueRun and the ops backfill share.
 * The model is told the Qloo name, not the directory's or the visitor's text
 * (C2.7). For a candidate a directory search found (provenance "directory")
 * it sees the newest 40 non-blank episode titles; for one the visitor linked
 * or pasted (provenance "linked" or "pasted") it sees none, so
 * recent_episode_titles and the flip share no title, because no search
 * vouched for that feed and whoever wrote it may have written its titles
 * for the model. Every episode the feed gave, whatever its provenance, joins the past-guest check, its title
 * as a title and its description as a description. The host entries are
 * every name the show goes by (directory name, publisher, Qloo name, feed
 * title), the feed's authors and `operator.hosts`, the hosts the operator
 * named for this run, because a host is named there and rarely in an episode
 * title. `operator.archive` joins the check as createRunContext describes.
 * None of the descriptions, authors, operator hosts or archive is shown to
 * the model.
 */
export function runContextFor(
  show: { qlooId: string; qlooName: string; name: string; publisher: string; provenance: FeedSource },
  feed: ParsedFeed | null,
  exclusions: readonly string[],
  operator: OperatorInput = {},
): RunContext {
  const shown = show.provenance === "directory" ? (feed?.episodes ?? []) : [];
  return createRunContext({
    show: { qlooId: show.qlooId, name: show.qlooName },
    episodeTitles: shown
      .map((episode) => episode.title)
      .filter((title) => title !== "")
      .slice(0, MAX_EPISODE_TITLES),
    exclusions,
    pastGuestEpisodes: feed?.episodes ?? null,
    showRunners: [show.name, show.publisher, show.qlooName, ...(feed === null ? [] : [feed.title, ...feed.authors]), ...(operator.hosts ?? [])],
    archive: operator.archive ?? null,
  });
}

/**
 * The real agent behind the routes (AgentPort).
 *
 * startRun moves the run to running, resolves the show (resolveShow, which
 * reads a pasted feed's title through a handle), stores the candidates in
 * rank order, appends a "candidates" event that carries ids, names,
 * publishers and Qloo names but no URL, and moves the run to
 * awaiting_confirm. The feed URL stays in the stored candidate row. Its
 * directory searches and lookups pass the surface read back from the run's
 * row, which holds an MCP run to MCP's own directory limit, and the shared
 * hour-long directory cache (createDirectoryCache on this database).
 *
 * continueRun acts only on a candidate the server stored for that run
 * (C6.2). It fetches the candidate's feed only through a FeedHandles handle
 * issued for this run, and the model has no fetch tool at all (C1.5); on any
 * FeedError it carries on with no episode titles and says so in a step. The
 * model is shown the newest 40 titles of a feed a directory search found and
 * none of one the visitor linked or pasted (runContextFor), and every title and description the
 * feed gave, plus the show's host entries (its directory name, publisher,
 * Qloo name and feed title, the feed's authors and `operator.hosts`), with
 * `operator.archive`, is used to leave past guests and hosts out of every
 * tool result (isPastGuest, through runContextFor). `operator` is only for
 * an operator's runner, such as one ops seed builds for a single run; the
 * server never sets it. The
 * feed step says how many titles were read and the month of the oldest
 * dated one, or that the feed gave none. It then runs the research loop,
 * fetches every pick's fit in one metered Qloo call so every fit on the
 * board is comparable (dropping any pick that answer says has died), fills
 * missing audience, trend and shared-taste data only for the picks that
 * survive exclusions and the find_person fit floor through runTool (so the
 * per-tool caps hold), with no audience check for a pick Qloo already said
 * has no audience data for, builds the board in code, and stores it with a
 * "board" event and a done event. Between the two it adds the "Without Qloo"
 * flip (guessWithoutQloo) with the run's own model and Qloo client and the
 * run's deadline signal, given the publisher only for a directory show
 * (publisherForPrompt): a step "Asked the same model without Qloo, and scored
 * its N guesses" and a "without_qloo" event holding the result, or, on any
 * error or once the deadline has passed, only a "without_qloo" event
 * { status: "unavailable" }. The flip never fails the run; a ServerError from
 * storing it loses only the flip. The board event carries pastGuests
 * { checked, skipped, titles, since, source, candidateId, archiveTitles } and
 * the done event { checked, skipped }: checked is false when the feed gave
 * no title to check, skipped counts the people left out as past guests or
 * hosts, titles how many feed titles were checked, since the oldest dated
 * one's month ("YYYY-MM") or null, source "directory", "linked" or "pasted",
 * the confirmed candidate's provenance, candidateId that candidate's id,
 * and archiveTitles how many titles operator.archive added (0 without one).
 * No feed URL, host or archive text is ever in an event. Fewer than 3
 * guests fails with AGENT_BOARD_TOO_SMALL; nothing is padded. With `trends`
 * false the research loop is never offered trend_of and the fill skips it,
 * so no trend call is spent and every guest's rising state is "unknown".
 *
 * continueRun's time cap (DEFAULT_LIMITS.maxWallMs, C2.4) starts the moment
 * it is called, before the feed read, which gets 15 s or the time left if
 * that is shorter. Research, the fit call and the fills share that one
 * deadline: every Qloo call carries a signal that fires at it, so a call
 * still running then is cut off and none starts after it, and the run fails
 * with AGENT_LIMIT rather than the cut call's own code.
 *
 * writeBrief reads the guest from the stored board (C6.2), writes the brief,
 * logs any removed links in a step, stores the brief, marks the guest's
 * brief claim done (markBriefDone), and appends a "brief" event.
 *
 * Every spend goes through the Qloo client and model for the surface read
 * back from the run's own row (qlooFor and modelFor), never from anything a
 * request carried, so an MCP run charges only MCP's buckets and a website
 * run only the website's (D3.2). find_person runs on Qloo's harness, which
 * continueRun attaches to the run once (attachHarness) over harnessFor of
 * that same surface, with the run's deadline signal. A run whose row cannot
 * be read is never started or continued.
 *
 * Any AgentError, QlooError or FeedError in startRun or continueRun ends the
 * run as failed through finishRun with only the error's code (C6.4, C3.6),
 * and the call resolves. In writeBrief it marks the claim failed with only
 * that code (markBriefFailed), so the visitor can ask once more, appends a
 * failed "brief" event with the code, and resolves; the run itself stays
 * done. Every other error is rethrown: from startRun or continueRun the
 * route then marks the run failed with AGENT_ERROR. In writeBrief the claim
 * is first marked failed with UNEXPECTED, so it never stays pending, and the
 * route then only logs the error. If the database cannot take that write
 * either, the claim stays pending until the startup sweep
 * (failStaleBriefClaims) finds it.
 */
export function createAgentRunner(deps: {
  db: Db;
  qlooFor: (surface: RunSurface) => MeteredQloo;
  harnessFor: (surface: RunSurface) => MeteredRawQloo;
  modelFor: (surface: RunSurface) => ModelClient;
  feeds: AgentFeeds;
  trends: boolean;
  now?: () => Date;
  operator?: OperatorInput;
}): AgentPort {
  const { db, qlooFor, harnessFor, modelFor, feeds, trends } = deps;
  const operator: OperatorInput = { hosts: [...(deps.operator?.hosts ?? [])], archive: deps.operator?.archive ?? null };
  const clock = deps.now ?? (() => new Date());
  const toolOptions = { trends };
  const fillTools = trends ? FILL_TOOLS : FILL_TOOLS.filter((tool) => tool !== "trend_of");

  const storedRun = async (runId: string) => {
    const run = await getRun(db, runId);
    if (run === null) throw new ServerError("SRV_NOT_FOUND");
    return run;
  };

  const step = async (runId: string, event: StepEvent): Promise<void> => {
    await appendEvent(db, runId, "step", event, clock());
  };

  const failOnKnownError = async (runId: string, work: () => Promise<void>): Promise<void> => {
    try {
      await work();
    } catch (error) {
      const code = knownCode(error);
      if (code === null) throw error;
      await finishRun(db, runId, "failed", { name: "failed", data: { code } }, code, clock());
    }
  };

  // null means past guests cannot be checked, which the run reports in a step
  // instead of implying there were none.
  const readFeed = async (
    runId: string,
    feedUrl: string | null,
    source: "directory" | "visitor",
    totalTimeoutMs: number,
  ): Promise<ParsedFeed | null> => {
    const url = feedUrl === null ? null : URL.parse(feedUrl);
    if (url === null) {
      await step(runId, { tool: "feed", ok: false, label: "This show lists no feed, so past guests are not checked" });
      return null;
    }
    const feed = await fetchShowFeed(feeds, url, source, totalTimeoutMs);
    if (feed === null) await step(runId, { tool: "feed", ok: false, label: "Could not read the show's feed, so past guests are not checked" });
    return feed;
  };

  // Best effort, after the board is stored: any error, or the run's deadline,
  // stores { status: "unavailable" } instead, so the flip never fails the run
  // or holds its done status past the deadline. At most 8 guesses with names
  // capped at 120 characters keep the event far under appendEvent's 16 KB.
  const addWithoutQloo = async (
    runId: string,
    flip: { model: ModelClient; qloo: MeteredQloo; ctx: RunContext; board: readonly BoardEntry[]; publisher: string | null },
    deadline: { overTime: () => boolean; signal: AbortSignal },
  ): Promise<void> => {
    const result: WithoutQlooEvent = deadline.overTime()
      ? WITHOUT_QLOO_UNAVAILABLE
      : await guessWithoutQloo({ ...flip, signal: deadline.signal }).then(
          (done) => (deadline.overTime() ? WITHOUT_QLOO_UNAVAILABLE : done),
          () => WITHOUT_QLOO_UNAVAILABLE,
        );
    try {
      if (result.status === "done") {
        const label = `Asked the same model without Qloo, and scored its ${plural(result.guesses.length, "guess", "guesses")}`;
        await step(runId, { tool: "without_qloo", ok: true, label });
      }
      await appendEvent(db, runId, "without_qloo", result, clock());
    } catch (error) {
      // A full or unreachable event log loses only the flip. finishRun below
      // still ends the run, or fails on its own if the database is down.
      if (!(error instanceof ServerError)) throw error;
    }
  };

  // One request for every pick, so all fits share one signal and one scale.
  // The answer replaces any affinity seen during research; a pick it leaves
  // out has no fit (fit 0, fitKnown false), never a guessed one. Returns the
  // ids that got a usable fit.
  const scoreFit = async (
    qloo: MeteredQloo,
    ctx: RunContext,
    picks: ReadonlyArray<{ personId: string }>,
    signal: AbortSignal,
  ): Promise<ReadonlySet<string>> => {
    const ids = [...new Set(picks.map((pick) => pick.personId))]
      .filter((id) => ctx.people.has(id) && !ctx.dropped.has(id))
      .slice(0, MAX_FIT_IDS);
    if (ids.length === 0) return new Set();
    const { data } = await qloo.call<QlooEntity[]>(
      {
        op: "insights",
        filterType: "urn:entity:person",
        signalEntities: [ctx.show.qlooId],
        resultEntities: ids,
        take: ids.length,
      },
      { signal },
    );
    if (!Array.isArray(data)) throw new QlooError("QLOO_SCHEMA");
    const wanted = new Set(ids);
    const scored = new Map<string, { affinity: number; popularity: number | null }>();
    for (const entity of data as QlooEntity[]) {
      if (!wanted.has(entity.entity_id)) continue;
      // Once find_person goes through Qloo's harness its results carry no
      // death date, so for a found person this answer is the one place it
      // is seen. Any row with one drops the person, wherever it falls.
      if (hasDied(entity)) {
        dropPerson(ctx, entity.entity_id);
        continue;
      }
      const affinity = entity.query?.affinity ?? entity.properties?.affinity;
      if (scored.has(entity.entity_id) || !isFiniteNumber(affinity)) continue;
      scored.set(entity.entity_id, { affinity, popularity: isFiniteNumber(entity.popularity) ? entity.popularity : null });
    }
    const usable = new Set<string>();
    for (const id of ids) {
      const known = ctx.people.get(id);
      if (known === undefined || ctx.dropped.has(id)) continue;
      const score = scored.get(id);
      if (score !== undefined) usable.add(id);
      ctx.people.set(id, { ...known, affinity: score?.affinity ?? null, popularity: known.popularity ?? score?.popularity ?? null });
    }
    return usable;
  };

  const fillMissing = async (
    qloo: MeteredQloo,
    runId: string,
    ctx: RunContext,
    personIds: readonly string[],
    deadline: { overTime: () => boolean; signal: AbortSignal },
  ): Promise<void> => {
    const today = clock();
    const options = { ...toolOptions, signal: deadline.signal };
    for (const personId of personIds) {
      if (ctx.dropped.has(personId)) continue;
      for (const tool of fillTools) {
        // A person Qloo already said has no audience data counts as checked,
        // so the fill does not log a second refusal for them.
        const present =
          tool === "audience_of"
            ? ctx.personDemographics.has(personId) || ctx.noAudience.has(personId)
            : tool === "trend_of"
              ? ctx.trends.has(personId)
              : ctx.compares.has(personId);
        if (present) continue;
        if (deadline.overTime()) throw new AgentError("AGENT_LIMIT");
        const input = { personId };
        const outcome = await runTool(ctx, qloo, tool, input, today, options);
        await step(runId, stepFor(ctx, tool, input, outcome));
      }
    }
  };

  return {
    async startRun(runId, input) {
      const { surface } = await storedRun(runId);
      const qloo = qlooFor(surface);
      // The surface comes from the run's own row, so only a run stored as a
      // website run gets the website's directory places (D3.7).
      const lookup: DirectoryLookup = { cache: createDirectoryCache(db, clock), surface };
      await setRunStatus(db, runId, "running", undefined, clock());
      await failOnKnownError(runId, async () => {
        const shows = await resolveShow(input, {
          searchShows: (term) => feeds.searchShows(term, lookup),
          lookupShow: (appleId) => feeds.lookupShow(appleId, lookup),
          safeFetch: feeds.safeFetch,
          parseFeed: feeds.parseFeed,
          qloo,
        });
        const ids = await putCandidates(db, runId, shows);
        const candidates = shows.map((show, index) => ({
          id: ids[index],
          appleId: show.appleId,
          name: show.name,
          publisher: show.publisher,
          qlooName: show.qlooName,
        }));
        await appendEvent(db, runId, "candidates", { candidates }, clock());
        await claimRunStatus(db, runId, "running", "awaiting_confirm", clock());
      });
    },

    async continueRun(runId, candidateId) {
      // The cap counts from confirm, so the feed read is spent from it too.
      const startedAt = clock().getTime();
      const deadline = startedAt + DEFAULT_LIMITS.maxWallMs;
      const runClock = new AbortController();
      const timer = setTimeout(() => runClock.abort(), DEFAULT_LIMITS.maxWallMs);
      // The signal counts too: a timer can fire a moment before the clock
      // reads the deadline, and a call it cut off must still end as a cap.
      const overTime = () => runClock.signal.aborted || clock().getTime() >= deadline;
      // A Qloo call the deadline cut off fails as QLOO_TIMEOUT; the run
      // reports the cap it ran into instead.
      const asLimit = (error: unknown): never => {
        throw error instanceof QlooError && overTime() ? new AgentError("AGENT_LIMIT") : error;
      };
      await failOnKnownError(runId, async () => {
        const run = await storedRun(runId);
        const qloo = qlooFor(run.surface);
        const model = modelFor(run.surface);
        const candidate = CandidateRow.safeParse(await getCandidate(db, runId, candidateId));
        if (!candidate.success) throw new AgentError("SHOW_NOT_FOUND");
        const show = candidate.data;

        const feedTimeoutMs = Math.max(1, Math.min(FEED_TIMEOUT_MS, deadline - clock().getTime()));
        const feed = await readFeed(runId, show.feedUrl, show.feedHandleSource, feedTimeoutMs);
        const ctx = runContextFor(show, feed, run.input.exclude, operator);
        attachHarness(ctx, { qloo: harnessFor(run.surface), signal: runClock.signal });
        if (feed !== null) await step(runId, feedStep(ctx.pastGuests));

        const picks = await runResearch(ctx, {
          model,
          qloo,
          today: clock(),
          trends,
          onStep: (event) => step(runId, event),
          nowMs: () => clock().getTime(),
          startedAtMs: startedAt,
        });

        // Exclusions do not depend on the data fetched below, so a board that
        // is already too small fails before any more Qloo calls are spent.
        // The fit floor waits, because a find_person pick has no fit until
        // the fit call below.
        if (buildBoard(ctx, picks, { applyFitFloor: false }).length < MIN_BOARD) throw new AgentError("AGENT_BOARD_TOO_SMALL");
        if (overTime()) throw new AgentError("AGENT_LIMIT");
        const scored = await scoreFit(qloo, ctx, picks, runClock.signal).catch(asLimit);
        await step(runId, { tool: "fit", ok: true, label: `Scored ${plural(scored.size, "guest", "guests")} against this show's listeners` });
        // Built again once every pick has its fit, so a pick the floor or a
        // death date removes is never sent for more data.
        const kept = buildBoard(ctx, picks).map((entry) => entry.personId);
        if (kept.length < MIN_BOARD) throw new AgentError("AGENT_BOARD_TOO_SMALL");
        await fillMissing(qloo, runId, ctx, kept, { overTime, signal: runClock.signal });
        // A fill the deadline cut off comes back as an error result, and a
        // board built without it would hide that the run ran out of time.
        if (overTime()) throw new AgentError("AGENT_LIMIT");

        // buildBoard has cleaned every guest name, tag and angle. The show
        // name rides on every stored row too, and it was read back from the
        // database, so it is cleaned here at the store point (C3.7).
        const board = buildBoard(ctx, picks);
        if (board.length < MIN_BOARD) throw new AgentError("AGENT_BOARD_TOO_SMALL");
        const showName = cleanText(ctx.show.name, { maxChars: MAX_SHOW_NAME_CHARS }).trim();
        const guestIds = await putBoard(
          db,
          runId,
          board.map((entry) => ({ ...entry, showName })),
        );
        const guests = board.map((entry, index) => ({
          id: guestIds[index],
          name: entry.name,
          fit: entry.fit,
          fitKnown: entry.fitKnown,
          fitRank: entry.fitRank,
          reach: entry.reach,
          rising: entry.rising.state,
        }));
        const pastGuests = { checked: ctx.pastGuests.checked, skipped: ctx.pastGuests.skipped.size };
        const coverage = { titles: ctx.pastGuests.titles, since: ctx.pastGuests.since };
        // Which feed was checked, by the provenance the server stored and the
        // candidate it confirmed, never by its URL, so the public views can
        // say it without the feed ever leaving the server (C1.5).
        const provenance = {
          source: show.provenance,
          candidateId,
          archiveTitles: ctx.pastGuests.archiveTitles,
        };
        await appendEvent(db, runId, "board", { guests, pastGuests: { ...pastGuests, ...coverage, ...provenance } }, clock());
        await addWithoutQloo(
          runId,
          { model, qloo, ctx, board, publisher: publisherForPrompt({ publisher: show.publisher, provenance: show.provenance }) },
          { overTime, signal: runClock.signal },
        );
        // The done event keeps exactly { checked, skipped }: the seed command
        // reads it with a strict schema (src/ops/seed.ts).
        await finishRun(db, runId, "done", { name: "done", data: { guests: board.length, pastGuests } }, undefined, clock());
      }).finally(() => clearTimeout(timer));
    },

    async writeBrief(runId, guestId) {
      try {
        const run = await getRun(db, runId);
        if (run === null) throw new AgentError("AGENT_NO_BOARD");
        const row = BoardRow.safeParse(await getBoardGuest(db, runId, guestId));
        if (!row.success) throw new AgentError("AGENT_NO_BOARD");
        const { showName, ...guest } = row.data;
        const { brief, removed } = await writeGuestBrief(modelFor(run.surface), { guest: guest satisfies BoardEntry, showName });
        if (removed.links + removed.emails > 0) {
          await step(runId, {
            tool: "brief",
            ok: true,
            label: `Removed ${plural(removed.links, "link", "links")} and ${plural(removed.emails, "email address", "email addresses")} from the draft`,
          });
        }
        await putBrief(db, runId, guestId, { ...brief, removed }, clock());
        await markBriefDone(db, runId, guestId);
        await appendEvent(db, runId, "brief", { guestId, ok: true }, clock());
      } catch (error) {
        const code = knownCode(error);
        if (code === null) {
          // The claim was taken before any model call, so leaving it pending
          // would keep the page waiting forever. The route logs the error.
          await markBriefFailed(db, runId, guestId, UNEXPECTED);
          throw error;
        }
        await markBriefFailed(db, runId, guestId, code);
        await appendEvent(db, runId, "brief", { guestId, ok: false, code }, clock());
      }
    },
  };
}
