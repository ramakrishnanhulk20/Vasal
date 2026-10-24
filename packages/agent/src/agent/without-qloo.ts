import { z } from "zod";
import type { QlooCallOptions } from "../qloo/client.js";
import { QlooError } from "../qloo/errors.js";
import type { MeteredQloo } from "../qloo/metered.js";
import type { QlooEntity } from "../qloo/schemas.js";
import { cleanText } from "../text/normalize.js";
import { reachFrom, type Reach } from "./board.js";
import type { RunContext } from "./context.js";
import type { ModelClient } from "./model.js";
import { isPastGuest, sameName } from "./past-guests.js";
import { WITHOUT_QLOO_SYSTEM } from "./prompts.js";
import { hasDied } from "./tools.js";

/** One person the model guessed with no Qloo data, as Qloo names and scores them. */
export type WithoutQlooGuess = {
  name: string;
  fit: number | null;
  fitKnown: boolean;
  reach: Reach;
  pastGuest: boolean;
  onBoard: boolean;
};

/** The flip: the guesses Qloo matched, in the model's order, and how many it could not match. */
export type WithoutQlooResult = { status: "done"; guesses: WithoutQlooGuess[]; unresolved: number };

/** What a run stores as its "without_qloo" event: the flip, or that it could not be made. */
export type WithoutQlooEvent = WithoutQlooResult | { readonly status: "unavailable" };

export const WITHOUT_QLOO_UNAVAILABLE: WithoutQlooEvent = Object.freeze({ status: "unavailable" });

const MAX_GUESSES = 8;
const MAX_GUESS_CHARS = 100;
// The same take the direct find_person search used, so a name searched by
// either one shares a cache entry.
const FIND_TAKE = 3;
// The board's name cap, so a name shows the same in both columns.
const MAX_NAME_CHARS = 120;
const MAX_SHOW_CHARS = 200;
// What the research step's recent_episode_titles tool shows the model.
const MAX_EPISODE_TITLES = 40;
const MAX_TITLE_CHARS = 200;
// Thinking counts against this allowance, and extract-guest.ts found a small
// one used up before the answer. Eight names fit many times over.
const MAX_TOKENS = 2_048;
const QLOO_ID = /^[A-Za-z0-9-]{8,64}$/;

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
// The board's rounding, so a fit here reads on the same scale as a board fit.
const round2 = (value: number) => Math.round(value * 100) / 100 || 0;

// Trimmed between cleaning and the cap, as the board and the tools do, so
// spaces hidden behind an invisible character never use up the cap.
function cleanLine(text: string, maxChars: number): string {
  const whole = cleanText(text, { maxChars: Number.POSITIVE_INFINITY }).trim();
  return cleanText(whole, { maxChars }).trim();
}

const guessLength = (text: string) => [...cleanLine(text, Number.POSITIVE_INFINITY)].length;

// The caps are checked here in code, never asked of the model (C2.1): a reply
// over 8 names, with none, or with a name that cleans to nothing or to more
// than 100 characters fails as a whole, before any Qloo call.
const GuessesSchema = z
  .object({
    guests: z
      .array(z.string().refine((text) => guessLength(text) >= 1 && guessLength(text) <= MAX_GUESS_CHARS))
      .min(1)
      .max(MAX_GUESSES),
  })
  .strict();

/**
 * The publisher the flip's prompt may carry: a directory show's publisher,
 * and null for a pasted feed, whose publisher is the hostname of the URL the
 * visitor typed, so no visitor-influenced text reaches the prompt (C2.7).
 */
export function publisherForPrompt(show: { publisher: string; feedHandleSource: "directory" | "visitor" }): string | null {
  return show.feedHandleSource === "directory" ? show.publisher : null;
}

// Each value is a JSON string, so a title that reads like an instruction
// stays a quoted value in a fixed layout.
function userMessage(ctx: RunContext, publisher: string | null): string {
  const show = cleanLine(ctx.show.name, MAX_SHOW_CHARS);
  const from = publisher === null ? "" : cleanLine(publisher, MAX_SHOW_CHARS);
  const titles = ctx.episodeTitles
    .slice(0, MAX_EPISODE_TITLES)
    .map((title) => cleanLine(title, MAX_TITLE_CHARS))
    .filter((title) => title !== "");
  return [
    `Show: ${JSON.stringify(show)}`,
    ...(from === "" ? [] : [`Publisher: ${JSON.stringify(from)}`]),
    `Recent episode titles: ${JSON.stringify(titles)}`,
  ].join("\n");
}

type Found = { personId: string; name: string; popularity: number | null };

// Qloo's nearest search hits for a name it cannot match can be anyone, so a
// hit counts only when its cleaned name matches the guess by sameName. The
// first such hit is the person, and a death date on it drops them.
async function findPerson(qloo: MeteredQloo, guess: string, options: QlooCallOptions): Promise<Found | "dead" | null> {
  const { data } = await qloo.call<QlooEntity[]>({ op: "search", query: guess, types: ["urn:entity:person"], take: FIND_TAKE }, options);
  if (!Array.isArray(data)) throw new QlooError("QLOO_SCHEMA");
  for (const entity of data.slice(0, FIND_TAKE)) {
    const name = cleanLine(entity.name, MAX_NAME_CHARS);
    if (!QLOO_ID.test(entity.entity_id) || name === "" || !sameName(guess, name)) continue;
    if (hasDied(entity)) return "dead";
    return { personId: entity.entity_id, name, popularity: isFiniteNumber(entity.popularity) ? entity.popularity : null };
  }
  return null;
}

type Score = { affinity: number; popularity: number | null };

// The exact request the runner's scoreFit sends for the board, so the flip's
// fits and the board's share one signal and one scale. Read the same way:
// the first finite affinity per id counts, and a death date drops the person.
async function scoreAll(
  qloo: MeteredQloo,
  showId: string,
  ids: readonly string[],
  options: QlooCallOptions,
): Promise<{ scores: ReadonlyMap<string, Score>; dead: ReadonlySet<string> }> {
  const scores = new Map<string, Score>();
  const dead = new Set<string>();
  if (ids.length === 0) return { scores, dead };
  const { data } = await qloo.call<QlooEntity[]>(
    { op: "insights", filterType: "urn:entity:person", signalEntities: [showId], resultEntities: [...ids], take: ids.length },
    options,
  );
  if (!Array.isArray(data)) throw new QlooError("QLOO_SCHEMA");
  const wanted = new Set(ids);
  for (const entity of data) {
    if (!wanted.has(entity.entity_id)) continue;
    if (hasDied(entity)) {
      dead.add(entity.entity_id);
      continue;
    }
    const affinity = entity.query?.affinity ?? entity.properties?.affinity;
    if (scores.has(entity.entity_id) || !isFiniteNumber(affinity)) continue;
    scores.set(entity.entity_id, { affinity, popularity: isFiniteNumber(entity.popularity) ? entity.popularity : null });
  }
  return { scores, dead };
}

/**
 * The "Without Qloo" flip: asks the same model for guests with no data and no
 * tools, then lets Qloo name and score each guess.
 *
 * Makes one model.structured call with WITHOUT_QLOO_SYSTEM and a user message
 * of the show's name (ctx.show.name, Qloo's), `publisher` when it is not null
 * (pass publisherForPrompt's answer) and the first 40 of ctx.episodeTitles,
 * each cleaned and written as a JSON string. The reply must be { guests } with
 * 1 to 8 names, each 1 to 100 characters after cleanText. Names the same
 * person under sameName are searched once. Each name then gets one metered
 * person search (take 3); the first hit whose cleaned name matches by sameName
 * is the person, a name with no such hit counts as unresolved, and a person a
 * death date marks in either answer is dropped. Every person found is scored
 * in one insights call, the request scoreFit sends (signal the show,
 * filter.results.entities), and no call is made when nobody was found. So it
 * spends at most 1 model call, 8 searches and 1 insights call, all through
 * `model` and `qloo`, each carrying `signal` when given.
 *
 * Returns the matched guesses in the model's order, each with Qloo's cleaned
 * name (at most 120 characters), fit (the affinity rounded to 2 decimals, or
 * null with fitKnown false), reach (reachFrom the fit answer's popularity,
 * else the search hit's), pastGuest (isPastGuest on ctx.pastGuests.index;
 * past guests are kept and flagged) and onBoard (the id is on `board`). The
 * model's own strings are never returned, and neither is any Qloo id. Reads
 * ctx and changes nothing in it.
 *
 * Throws whatever model.structured throws, including AgentError
 * AGENT_BAD_PROSE for a reply outside the schema; any QlooError the calls
 * throw, such as QLOO_BUDGET or QLOO_TIMEOUT once `signal` fires, and
 * QLOO_SCHEMA for an answer that is not a list; and StoreError from the meter.
 */
export async function guessWithoutQloo(deps: {
  model: ModelClient;
  qloo: MeteredQloo;
  ctx: RunContext;
  board: readonly { personId: string }[];
  publisher: string | null;
  signal?: AbortSignal;
}): Promise<WithoutQlooResult> {
  const { model, qloo, ctx } = deps;
  const options: QlooCallOptions = deps.signal === undefined ? {} : { signal: deps.signal };
  const reply = await model.structured(
    { system: WITHOUT_QLOO_SYSTEM, user: userMessage(ctx, deps.publisher), schema: GuessesSchema, maxTokens: MAX_TOKENS },
    options,
  );

  const asked: string[] = [];
  for (const raw of reply.guests) {
    const guess = cleanLine(raw, MAX_GUESS_CHARS);
    // A person the visitor excluded stays off this side too, and costs no
    // search (C2.7: exclusions are applied in code and never shown to the model).
    if (ctx.exclusions.some((excluded) => sameName(excluded, guess))) continue;
    if (!asked.some((earlier) => sameName(earlier, guess))) asked.push(guess);
  }

  const found: Found[] = [];
  let unresolved = 0;
  for (const guess of asked) {
    const person = await findPerson(qloo, guess, options);
    if (person === null) unresolved += 1;
    else if (person !== "dead" && !found.some((earlier) => earlier.personId === person.personId)) found.push(person);
  }

  const { scores, dead } = await scoreAll(
    qloo,
    ctx.show.qlooId,
    found.map((person) => person.personId),
    options,
  );
  const onBoard = new Set(deps.board.map((entry) => entry.personId));
  const guesses = found
    .filter((person) => !dead.has(person.personId))
    .map((person): WithoutQlooGuess => {
      const score = scores.get(person.personId);
      return {
        name: person.name,
        fit: score === undefined ? null : round2(score.affinity),
        fitKnown: score !== undefined,
        reach: reachFrom(score?.popularity ?? person.popularity),
        pastGuest: isPastGuest(ctx.pastGuests.index, person.name),
        onBoard: onBoard.has(person.personId),
      };
    });
  return { status: "done", guesses, unresolved };
}
