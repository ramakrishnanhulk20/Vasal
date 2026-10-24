import { z } from "zod";
import { DEFAULT_LIMITS } from "../agent/loop.js";
import { createAnthropicModel, type ModelClient } from "../agent/model.js";
import { resolveShow } from "../agent/resolve.js";
import { createAgentRunner, FEED_TIMEOUT_MS, fetchShowFeed, runContextFor, type AgentFeeds } from "../agent/runner.js";
import { guessWithoutQloo, publisherForPrompt, WITHOUT_QLOO_UNAVAILABLE, type WithoutQlooEvent } from "../agent/without-qloo.js";
import { lookupShow, searchShows } from "../feeds/lookup.js";
import { parseFeed } from "../feeds/rss.js";
import { safeFetch } from "../net/safe-fetch.js";
import { createQlooClient } from "../qloo/client.js";
import { createMeteredQloo, type MeteredQloo, type MeteredRawQloo } from "../qloo/metered.js";
import type { AgentPort } from "../server/agent-port.js";
import {
  appendEvent,
  claimBrief,
  claimRunStatus,
  createRun,
  finishRun,
  getRun,
  getWithoutQloo,
  listBoard,
  listCandidates,
  listEventsAfter,
  parseBoardGuest,
  type RunInput,
  type RunRecord,
  type StoredBoardGuest,
} from "../server/runs.js";
import type { Db } from "../store/db.js";
import { reserve, waitForQlooSlot } from "../store/meter.js";
import { cleanText } from "../text/normalize.js";
import { isWritable, readBriefs, type RunBriefs } from "./promote.js";

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
/**
 * What the seed needs from the agent: the show lookup on its own, the real
 * runner, and the model, Qloo client and feeds the runner was built from,
 * which the guesses backfill spends through.
 */
export type SeedAgent = {
  preview(show: string): Promise<SeedCandidate[]>;
  runner: AgentPort;
  model: ModelClient;
  qloo: MeteredQloo;
  feeds: AgentFeeds;
};
/**
 * How seedShow ended. A failed outcome carries only a fixed upper-case code,
 * never error text (C3.6). A done outcome's pastGuests is read from the run's
 * done event, and is null when that event has none or it cannot be read. Its
 * briefs are where every board guest's brief stood after writeBriefs.
 */
export type SeedOutcome =
  | { kind: "preview"; candidates: SeedCandidate[] }
  | {
      kind: "done";
      runId: string;
      picked: SeedCandidate;
      guests: number;
      pastGuests: { checked: boolean; skipped: number } | null;
      briefs: RunBriefs;
    }
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

// A run holds at most 500 events (appendEvent in server/runs.ts), so one page
// this size always reaches its done event.
const RUN_EVENT_PAGE = 500;
// A brief is at most two drafts of 45 seconds each (agent/brief.ts), and a
// board at most 10 guests (finish_board), so 3 at a time finish within 6
// minutes even if every draft runs to its limit, inside the 10 minutes an ops
// command gets. Few at once, because a rate-limited call still fails its
// attempt and a guest has only two.
const BRIEF_WRITERS = 3;

// Read back through a schema like any stored row, so a done event written
// before past guests were counted, or one that does not fit, reads as null
// rather than as a count nobody made (C6.5).
const DonePastGuests = z.object({
  pastGuests: z.object({ checked: z.boolean(), skipped: z.number().int().min(0) }).strict(),
});

async function pastGuestsOf(db: Db, runId: string): Promise<{ checked: boolean; skipped: number } | null> {
  const done = (await listEventsAfter(db, runId, 0, RUN_EVENT_PAGE)).findLast((event) => event.event === "done");
  const parsed = DonePastGuests.safeParse(done?.data);
  return parsed.success ? parsed.data.pastGuests : null;
}

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
  waitForQlooSlot: (target: Db, signal?: AbortSignal) => Promise<boolean>;
  reserveModelTokens: (amount: number) => Promise<boolean>;
} {
  return {
    // The signal is the run's deadline, so a seed run never waits for a slot past it (C2.4).
    waitForQlooSlot: (target, signal) => waitForQlooSlot(target, { dayKey: SEED_QLOO_DAY, ...(signal === undefined ? {} : { signal }) }),
    reserveModelTokens: (amount) => reserve(db, [{ key: SEED_MODEL_DAY, amount }]),
  };
}

/**
 * Builds the seed's agent from given parts, so a test can pass fakes and
 * createSeedAgent the real ones. runner is the real agent runner
 * (createAgentRunner) with `deps.qloo`, `deps.harness` (the metered raw path
 * find_person's harness spends through) and `deps.model` for every surface,
 * so whatever surface a run records, it spends only through the meter those
 * parts were built with; from createSeedAgent that is qloo:day:offline,
 * qloo:month and anthropic:day:offline. preview(show) runs only the show
 * lookup startRun runs (resolveShow, with no exclusions), which spends one
 * metered Qloo search per directory match, and returns the candidates ranked
 * from 1. preview writes nothing to the runs tables. model, qloo and feeds
 * are `deps.model`, `deps.qloo` and `deps.feeds` themselves. Neither runs the
 * server's start-up sweep, touches an in-flight counter or promotes a run.
 * Building throws nothing. preview rejects with what resolveShow throws:
 * AgentError SHOW_NOT_FOUND, SHOW_NO_QLOO_MATCH or FEED_UNAVAILABLE, a
 * FeedError, a QlooError such as QLOO_BUDGET, or a StoreError. The runner
 * throws as createAgentRunner documents.
 */
export function seedAgentFrom(
  db: Db,
  deps: { qloo: MeteredQloo; harness: MeteredRawQloo; model: ModelClient; feeds: AgentFeeds; trends: boolean },
): SeedAgent {
  const runner = createAgentRunner({
    db,
    qlooFor: () => deps.qloo,
    harnessFor: () => deps.harness,
    modelFor: () => deps.model,
    feeds: deps.feeds,
    trends: deps.trends,
  });
  return {
    async preview(show) {
      const shows = await resolveShow({ show, exclude: [] }, { ...deps.feeds, qloo: deps.qloo });
      return shows.map((found, index) => ({ rank: index + 1, name: found.name, publisher: found.publisher, qlooName: found.qlooName }));
    },
    runner,
    model: deps.model,
    qloo: deps.qloo,
    feeds: deps.feeds,
  };
}

/**
 * The real seed agent: the server's own metered Qloo client and shared cache
 * (createMeteredQloo) over a client with no retries, the Anthropic model,
 * and the directory lookup, feed fetcher and feed parser main.ts gives the
 * server, so a seed run is researched exactly as a visitor's is (C9.2). The
 * meter is seedMeterHooks, so every Qloo call, find_person's harness
 * requests included, charges qloo:day:offline and qloo:month, every model
 * call anthropic:day:offline, and nothing else (C5.1). It never runs the
 * server's start-up sweep, touches an in-flight counter or promotes a run,
 * and it makes no network call until preview or the runner is used. Throws QlooError QLOO_KEY_MISSING for a blank Qloo key
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
  return seedAgentFrom(db, { qloo, harness: qloo, model, feeds: { searchShows, lookupShow, safeFetch, parseFeed }, trends: opts.trends });
}

/**
 * Operator use, on the owner connection, before a run is promoted (C6.3).
 * For a done run, claims every board guest's brief that readBriefs marks
 * writable (never claimed, or failed on its first attempt, whose claim
 * claimBrief moves back to pending as the website's second attempt would)
 * with the per-run limit set to the board's size, so no guest is left out by
 * the website's limit of 5, and calls runner.writeBrief for each claim it
 * wins, 3 at a time. Spending is whatever the runner's model charges; from
 * createSeedAgent that is anthropic:day:offline alone, since writing a brief
 * calls no Qloo tool. A run that is not done, or a runner whose ready is
 * false, is read and left alone. Every claim and write that throws is
 * dropped, because the claim row read back afterwards is the outcome, and a
 * claim the runner left pending stays pending. Returns readBriefs after the
 * writes. Throws as readBriefs does, so a database that fails on the last
 * read fails the command.
 */
export async function writeBriefs(db: Db, runner: Pick<AgentPort, "ready" | "writeBrief">, runId: string): Promise<RunBriefs> {
  const before = await readBriefs(db, runId);
  const queue = before.guests.filter((guest) => isWritable(guest.state));
  if (before.status !== "done" || runner.ready === false || queue.length === 0) return before;
  const boardSize = before.guests.length;
  const writeNext = async (): Promise<void> => {
    for (let guest = queue.shift(); guest !== undefined; guest = queue.shift()) {
      try {
        if ((await claimBrief(db, before.runId, guest.id, boardSize)) === "claimed") await runner.writeBrief(before.runId, guest.id);
      } catch {
        // The runner has already stored any known failure as the claim's code
        // and marked an unknown one UNEXPECTED, so no error text is kept.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(BRIEF_WRITERS, queue.length) }, writeNext));
  return readBriefs(db, runId);
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
 * route does, runs continueRun on that candidate, writes the board's briefs
 * through writeBriefs with the same runner, and returns done with the pick,
 * the board's guest count, the done event's pastGuests (null when absent or
 * unreadable) and the briefs as they then stand. continueRun adds the run's
 * Without Qloo flip as part of the run, on the same meter. A brief that failed leaves
 * the outcome done, and promote refuses the run until it is written. Each
 * outcome is read from the run row and its
 * events, never from what the runner returned or threw. A run that failed in the
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
 * writer first, and PromoteError or StoreError from reading the briefs.
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
    const briefs = await writeBriefs(db, agent.runner, runId);
    return { kind: "done", runId, picked, guests: briefs.guests.length, pastGuests: await pastGuestsOf(db, runId), briefs };
  }
  if (isOpen(finished)) return closeFailed(db, runId, SEED_UNEXPECTED_STATUS);
  return { kind: "failed", runId, code: finished?.errorCode ?? SEED_UNEXPECTED_STATUS };
}

/** Why the guesses backfill left a run alone: not done (or unknown), no readable board, or no one stored show the board was built for. */
export type GuessesRefusal = "GUESSES_NOT_DONE" | "GUESSES_NO_BOARD" | "GUESSES_NO_SHOW";
/** What ops guesses would do for a run, read from storage alone. */
export type GuessesPlan =
  | { kind: "ready"; runId: string; showName: string; guests: number }
  | { kind: "has"; runId: string }
  | { kind: "refused"; runId: string; code: GuessesRefusal };
/** What ops guesses --yes did for a run. A flip that came back unavailable is still stored. */
export type GuessesOutcome = Exclude<GuessesPlan, { kind: "ready" }> | { kind: "added"; runId: string; flip: WithoutQlooEvent };

type GuessInputs =
  | Exclude<GuessesPlan, { kind: "ready" }>
  | { kind: "ready"; run: RunRecord; show: z.output<typeof CandidateRow>; showName: string; board: StoredBoardGuest[] };

// The runner writes this on every board row as cleanText(qlooName, 200)
// trimmed, so the same cleaner on each candidate finds the show it researched.
const MAX_SHOW_NAME_CHARS = 200;

async function guessInputs(db: Db, runId: string): Promise<GuessInputs> {
  const run = await getRun(db, runId);
  if (run === null || run.status !== "done") return { kind: "refused", runId, code: "GUESSES_NOT_DONE" };
  // An unavailable flip is no flip, so the command may try again.
  if ((await getWithoutQloo(db, run.id))?.status === "done") return { kind: "has", runId };
  // listBoard hands back parsed JSON, and parseBoardGuest reads stored text,
  // so each row goes back to text to pass the schema the runner and the home
  // page read it with. One row that fails refuses the whole run (C6.5).
  const board = (await listBoard(db, run.id)).map((row) => parseBoardGuest(JSON.stringify(row.data)));
  const guests = board.filter((guest): guest is StoredBoardGuest => guest !== null);
  const [first] = guests;
  if (first === undefined || guests.length !== board.length) return { kind: "refused", runId, code: "GUESSES_NO_BOARD" };
  const { showName } = first;
  if (guests.some((guest) => guest.showName !== showName)) return { kind: "refused", runId, code: "GUESSES_NO_SHOW" };
  const shows = (await listCandidates(db, run.id))
    .map((row) => CandidateRow.safeParse(row.data))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
    .filter((candidate) => cleanText(candidate.qlooName, { maxChars: MAX_SHOW_NAME_CHARS }).trim() === showName);
  const [show, ...others] = shows;
  if (show === undefined || others.length > 0) return { kind: "refused", runId, code: "GUESSES_NO_SHOW" };
  return { kind: "ready", run, show, showName, board: guests };
}

/**
 * What ops guesses would do for a run, from storage alone, with no agent, so
 * it can spend nothing. "ready" with the board's show name and guest count
 * for a done run that has no done flip yet; "has" when its latest
 * "without_qloo" event is a done flip; "refused" with GUESSES_NOT_DONE for a
 * run that is unknown or not done, GUESSES_NO_BOARD when it has no board or a
 * board row fails the runner's schema, and GUESSES_NO_SHOW unless exactly one
 * readable stored candidate's Qloo name, cleaned the way the runner cleans
 * it, is the board's show name. Throws ServerError("SRV_UNAVAILABLE") if the
 * database fails.
 */
export async function planGuesses(db: Db, runId: string): Promise<GuessesPlan> {
  const inputs = await guessInputs(db, runId);
  if (inputs.kind !== "ready") return inputs;
  return { kind: "ready", runId, showName: inputs.showName, guests: inputs.board.length };
}

/**
 * Operator use, on the owner connection: adds the Without Qloo flip to a done
 * run that has none, such as a showcase run made before the flip existed.
 * Checks the run as planGuesses does and returns "has" or "refused" with no
 * call made. Otherwise it rebuilds the run's context the way continueRun
 * builds it (runContextFor): the stored show, its feed read once through
 * fetchShowFeed (15 s; a feed that cannot be read leaves past guests
 * unchecked) and the run's own exclusions, with the board from run_board.
 * It runs guessWithoutQloo with `agent`'s model and Qloo client, the
 * publisher only for a directory show, under a 120 second deadline, and
 * appends the result as a "without_qloo" event, or { status: "unavailable" }
 * on any error or once the deadline has passed. Spending is at most 1 model
 * call, 8 Qloo searches and 1 insights call through `agent`; from
 * createSeedAgent that is qloo:day:offline, qloo:month and
 * anthropic:day:offline. Throws ServerError from the run store and whatever
 * fetchShowFeed rethrows.
 */
export async function addGuesses(db: Db, agent: Pick<SeedAgent, "model" | "qloo" | "feeds">, runId: string): Promise<GuessesOutcome> {
  const inputs = await guessInputs(db, runId);
  if (inputs.kind !== "ready") return inputs;
  const { run, show, board } = inputs;
  const deadline = AbortSignal.timeout(DEFAULT_LIMITS.maxWallMs);
  const url = show.feedUrl === null ? null : URL.parse(show.feedUrl);
  const feed = url === null ? null : await fetchShowFeed(agent.feeds, url, show.feedHandleSource, FEED_TIMEOUT_MS);
  const ctx = runContextFor(show, feed, run.input.exclude);
  const flip: WithoutQlooEvent = await guessWithoutQloo({
    model: agent.model,
    qloo: agent.qloo,
    ctx,
    board,
    publisher: publisherForPrompt(show),
    signal: deadline,
  }).then(
    (done) => (deadline.aborted ? WITHOUT_QLOO_UNAVAILABLE : done),
    () => WITHOUT_QLOO_UNAVAILABLE,
  );
  await appendEvent(db, run.id, "without_qloo", flip);
  return { kind: "added", runId, flip };
}
