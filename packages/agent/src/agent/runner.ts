import { z } from "zod";
import { FeedError } from "../feeds/errors.js";
import { FeedHandles } from "../feeds/handles.js";
import type { ShowCandidate } from "../feeds/lookup.js";
import type { ParsedFeed } from "../feeds/rss.js";
import { QlooError } from "../qloo/errors.js";
import type { MeteredQloo } from "../qloo/metered.js";
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
} from "../server/runs.js";
import type { Db } from "../store/db.js";
import { buildBoard, type BoardEntry } from "./board.js";
import { writeBrief as writeGuestBrief } from "./brief.js";
import { createRunContext, type RunContext } from "./context.js";
import { AgentError } from "./errors.js";
import { DEFAULT_LIMITS, runResearch, stepFor, type StepEvent } from "./loop.js";
import type { ModelClient } from "./model.js";
import { resolveShow } from "./resolve.js";
import { runTool, type ToolName } from "./tools.js";

export type AgentFeeds = {
  searchShows: (term: string) => Promise<ShowCandidate[]>;
  lookupShow: (appleId: string) => Promise<ShowCandidate | null>;
  safeFetch: (url: URL) => Promise<{ body: string }>;
  parseFeed: (xml: string) => ParsedFeed;
};

const MIN_BOARD = 3;
const UNEXPECTED = "UNEXPECTED";
const MAX_FIT_IDS = 25;
const MAX_EPISODE_TITLES = 40;
const QLOO_ID = /^[A-Za-z0-9-]{8,64}$/;
const FILL_TOOLS: readonly ToolName[] = ["audience_of", "trend_of", "shared_taste"];

// Rows are read back through the same limits they were written under, and a
// row that does not fit counts as missing (C6.5).
const CandidateRow = z
  .object({
    appleId: z.string().max(20).nullable(),
    name: z.string().min(1).max(200),
    publisher: z.string().max(200),
    feedHandleSource: z.enum(["directory", "visitor"]),
    feedUrl: z.string().max(8_192).nullable(),
    qlooId: z.string().regex(QLOO_ID),
    qlooName: z.string().min(1).max(200),
  })
  .strict();

const BoardRow = z
  .object({
    personId: z.string().regex(QLOO_ID),
    name: z.string().min(1).max(200),
    fit: z.number(),
    fitKnown: z.boolean(),
    fitRank: z.number().int().min(1),
    reach: z.enum(["household name", "well known", "bookable"]),
    rising: z.object({ state: z.enum(["rising", "steady", "falling", "unknown"]), points: z.number().nullable() }).strict(),
    bringsNew: z.object({ segment: z.string().max(100), label: z.string().max(100), gap: z.number() }).strict().nullable(),
    sharedTags: z.array(z.string().max(200)).max(5),
    angle: z.string().max(400),
    showName: z.string().min(1).max(200),
  })
  .strict();

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function knownCode(error: unknown): string | null {
  return error instanceof AgentError || error instanceof QlooError || error instanceof FeedError ? error.code : null;
}

/**
 * The real agent behind the routes (AgentPort).
 *
 * startRun moves the run to running, resolves the show (resolveShow, which
 * reads a pasted feed's title through a handle), stores the candidates in
 * rank order, appends a "candidates" event that carries ids, names,
 * publishers and Qloo names but no URL, and moves the run to
 * awaiting_confirm. The feed URL stays in the stored candidate row.
 *
 * continueRun acts only on a candidate the server stored for that run
 * (C6.2). It fetches the candidate's feed only through a FeedHandles handle
 * issued for this run, and the model has no fetch tool at all (C1.5); on any
 * FeedError it carries on with no episode titles and says so in a step. It
 * then runs the research loop, fetches every pick's fit in one metered Qloo
 * call so every fit on the board is comparable, fills missing audience,
 * trend and shared-taste data for the picks left after exclusions through
 * runTool (so the per-tool caps hold), builds the board in code, and stores
 * it with a "board" event and a done event. Fewer than 3 guests fails with
 * AGENT_BOARD_TOO_SMALL; nothing is padded.
 *
 * writeBrief reads the guest from the stored board (C6.2), writes the brief,
 * logs any removed links in a step, stores the brief, marks the guest's
 * brief claim done (markBriefDone), and appends a "brief" event.
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
export function createAgentRunner(deps: { db: Db; model: ModelClient; qloo: MeteredQloo; feeds: AgentFeeds; now?: () => Date }): AgentPort {
  const { db, model, qloo, feeds } = deps;
  const clock = deps.now ?? (() => new Date());

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

  const recentTitles = async (runId: string, feedUrl: string | null, source: "directory" | "visitor"): Promise<string[]> => {
    const url = feedUrl === null ? null : URL.parse(feedUrl);
    if (url === null) {
      await step(runId, { tool: "feed", ok: false, label: "This show lists no feed, so past guests are not checked" });
      return [];
    }
    const handles = new FeedHandles();
    const handle = handles.issue(url, source);
    let titles: string[];
    try {
      const { body } = await feeds.safeFetch(handles.resolve(handle));
      titles = feeds
        .parseFeed(body)
        .episodes.map((episode) => episode.title)
        .filter((title) => title !== "")
        .slice(0, MAX_EPISODE_TITLES);
    } catch (error) {
      if (!(error instanceof FeedError)) throw error;
      await step(runId, { tool: "feed", ok: false, label: "Could not read the show's feed, so past guests are not checked" });
      return [];
    }
    await step(runId, {
      tool: "feed",
      ok: true,
      label: `Read ${plural(titles.length, "recent episode title", "recent episode titles")} from the show's feed`,
    });
    return titles;
  };

  // One request for every pick, so all fits share one signal and one scale.
  // The answer replaces any affinity seen during research; a pick it leaves
  // out has no fit (fit 0, fitKnown false), never a guessed one.
  const scoreFit = async (ctx: RunContext, picks: ReadonlyArray<{ personId: string }>): Promise<void> => {
    const ids = [...new Set(picks.map((pick) => pick.personId))].filter((id) => ctx.people.has(id)).slice(0, MAX_FIT_IDS);
    if (ids.length === 0) return;
    const { data } = await qloo.call<QlooEntity[]>({
      op: "insights",
      filterType: "urn:entity:person",
      signalEntities: [ctx.show.qlooId],
      resultEntities: ids,
      take: ids.length,
    });
    if (!Array.isArray(data)) throw new QlooError("QLOO_SCHEMA");
    const wanted = new Set(ids);
    const scored = new Map<string, { affinity: number; popularity: number | null }>();
    for (const entity of data as QlooEntity[]) {
      const affinity = entity.query?.affinity ?? entity.properties?.affinity;
      if (!wanted.has(entity.entity_id) || scored.has(entity.entity_id) || !isFiniteNumber(affinity)) continue;
      scored.set(entity.entity_id, { affinity, popularity: isFiniteNumber(entity.popularity) ? entity.popularity : null });
    }
    for (const id of ids) {
      const known = ctx.people.get(id);
      if (known === undefined) continue;
      const score = scored.get(id);
      ctx.people.set(id, { ...known, affinity: score?.affinity ?? null, popularity: known.popularity ?? score?.popularity ?? null });
    }
  };

  const fillMissing = async (runId: string, ctx: RunContext, personIds: readonly string[], overTime: () => boolean): Promise<void> => {
    const today = clock();
    for (const personId of personIds) {
      for (const tool of FILL_TOOLS) {
        const present =
          tool === "audience_of" ? ctx.personDemographics.has(personId) : tool === "trend_of" ? ctx.trends.has(personId) : ctx.compares.has(personId);
        if (present) continue;
        if (overTime()) throw new AgentError("AGENT_LIMIT");
        const input = { personId };
        const outcome = await runTool(ctx, qloo, tool, input, today);
        await step(runId, stepFor(ctx, tool, input, outcome));
      }
    }
  };

  return {
    async startRun(runId, input) {
      await setRunStatus(db, runId, "running", undefined, clock());
      await failOnKnownError(runId, async () => {
        const shows = await resolveShow(input, {
          searchShows: feeds.searchShows,
          lookupShow: feeds.lookupShow,
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
      await failOnKnownError(runId, async () => {
        const run = await getRun(db, runId);
        if (run === null) throw new ServerError("SRV_NOT_FOUND");
        const candidate = CandidateRow.safeParse(await getCandidate(db, runId, candidateId));
        if (!candidate.success) throw new AgentError("SHOW_NOT_FOUND");
        const show = candidate.data;

        const episodeTitles = await recentTitles(runId, show.feedUrl, show.feedHandleSource);
        // The Qloo name, not the directory's or the visitor's text, is what
        // the model is told (C2.7).
        const ctx = createRunContext({
          show: { qlooId: show.qlooId, name: show.qlooName },
          episodeTitles,
          exclusions: run.input.exclude,
        });
        const startedAt = clock().getTime();
        const overTime = () => clock().getTime() - startedAt >= DEFAULT_LIMITS.maxWallMs;

        const picks = await runResearch(ctx, {
          model,
          qloo,
          today: clock(),
          onStep: (event) => step(runId, event),
          nowMs: () => clock().getTime(),
        });

        // Exclusions do not depend on the data fetched below, so a board that
        // is already too small fails before any more Qloo calls are spent.
        const kept = buildBoard(ctx, picks).map((entry) => entry.personId);
        if (kept.length < MIN_BOARD) throw new AgentError("AGENT_BOARD_TOO_SMALL");
        if (overTime()) throw new AgentError("AGENT_LIMIT");
        await scoreFit(ctx, picks);
        await step(runId, { tool: "fit", ok: true, label: `Scored ${plural(kept.length, "guest", "guests")} against this show's listeners` });
        await fillMissing(runId, ctx, kept, overTime);

        const board = buildBoard(ctx, picks);
        if (board.length < MIN_BOARD) throw new AgentError("AGENT_BOARD_TOO_SMALL");
        const guestIds = await putBoard(
          db,
          runId,
          board.map((entry) => ({ ...entry, showName: ctx.show.name })),
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
        await appendEvent(db, runId, "board", { guests }, clock());
        await finishRun(db, runId, "done", { name: "done", data: { guests: board.length } }, undefined, clock());
      });
    },

    async writeBrief(runId, guestId) {
      try {
        const row = BoardRow.safeParse(await getBoardGuest(db, runId, guestId));
        if (!row.success) throw new AgentError("AGENT_NO_BOARD");
        const { showName, ...guest } = row.data;
        const { brief, removed } = await writeGuestBrief(model, { guest: guest satisfies BoardEntry, showName });
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
