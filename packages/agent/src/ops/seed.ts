import { z } from "zod";
import { createAnthropicModel, type ModelClient } from "../agent/model.js";
import { resolveShow } from "../agent/resolve.js";
import { createAgentRunner, type AgentFeeds } from "../agent/runner.js";
import { lookupShow, searchShows } from "../feeds/lookup.js";
import { parseFeed } from "../feeds/rss.js";
import { safeFetch } from "../net/safe-fetch.js";
import { createQlooClient } from "../qloo/client.js";
import { createMeteredQloo, type MeteredQloo } from "../qloo/metered.js";
import type { AgentPort } from "../server/agent-port.js";
import {
  claimRunStatus,
  createRun,
  finishRun,
  getRun,
  listCandidates,
  type RunInput,
  type RunRecord,
} from "../server/runs.js";
import type { Db } from "../store/db.js";
import { reserve, waitForQlooSlot } from "../store/meter.js";
import { previewRun } from "./promote.js";

/** The Qloo day share the seed spends from. Every call also counts against qloo:month and the per-second limit (C5.1). */
export const SEED_QLOO_DAY = "qloo:day:offline";
/** The model-token share the seed spends from, the backtest's offline share, so seeding never uses tokens live runs need. */
export const SEED_MODEL_DAY = "anthropic:day:offline";
/** The run's error code when the operator's pick is not one of the run's stored, readable candidates. */
export const SEED_PICK_MISSING = "SEED_PICK_MISSING";
/** The error code when a run is not in the state the seed expects at a step. */
export const SEED_UNEXPECTED_STATUS = "SEED_UNEXPECTED_STATUS";
/** The preview's code when the error it caught carries no fixed code of its own. */
export const SEED_PREVIEW_FAILED = "SEED_PREVIEW_FAILED";

/**
 * One show the preview offers, ranked from 1 in the order a run would store
 * it. The names come from Apple and Qloo, so a terminal prints them only
 * after sanitising (C3.6).
 */
export type SeedCandidate = { rank: number; name: string; publisher: string; qlooName: string };
/** What the seed needs from the agent: the show lookup on its own, and the real runner. */
export type SeedAgent = { preview(show: string): Promise<SeedCandidate[]>; runner: AgentPort };
/** How seedShow ended. A failed outcome carries only a fixed upper-case code, never error text (C3.6). */
export type SeedOutcome =
  | { kind: "preview"; candidates: SeedCandidate[] }
  | { kind: "done"; runId: string; picked: SeedCandidate; guests: number }
  | { kind: "failed"; runId: string | null; code: string };

const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,40}$/;
const QLOO_ID = /^[A-Za-z0-9-]{8,64}$/;

// The limits continueRun reads a stored candidate with (CandidateRow in
// agent/runner.ts), so the name printed is the show the runner researches,
// and a row the runner would refuse counts as missing here too (C6.5).
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

// Only a fixed upper-case code ever leaves the preview, never an error's
// message, which could quote an upstream answer (C3.6).
function codeOf(error: unknown): string {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && ERROR_CODE.test(code) ? code : SEED_PREVIEW_FAILED;
}

const isOpen = (run: RunRecord | null): boolean => run !== null && run.status !== "done" && run.status !== "failed";

// The same event shape the runner fails a run with.
async function closeFailed(db: Db, runId: string, code: string): Promise<SeedOutcome> {
  await finishRun(db, runId, "failed", { name: "failed", data: { code } }, code);
  return { kind: "failed", runId, code };
}

/**
 * The seed's meter, bound the way scripts/backtest.ts binds its own.
 * waitForQlooSlot reserves one Qloo call on `target` from qloo:day:offline,
 * qloo:month and the current second's bucket, all or nothing, waiting while
 * only the second is full (waitForQlooSlot in store/meter.ts), so a seed
 * shares the month and per-second limits of every process on the database
 * (C5.1). reserveModelTokens reserves `amount` from anthropic:day:offline on
 * `db`. Nothing else is ever charged: not qloo:day, not the MCP shares, not
 * anthropic:day. Each resolves false, charging nothing, when a bucket is
 * full, missing or expired. Neither runs the server's start-up sweep,
 * touches an in-flight counter or promotes a run. Each rejects with what the
 * meter throws: StoreError("STORE_BAD_INPUT") for an amount outside 1 to
 * 1,000,000 and StoreError("STORE_UNAVAILABLE") if the database fails.
 */
export function seedMeterHooks(db: Db): {
  waitForQlooSlot: (target: Db) => Promise<boolean>;
  reserveModelTokens: (amount: number) => Promise<boolean>;
} {
  return {
    waitForQlooSlot: (target) => waitForQlooSlot(target, { dayKey: SEED_QLOO_DAY }),
    reserveModelTokens: (amount) => reserve(db, [{ key: SEED_MODEL_DAY, amount }]),
  };
}

/**
 * Builds the seed's agent from given parts, so a test can pass fakes and
 * createSeedAgent the real ones. runner is the real agent runner
 * (createAgentRunner) with `deps.qloo` and `deps.model` for every surface,
 * so whatever surface a run records, it spends only through the meter those
 * parts were built with; from createSeedAgent that is qloo:day:offline,
 * qloo:month and anthropic:day:offline. preview(show) runs only the show
 * lookup startRun runs (resolveShow, with no exclusions), which spends one
 * metered Qloo search per directory match, and returns the candidates ranked
 * from 1. preview writes nothing to the runs tables. Neither runs the
 * server's start-up sweep, touches an in-flight counter or promotes a run.
 * Building throws nothing. preview rejects with what resolveShow throws:
 * AgentError SHOW_NOT_FOUND, SHOW_NO_QLOO_MATCH or FEED_UNAVAILABLE, a
 * FeedError, a QlooError such as QLOO_BUDGET, or a StoreError. The runner
 * throws as createAgentRunner documents.
 */
export function seedAgentFrom(
  db: Db,
  deps: { qloo: MeteredQloo; model: ModelClient; feeds: AgentFeeds; trends: boolean },
): SeedAgent {
  const runner = createAgentRunner({ db, qlooFor: () => deps.qloo, modelFor: () => deps.model, feeds: deps.feeds, trends: deps.trends });
  return {
    async preview(show) {
      const shows = await resolveShow({ show, exclude: [] }, { ...deps.feeds, qloo: deps.qloo });
      return shows.map((found, index) => ({ rank: index + 1, name: found.name, publisher: found.publisher, qlooName: found.qlooName }));
    },
    runner,
  };
}

/**
 * The real seed agent: the server's own metered Qloo client and shared cache
 * (createMeteredQloo) over a client with no retries, the Anthropic model,
 * and the directory lookup, feed fetcher and feed parser main.ts gives the
 * server, so a seed run is researched exactly as a visitor's is (C9.2). The
 * meter is seedMeterHooks, so every Qloo call charges qloo:day:offline and
 * qloo:month, every model call anthropic:day:offline, and nothing else
 * (C5.1). It never runs the server's start-up sweep, touches an in-flight
 * counter or promotes a run, and it makes no network call until preview or
 * the runner is used. Throws QlooError QLOO_KEY_MISSING for a blank Qloo key
 * and QLOO_BAD_INPUT for a base URL that is not https, and AgentError
 * MODEL_KEY_MISSING for a blank Anthropic key.
 */
export function createSeedAgent(
  db: Db,
  opts: {
    qlooApiKey: string;
    qlooBaseUrl: URL;
    anthropicApiKey: string;
    model: string;
    effort: "low" | "medium" | "high";
    trends: boolean;
  },
): SeedAgent {
  const hooks = seedMeterHooks(db);
  // No retries inside the client, so every Qloo attempt takes its own slot
  // from the shared meter (C5.1, C5.2).
  const client = createQlooClient({ apiKey: opts.qlooApiKey, baseUrl: opts.qlooBaseUrl, maxRetries: 0 });
  const qloo = createMeteredQloo({ client, db, baseUrl: opts.qlooBaseUrl, waitForSlot: hooks.waitForQlooSlot });
  const model = createAnthropicModel({
    apiKey: opts.anthropicApiKey,
    model: opts.model,
    effort: opts.effort,
    reserveTokens: hooks.reserveModelTokens,
  });
  return seedAgentFrom(db, { qloo, model, feeds: { searchShows, lookupShow, safeFetch, parseFeed }, trends: opts.trends });
}

/**
 * Builds one showcase run the way a visitor's run is built, without the
 * website door. With `pick` undefined it only previews: it returns the
 * candidates agent.preview finds and writes nothing, or, on any error, a
 * failed outcome with runId null and the error's own code when that is an
 * upper-case code, else SEED_PREVIEW_FAILED. With a pick it creates a web
 * run (createRun's default origin, like the website), runs startRun, and if
 * the run is then awaiting_confirm it takes the stored candidate at rank
 * `pick`, claims the run from awaiting_confirm to running as the confirm
 * route does, runs continueRun on that candidate, and returns done with the
 * pick and the board's guest count. Each outcome is read from the run row,
 * never from what the runner returned or threw. A run that failed in the
 * runner returns its own code. A run left open is closed as failed with
 * SEED_UNEXPECTED_STATUS, and a pick that is not a stored, readable
 * candidate (past the list, below 1 or not whole) closes it as failed with
 * SEED_PICK_MISSING; each close appends a failed event { code } in the same
 * transaction (finishRun). A run something else moved before the claim is
 * left alone and returns SEED_UNEXPECTED_STATUS. Spending goes only through
 * the agent's meter, which from createSeedAgent is qloo:day:offline,
 * qloo:month and anthropic:day:offline. It never runs the server's start-up
 * sweep (failInterruptedRuns and the resets after it), never takes an
 * in-flight slot or a visitor count, and never promotes; the operator does
 * that with ops promote. Throws ServerError("SRV_BAD_INPUT") for a show
 * createRun refuses, ServerError("SRV_UNAVAILABLE") if the database fails,
 * ServerError("SRV_NOT_FOUND") if a run it closes was closed by another
 * writer first, and PromoteError or StoreError from the board count.
 */
export async function seedShow(db: Db, agent: SeedAgent, show: string, pick: number | undefined): Promise<SeedOutcome> {
  if (pick === undefined) {
    try {
      return { kind: "preview", candidates: await agent.preview(show) };
    } catch (error) {
      return { kind: "failed", runId: null, code: codeOf(error) };
    }
  }

  const input: RunInput = { show, exclude: [] };
  const runId = await createRun(db, input);
  try {
    await agent.runner.startRun(runId, input);
  } catch {
    // The run row is the truth. The runner has already stored any known
    // error as the run's code, and a run a rejection left open is closed
    // below with a fixed code, so no error text reaches the terminal (C3.6).
  }
  const started = await getRun(db, runId);
  if (started?.status !== "awaiting_confirm") {
    if (isOpen(started)) return closeFailed(db, runId, SEED_UNEXPECTED_STATUS);
    return { kind: "failed", runId, code: started?.errorCode ?? SEED_UNEXPECTED_STATUS };
  }

  const rows = await listCandidates(db, runId);
  if (pick > rows.length) return closeFailed(db, runId, SEED_PICK_MISSING);
  const chosen = rows[pick - 1];
  const candidate = CandidateRow.safeParse(chosen?.data);
  if (chosen === undefined || !candidate.success) return closeFailed(db, runId, SEED_PICK_MISSING);
  const { name, publisher, qlooName } = candidate.data;
  const picked: SeedCandidate = { rank: pick, name, publisher, qlooName };

  // The confirm route claims the run the same way before continueRun, so a
  // run the restart sweep or anything else has moved is never continued.
  if (!(await claimRunStatus(db, runId, "awaiting_confirm", "running"))) {
    return { kind: "failed", runId, code: SEED_UNEXPECTED_STATUS };
  }
  try {
    await agent.runner.continueRun(runId, chosen.id);
  } catch {
    // As for startRun: the row read next decides the outcome.
  }
  const finished = await getRun(db, runId);
  if (finished?.status === "done") {
    const { board } = await previewRun(db, runId);
    return { kind: "done", runId, picked, guests: board.length };
  }
  if (isOpen(finished)) return closeFailed(db, runId, SEED_UNEXPECTED_STATUS);
  return { kind: "failed", runId, code: finished?.errorCode ?? SEED_UNEXPECTED_STATUS };
}
