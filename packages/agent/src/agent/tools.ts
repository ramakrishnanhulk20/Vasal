import type Anthropic from "@anthropic-ai/sdk";
import { createDirectQlooWorkflowExecutor, createNativeQlooResolutionProvider, type QlooWorkflowExecutor } from "@qloo/qloo-harness";
import { z } from "zod";
import type { QlooCallOptions } from "../qloo/client.js";
import { QlooError } from "../qloo/errors.js";
import { createMeteredHarnessClient, NO_OP_OBSERVER } from "../qloo/harness-adapter.js";
import type { MeteredQloo, MeteredRawQloo } from "../qloo/metered.js";
import type { EntityType, QlooOperation } from "../qloo/request.js";
import { NORMALISED_SCHEMAS, type QlooCompareResult, type QlooDemographic, type QlooEntity, type QlooTrendRow } from "../qloo/schemas.js";
import { StoreError } from "../store/errors.js";
import { cleanText, normalizeName } from "../text/normalize.js";
import { reachFrom, risingFrom, strongestSegments } from "./board.js";
import type { Demographics, RunContext, SharedTag, StepSummary } from "./context.js";
import { isPastGuest, matchKey, sameName } from "./past-guests.js";
import {
  ACCUSATIONS_RULE,
  checkProse,
  FAMILY_RULE,
  isShowableTag,
  isShowableTagId,
  type ProseCheck,
  RELEASE_CLAIM_RULE,
  SENSITIVE_TRAITS_RULE,
  TREND_CLAIM_WORDS,
  withoutLinks,
} from "./prose.js";

export type ToolName =
  | "people_for_show"
  | "audience_of"
  | "trend_of"
  | "shared_taste"
  | "upcoming_releases"
  | "find_person"
  | "recent_episode_titles"
  | "finish_board";

/** Most calls the model may make to each tool in one run. Past this, a call is refused with no Qloo request. */
export const TOOL_LIMITS: Record<ToolName, number> = Object.freeze({
  people_for_show: 3,
  audience_of: 10,
  trend_of: 10,
  shared_taste: 10,
  upcoming_releases: 3,
  find_person: 6,
  recent_episode_titles: 1,
  finish_board: 2,
});

export type ToolOutcome = { content: string; isError: boolean; finished?: Array<{ personId: string; angle: string }> };

/**
 * Run-wide tool settings. With trends false, trend_of is never offered or run, and angles may not call anyone rising.
 * `signal`, when given, goes with every Qloo call a tool makes and fires at the run's deadline.
 */
export type ToolOptions = { trends: boolean; signal?: AbortSignal };

const MAX_CONTENT_CHARS = 4_000;
const MAX_NAME_CHARS = 120;
const MAX_TITLE_CHARS = 200;
const MAX_EPISODE_TITLES = 40;
const MAX_ANGLE_CHARS = 200;
// The schema cap is loose on purpose: an angle over 200 characters is reported
// for that one pick as too_long, which the model can fix, instead of failing
// the whole call. The cap still bounds what is held in memory.
const MAX_ANGLE_INPUT_CHARS = 2_000;
const MAX_FIND_NAME_CHARS = 100;
const MIN_PICKS = 3;
const MAX_PICKS = 10;
const PEOPLE_TAKE = 20;
// Qloo returns past titles too and only those dated ahead are kept: in the
// first live sample 12 of 20 films survived, so 20 leaves a usable list.
const RELEASES_TAKE = 20;
const FIND_TAKE = 3;
const COMPARE_TAKE = 10;
const SHARED_TASTES_SHOWN = 5;
// Must equal MAX_TAG_CHARS in board.ts, which cuts a longer tag to fit its
// chip. A cut can end on a new whole word ("...Blackjack" becomes
// "...Black"), so a longer tag is dropped here and the board never cuts one.
const MAX_TAG_CHARS = 40;
const SEGMENTS_SHOWN = 3;
const WEEKS_OF_TREND = 12;
const DAY_MS = 86_400_000;

// The same shape the request builder accepts for an entity id, so an id kept
// here is always one a later request can carry.
const QLOO_ID = /^[A-Za-z0-9-]{8,64}$/;

const REACH = ["any", "bookable", "emerging"] as const;
const POPULARITY_MAX: Record<(typeof REACH)[number], number | undefined> = { any: undefined, bookable: 0.9, emerging: 0.7 };

const RELEASE_KINDS = ["movie", "tv_show", "book"] as const;
type ReleaseKind = (typeof RELEASE_KINDS)[number];
const RELEASE_TYPE: Record<ReleaseKind, EntityType> = {
  movie: "urn:entity:movie",
  tv_show: "urn:entity:tv_show",
  book: "urn:entity:book",
};
const RELEASE_WORDS: Record<ReleaseKind, string> = { movie: "movies", tv_show: "TV shows", book: "books" };
const RELEASE_DATE_PROPERTY: Record<ReleaseKind, "release_date" | "publication_date"> = {
  movie: "release_date",
  tv_show: "release_date",
  book: "publication_date",
};
const UPCOMING_DAYS = 730;
const RELEASE_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const RELEASE_YEAR = /^[1-9]\d{3}$/;
// A title of one word once articles go ("Up", "Wicked", "The Studio") is an
// everyday word, so matching it would refuse ordinary angles. The phrase
// check in checkProse still covers a claim about one.
const MIN_RELEASE_TITLE_WORDS = 2;
const RELEASE_TITLE_ARTICLES: ReadonlySet<string> = new Set(["the", "a", "an"]);
const MAX_HINT_TITLE_CHARS = 120;

// Taken from ProseCheck's reasons, so a new prose reason fails to compile
// until PICK_HINTS has a hint for it.
type RejectReason = "unknown_person" | "duplicate" | NonNullable<ProseCheck["reason"]>;

// A refusal code alone does not tell the model what to change, so it can
// repeat the same mistake until the board is lost. Each hint is fixed text
// that quotes nothing the model or Qloo wrote (C2.1).
export const PICK_HINTS: Record<RejectReason, string> = Object.freeze({
  unknown_person: "Use a personId exactly as a tool returned it in this run.",
  duplicate: "Pick each person once.",
  digits: "Leave numbers out, in digits and in words. The app shows numbers itself.",
  too_long: "Keep the angle under 200 characters.",
  empty: "Write one plain sentence.",
  trend_claim: `Qloo has no trend data right now, so do not call anyone ${TREND_CLAIM_WORDS}. A past breakout role or album is fine.`,
  sensitive_trait: SENSITIVE_TRAITS_RULE,
  accusation: ACCUSATIONS_RULE,
  release_claim: RELEASE_CLAIM_RULE,
  family_claim: FAMILY_RULE,
});

const PersonId = z.string().min(1).max(64);

const INPUTS = {
  people_for_show: z.object({ reach: z.enum(REACH) }).strict(),
  audience_of: z.object({ personId: PersonId }).strict(),
  trend_of: z.object({ personId: PersonId }).strict(),
  shared_taste: z.object({ personId: PersonId }).strict(),
  upcoming_releases: z.object({ kind: z.enum(RELEASE_KINDS) }).strict(),
  find_person: z.object({ name: z.string().trim().min(1).max(MAX_FIND_NAME_CHARS) }).strict(),
  recent_episode_titles: z.object({}).strict(),
  finish_board: z
    .object({
      picks: z
        .array(z.object({ personId: PersonId, angle: z.string().max(MAX_ANGLE_INPUT_CHARS) }).strict())
        .min(MIN_PICKS)
        .max(MAX_PICKS),
    })
    .strict(),
} satisfies Record<ToolName, z.ZodType>;

type Inputs = { [K in ToolName]: z.output<(typeof INPUTS)[K]> };
type Handler<K extends ToolName> = (
  ctx: RunContext,
  qloo: MeteredQloo,
  input: Inputs[K],
  today: Date,
  opts: ToolOptions,
) => Promise<ToolOutcome>;

const PERSON_ID_PROPERTY = {
  type: "string",
  description: "A personId exactly as an earlier tool result in this run gave it.",
};

function toolDefinition(name: ToolName, description: string, properties: Record<string, unknown>): Anthropic.Tool {
  return {
    name,
    description,
    strict: true,
    input_schema: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
  };
}

/**
 * The fixed list of research tools the model is offered (C2.2). Each is
 * strict, rejects extra keys and requires every property. Length and count
 * limits are stated in the descriptions and enforced by runTool's own schemas,
 * because strict tool schemas do not accept those keywords. With trends
 * false, trend_of is left out, so the model is never offered a call that
 * would come back empty. Returns new objects on every call.
 */
export function researchTools(opts: ToolOptions): Anthropic.Tool[] {
  const tools = [
    toolDefinition(
      "people_for_show",
      "List up to 20 people whose fans overlap most with this show's audience, best match first. " +
        "reach 'any' has no fame limit, 'bookable' leaves out the most famous names, 'emerging' keeps only lesser known people. " +
        "Call this first: the other tools only accept a personId that a tool returned earlier in this run. " +
        `At most ${TOOL_LIMITS.people_for_show} calls per run.`,
      { reach: { type: "string", enum: [...REACH], description: "How famous the people may be." } },
    ),
    toolDefinition(
      "audience_of",
      "Who a person's fans are: the age bands and genders where their audience is strongest. " +
        "The app compares it with the show's own audience to find an audience group this guest's fans lean toward more than the show's listeners do. " +
        `At most ${TOOL_LIMITS.audience_of} calls per run.`,
      { personId: PERSON_ID_PROPERTY },
    ),
    toolDefinition(
      "trend_of",
      "Whether interest in a person is rising, steady or falling over the last 12 weeks. " +
        `At most ${TOOL_LIMITS.trend_of} calls per run.`,
      { personId: PERSON_ID_PROPERTY },
    ),
    toolDefinition(
      "shared_taste",
      "The tastes this show's audience and a person's audience have in common, as short tag names. " +
        "Good material for why a guest fits. " +
        `At most ${TOOL_LIMITS.shared_taste} calls per run.`,
      { personId: PERSON_ID_PROPERTY },
    ),
    toolDefinition(
      "upcoming_releases",
      "Upcoming movies, TV shows or books this show's audience is likely to care about, as titles only. " +
        "A guest with something new out is easier to book. To check a person behind a title, look them up with find_person. " +
        `At most ${TOOL_LIMITS.upcoming_releases} calls per run.`,
      { kind: { type: "string", enum: [...RELEASE_KINDS], description: "Which kind of release to list." } },
    ),
    toolDefinition(
      "find_person",
      "Look up a person by name and get up to 3 matches, each with a personId the other tools accept. " +
        `At most ${TOOL_LIMITS.find_person} calls per run.`,
      { name: { type: "string", description: "The person's name, up to 100 characters." } },
    ),
    toolDefinition(
      "recent_episode_titles",
      "Titles of the show's recent episodes, so you can see what the show covers. Call it once.",
      {},
    ),
    toolDefinition(
      "finish_board",
      "Submit the final guest picks: 3 to 10 of them, each a personId from an earlier result and an angle of up to 200 characters " +
        "saying why this guest fits the show. Angles must contain no digits or other numbers, no links and no email addresses: " +
        "do not state figures at all, the app shows every number from the data itself. " +
        "If some picks are rejected you get the reasons and one more try.",
      {
        picks: {
          type: "array",
          description: "3 to 10 picks, best first.",
          items: {
            type: "object",
            properties: {
              personId: PERSON_ID_PROPERTY,
              angle: { type: "string", description: "Why this guest fits, up to 200 characters, no numbers or links." },
            },
            required: ["personId", "angle"],
            additionalProperties: false,
          },
        },
      },
    ),
  ];
  return opts.trends ? tools : tools.filter((tool) => tool.name !== "trend_of");
}

const isToolName = (name: string): name is ToolName => Object.hasOwn(TOOL_LIMITS, name);

// Bound once in runTool rather than passed at each call site, so a handler
// added later cannot make a Qloo call that outlives the run (C2.4).
function withSignal(qloo: MeteredQloo, signal: AbortSignal): MeteredQloo {
  return {
    call: <T>(op: QlooOperation, options: QlooCallOptions = {}) =>
      qloo.call<T>(op, { ...options, signal: options.signal === undefined ? signal : AbortSignal.any([signal, options.signal]) }),
    stats: () => qloo.stats(),
  };
}

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const round2 = (value: number) => Math.round(value * 100) / 100 || 0;
const isoDate = (date: Date) => date.toISOString().slice(0, 10);

// Upstream text is cleaned once on the way in by the shared cleaner, before
// the model or a page sees it (C2.8, C3.7). It is trimmed between cleaning
// and the cap, so spaces hidden behind an invisible character never use up
// the cap.
function cleanField(value: string, maxChars: number): string {
  const whole = cleanText(value, { maxChars: Number.POSITIVE_INFINITY }).trim();
  return cleanText(whole, { maxChars }).trim();
}

function step(ctx: RunContext, tool: StepSummary["tool"], ok: boolean, summary: string): void {
  ctx.steps.push({ tool, ok, summary });
}

function refusal(ctx: RunContext, tool: StepSummary["tool"], code: string, summary: string): ToolOutcome {
  step(ctx, tool, false, summary);
  return { content: JSON.stringify({ error: code }), isError: true };
}

// Drops whole items from the end until the JSON fits (C2.8). Text is never cut
// here; every string was already capped when it came in. Extra fields are
// counts only, written next to the list and inside the same cap.
function listContent<T>(key: string, items: readonly T[], extra: Readonly<Record<string, number>> = {}): string {
  for (let kept = items.length; kept > 0; kept -= 1) {
    const omitted = items.length - kept;
    const text = JSON.stringify(
      omitted > 0 ? { [key]: items.slice(0, kept), ...extra, omitted } : { [key]: items.slice(0, kept), ...extra },
    );
    if (text.length <= MAX_CONTENT_CHARS) return text;
  }
  return JSON.stringify(items.length > 0 ? { [key]: [], ...extra, omitted: items.length } : { [key]: [], ...extra });
}

// Counted from this answer only, so the number is what this call left out,
// never a running total the model could read as new people dropped.
function pastGuestsLeftOut(ctx: RunContext, answer: readonly QlooEntity[]): Readonly<Record<string, number>> {
  const skipped = new Set(answer.map((entity) => entity.entity_id).filter((id) => ctx.pastGuests.skipped.has(id))).size;
  return skipped > 0 ? { skippedPastGuests: skipped } : {};
}

function listOf<T>(data: unknown): T[] {
  if (!Array.isArray(data)) throw new QlooError("QLOO_SCHEMA");
  return data as T[];
}

function compareOf(data: unknown): QlooCompareResult {
  if (typeof data !== "object" || data === null) throw new QlooError("QLOO_SCHEMA");
  const { tags, a, b } = data as Partial<QlooCompareResult>;
  if (!Array.isArray(tags) || !Array.isArray(a) || !Array.isArray(b)) throw new QlooError("QLOO_SCHEMA");
  return { tags, a, b };
}

// compare.tags matches tag ids only, and the same concept often sits in
// different tag families on a show and a person, so a name both sides carry
// counts as shared too. Every name goes through cleanField and then
// normalizeName before it is matched or deduplicated, so both sides of each
// comparison come out of the same normaliser. A tag counts only when its id
// is in a family that may be shown, and a name matched across the sides only
// when both sides' tags are, so a show's genre tag never stands in for a
// person's identity tag of the same name. A side tag with no string id is
// dropped.
function sharedTagsOf({ tags, a, b }: QlooCompareResult): SharedTag[] {
  const showable = (tag: Readonly<Record<string, unknown>>) => {
    const id = tag["tag_id"];
    return typeof id === "string" && isShowableTagId(id);
  };
  const keyOf = (name: string) => normalizeName(cleanField(name, MAX_NAME_CHARS));
  const personSide = new Set(b.filter(showable).map((tag) => keyOf(tag.name)));
  const seen = new Set<string>();
  const shared: SharedTag[] = [];
  const add = (raw: string, score: number | null) => {
    const name = cleanField(raw, MAX_NAME_CHARS);
    const key = normalizeName(name);
    if (key === "" || seen.has(key)) return;
    seen.add(key);
    shared.push({ name, score });
  };
  for (const tag of tags) if (showable(tag)) add(tag.name, isFiniteNumber(tag.query?.score) ? tag.query.score : null);
  for (const tag of a) if (showable(tag) && personSide.has(keyOf(tag.name))) add(tag.name, null);
  return shared;
}

/**
 * True when a Qloo entity carries a death date. Qloo ranks people who have
 * died as high as anyone, and they can never be booked. Any value that is not
 * empty counts, including one in a shape never seen, so an odd value drops
 * the person rather than letting them in.
 */
export function hasDied(entity: QlooEntity): boolean {
  const died = entity.properties?.date_of_death;
  return died !== undefined && died !== null && died !== "";
}

/** Takes a person out of the run and refuses their id for the rest of it (ctx.dropped). */
export function dropPerson(ctx: RunContext, personId: string): void {
  ctx.people.delete(personId);
  ctx.dropped.add(personId);
}

// Every person a tool returns passes through here, so a person dropped here
// never reaches the model, the board, compare or demographics. Past guests
// stop here too: anyone an episode title or one of the show's own names
// holds is left out and counted in ctx.pastGuests.skipped, so their id is
// one no tool returned and every later tool refuses it as an unknown person
// with no Qloo call (C2.2).
function recordPerson(ctx: RunContext, entity: QlooEntity, affinity: number | null): { personId: string; name: string } | null {
  if (!QLOO_ID.test(entity.entity_id)) return null;
  // A later answer may spell the name another way or leave the death date
  // out, and neither makes a dropped person bookable again.
  if (ctx.dropped.has(entity.entity_id)) return null;
  // A later answer can carry a death date an earlier one lacked; the person
  // then leaves the run, so the board never lists them.
  if (hasDied(entity)) {
    dropPerson(ctx, entity.entity_id);
    return null;
  }
  const name = cleanField(entity.name, MAX_NAME_CHARS);
  if (name === "") return null;
  if (isPastGuest(ctx.pastGuests.index, name)) {
    dropPerson(ctx, entity.entity_id);
    ctx.pastGuests.skipped.add(entity.entity_id);
    return null;
  }
  const popularity = isFiniteNumber(entity.popularity) ? entity.popularity : null;
  const known = ctx.people.get(entity.entity_id);
  // The first affinity seen is kept for the rest of research, so the number
  // the model was shown for a person does not move between its calls. The
  // runner's fit call then replaces it with one comparable fit per pick
  // before the board is built.
  const record = {
    name: known?.name ?? name,
    affinity: known?.affinity ?? affinity,
    popularity: known?.popularity ?? popularity,
  };
  ctx.people.set(entity.entity_id, record);
  return { personId: entity.entity_id, name: record.name };
}

function uniqueById<T extends { personId: string }>(items: Array<T | null>): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (item === null || seen.has(item.personId)) continue;
    seen.add(item.personId);
    out.push(item);
  }
  return out;
}

async function demographicsOf(qloo: MeteredQloo, entityId: string): Promise<Demographics | null> {
  const { data } = await qloo.call<QlooDemographic[]>({ op: "demographics", signalEntities: [entityId] });
  const blocks = listOf<QlooDemographic>(data);
  const block = blocks.find((candidate) => candidate.entity_id === entityId) ?? (blocks.length === 1 ? blocks[0] : undefined);
  if (block === undefined) return null;
  const finite = (breakdown: Record<string, number>) =>
    Object.fromEntries(Object.entries(breakdown).filter(([, value]) => isFiniteNumber(value)));
  return { age: finite(block.query.age), gender: finite(block.query.gender) };
}

// Monday to Sunday weeks in UTC. The newest full week is the one that ended on
// the last Sunday before today, so the week in progress is never included.
function fullWeeksBefore(today: Date, weeks: number): { startDate: string; endDate: string } {
  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const weekday = today.getUTCDay();
  const end = midnight - (weekday === 0 ? 7 : weekday) * DAY_MS;
  const start = end - (weeks * 7 - 1) * DAY_MS;
  return { startDate: isoDate(new Date(start)), endDate: isoDate(new Date(end)) };
}

// The first and last UTC day a release date can mean: one day for
// YYYY-MM-DD, the whole year for a bare year. An impossible day such as
// 2026-02-30, or any other shape, gives null.
function releaseSpan(value: unknown): { first: number; last: number } | null {
  const text = typeof value === "number" && Number.isInteger(value) ? String(value) : value;
  if (typeof text !== "string") return null;
  if (RELEASE_YEAR.test(text)) {
    const year = Number(text);
    return { first: Date.UTC(year, 0, 1), last: Date.UTC(year, 11, 31) };
  }
  const day = RELEASE_DAY.exec(text);
  if (day === null) return null;
  const ms = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
  return isoDate(new Date(ms)) === text ? { first: ms, last: ms } : null;
}

// Qloo ignores the release date filter on films and TV, and its book year
// filter still returns placeholder years centuries ahead, so each row's own
// date is checked here against today and the next two years. A bare year
// counts only when the whole year is inside that window, so a film dated just
// by a year already under way, and maybe already out, is never called
// upcoming. A row with no usable date is dropped.
function isUpcoming(entity: QlooEntity, kind: ReleaseKind, today: Date): boolean {
  const span = releaseSpan(entity.properties?.[RELEASE_DATE_PROPERTY[kind]]);
  if (span === null) return false;
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return span.first >= start && span.last <= start + UPCOMING_DAYS * DAY_MS;
}

// Both titles and angles go through this one function (C8.3). matchKey turns
// every dash, colon and other mark into a space, so "Mission: Impossible –
// The Final Reckoning" and "Mission Impossible - The Final Reckoning" give
// the same words, and dropping articles on both sides lets "the" come and go.
function releaseWords(text: string): string[] {
  return matchKey(text)
    .split(" ")
    .filter((word) => word !== "" && !RELEASE_TITLE_ARTICLES.has(word));
}

function rememberRelease(ctx: RunContext, title: string): void {
  const words = releaseWords(title);
  if (words.length < MIN_RELEASE_TITLE_WORDS) return;
  const key = words.join(" ");
  if (!ctx.releaseTitles.has(key)) ctx.releaseTitles.set(key, title);
}

// Padding both sides with a space makes the search hold whole words in a row,
// so "Dune Part Three" is found in "her work on dune part three" but "Big
// Shot" is not found in "big shots".
function releaseNamed(ctx: RunContext, angle: string): string | null {
  const text = ` ${releaseWords(angle).join(" ")} `;
  for (const [key, title] of ctx.releaseTitles) if (text.includes(` ${key} `)) return title;
  return null;
}

// The title already reached the model in upcoming_releases' result, cleaned
// there (C2.8), so naming it back adds nothing new and tells the model exactly
// what to leave out.
const releaseTitleHint = (title: string): string =>
  `Do not name the upcoming title "${cleanField(title, MAX_HINT_TITLE_CHARS)}": Qloo does not say who is in it.`;

const peopleForShow: Handler<"people_for_show"> = async (ctx, qloo, input) => {
  const popularityMax = POPULARITY_MAX[input.reach];
  const op: QlooOperation = {
    op: "insights",
    filterType: "urn:entity:person",
    signalEntities: [ctx.show.qlooId],
    take: PEOPLE_TAKE,
    explainability: true,
    ...(popularityMax === undefined ? {} : { popularityMax }),
  };
  const { data } = await qloo.call<QlooEntity[]>(op);
  const answer = listOf<QlooEntity>(data);
  const people = uniqueById(
    answer.map((entity) => {
      const affinity = entity.query?.affinity ?? entity.properties?.affinity;
      return recordPerson(ctx, entity, isFiniteNumber(affinity) ? affinity : null);
    }),
  ).map(({ personId, name }) => {
    // Qloo ranked this person for the show's audience, so the board does not
    // hold them to the find_person fit floor.
    ctx.listedForShow.add(personId);
    const record = ctx.people.get(personId);
    return {
      personId,
      name,
      affinity: isFiniteNumber(record?.affinity) ? round2(record.affinity) : null,
      reach: reachFrom(record?.popularity ?? null),
    };
  });
  step(ctx, "people_for_show", true, `found ${people.length} people`);
  return { content: listContent("people", people, pastGuestsLeftOut(ctx, answer)), isError: false };
};

const audienceOf: Handler<"audience_of"> = async (ctx, qloo, input) => {
  if (!ctx.people.has(input.personId)) return refusal(ctx, "audience_of", "UNKNOWN_PERSON", "refused: person not found in this run");
  // The show's own audience is fetched once per run, so the board can tell
  // which audience group a guest's fans lean toward more than the show's do.
  if (ctx.showDemographics === null) ctx.showDemographics = await demographicsOf(qloo, ctx.show.qlooId);
  const audience = await demographicsOf(qloo, input.personId);
  if (audience === null) return refusal(ctx, "audience_of", "NO_DATA", "no audience data for this person");
  ctx.personDemographics.set(input.personId, audience);
  const segments = strongestSegments(audience, SEGMENTS_SHOWN);
  step(ctx, "audience_of", true, `read one audience, ${segments.length} strong segments`);
  return { content: listContent("strongestWith", segments), isError: false };
};

const trendOf: Handler<"trend_of"> = async (ctx, qloo, input, today) => {
  if (!ctx.people.has(input.personId)) return refusal(ctx, "trend_of", "UNKNOWN_PERSON", "refused: person not found in this run");
  const { startDate, endDate } = fullWeeksBefore(today, WEEKS_OF_TREND);
  const { data } = await qloo.call<QlooTrendRow[]>({
    op: "trending",
    filterType: "urn:entity:person",
    entity: input.personId,
    startDate,
    endDate,
  });
  const rows = listOf<QlooTrendRow>(data).map((row) => ({
    date: row.date,
    population_percentile: isFiniteNumber(row.population_percentile) ? row.population_percentile : null,
  }));
  ctx.trends.set(input.personId, rows);
  const rising = risingFrom(rows);
  step(ctx, "trend_of", true, `read ${rows.length} weeks of trend data, ${rising.state}`);
  return { content: JSON.stringify({ trend: rising.state }), isError: false };
};

const sharedTaste: Handler<"shared_taste"> = async (ctx, qloo, input) => {
  if (!ctx.people.has(input.personId)) return refusal(ctx, "shared_taste", "UNKNOWN_PERSON", "refused: person not found in this run");
  const { data } = await qloo.call<QlooCompareResult>({
    op: "compare",
    a: [ctx.show.qlooId],
    b: [input.personId],
    take: COMPARE_TAKE,
  });
  // The one place shared tags are stored, so the board, the brief and the
  // model all see only names that are whole and say nothing about who the
  // person is (C3.10): sharedTagsOf keeps only showable tag families, and
  // each name kept must pass isShowableTag as well.
  const tags = sharedTagsOf(compareOf(data)).filter((tag) => [...tag.name].length <= MAX_TAG_CHARS && isShowableTag(tag.name));
  ctx.compares.set(input.personId, tags);
  const top = [...tags]
    .sort((a, b) => (a.score === b.score ? 0 : a.score === null ? 1 : b.score === null ? -1 : b.score - a.score))
    .slice(0, SHARED_TASTES_SHOWN)
    .map((tag) => tag.name);
  step(ctx, "shared_taste", true, `found ${top.length} shared tastes`);
  return { content: listContent("sharedTastes", top), isError: false };
};

const upcomingReleases: Handler<"upcoming_releases"> = async (ctx, qloo, input, today) => {
  const year = today.getUTCFullYear();
  const { data } = await qloo.call<QlooEntity[]>({
    op: "insights",
    filterType: RELEASE_TYPE[input.kind],
    signalEntities: [ctx.show.qlooId],
    take: RELEASES_TAKE,
    ...(input.kind === "book" ? { publicationYearMin: year } : { releaseYearMin: year }),
  });
  const titles = listOf<QlooEntity>(data)
    .filter((entity) => isUpcoming(entity, input.kind, today))
    .map((entity) => cleanField(entity.name, MAX_TITLE_CHARS))
    .filter((title) => title !== "");
  // Every title that counts is kept, including any listContent leaves out
  // below, so an angle cannot name one the model saw some other way.
  for (const title of titles) rememberRelease(ctx, title);
  step(ctx, "upcoming_releases", true, `found ${titles.length} upcoming ${RELEASE_WORDS[input.kind]}`);
  return { content: listContent("titles", titles), isError: false };
};

// One executor per run, so the harness's name resolver and its cache last
// exactly as long as the run that owns them.
const HARNESS_RUNS = new WeakMap<RunContext, QlooWorkflowExecutor>();

/**
 * Gives one run's find_person Qloo's own harness: its describe workflow and
 * native name resolver, built here once for the run and run in this process.
 * Every HTTP request it makes goes through createMeteredHarnessClient over
 * `deps.qloo`, the run's metered raw path, with `deps.signal` (when given)
 * ending each request when it fires. Its observer is NO_OP_OBSERVER, so it
 * writes no file. Call it once per run, before research.
 */
export function attachHarness(ctx: RunContext, deps: { qloo: MeteredRawQloo; signal?: AbortSignal }): void {
  const client = createMeteredHarnessClient(deps);
  HARNESS_RUNS.set(ctx, createDirectQlooWorkflowExecutor(client, NO_OP_OBSERVER, createNativeQlooResolutionProvider(client)));
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const itemsOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

// The harness's answer is read like any Qloo answer: each person must pass
// the same entity schema a search result does, and one that does not is
// skipped.
function asPerson(value: unknown): QlooEntity | null {
  const checked = NORMALISED_SCHEMAS.search.safeParse([value]);
  return checked.success ? (checked.data[0] ?? null) : null;
}

// "ok" is one picked person, hydrated from /entities. "needs_input" holds the
// candidates the name could mean, keyed `id` rather than `entity_id`. Any
// other status, or a shape that does not fit, gives nobody.
function describedPeople(result: Readonly<Record<string, unknown>>): QlooEntity[] {
  const found =
    result["status"] === "ok"
      ? itemsOf(result["results"]).map(asPerson)
      : result["status"] === "needs_input"
        ? itemsOf(isRecord(result["resolution"]) ? result["resolution"]["issues"] : undefined)
            .flatMap((issue) => itemsOf(isRecord(issue) ? issue["candidates"] : undefined))
            .map((candidate) =>
              isRecord(candidate) ? asPerson({ entity_id: candidate["id"], name: candidate["name"], popularity: candidate["popularity"] }) : null,
            )
        : [];
  return found.filter((entity): entity is QlooEntity => entity !== null);
}

// The harness wraps whatever its client threw. Our own errors come back out,
// so a refused budget or a timeout reads as it does on every other tool and a
// database failure still fails the run (C5.7). Anything the harness raised
// itself carries the harness's words, so it becomes a fixed code (C3.6).
function harnessFailure(error: unknown): Error {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (current instanceof QlooError || current instanceof StoreError) return current;
    current = current.cause;
  }
  return new QlooError("QLOO_UPSTREAM");
}

// A Qloo id typed as a name takes the harness's identifier path, an
// /entities lookup with no type filter, which can return a non-person.
const ID_SHAPED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const findPerson: Handler<"find_person"> = async (ctx, _qloo, input, _today, opts) => {
  const executor = HARNESS_RUNS.get(ctx);
  if (executor === undefined) throw new Error("find_person needs attachHarness for this run.");
  if (ID_SHAPED.test(input.name.trim())) {
    step(ctx, "find_person", true, "found 0 matching people");
    return { content: listContent("people", []), isError: false };
  }
  let result: Readonly<Record<string, unknown>>;
  try {
    const context = opts.signal === undefined ? {} : { signal: opts.signal };
    result = (await executor.execute("describe", { entity: input.name, type: "person" }, context)).result;
  } catch (error) {
    throw harnessFailure(error);
  }
  // The harness keeps no death date, so a dead person found here is dropped
  // by the runner's fit call instead (scoreFit). A match score says how well
  // a name matched, not how well a person fits the show, so it is never
  // recorded as affinity.
  // The harness answers a name it cannot match with Qloo's nearest search
  // hits, which for nonsense included "Donald Trump" (live, 24 Oct). Only a
  // person whose name matches the one asked for counts as found.
  const answer = describedPeople(result)
    .filter((entity) => sameName(input.name, entity.name))
    .slice(0, FIND_TAKE);
  const people = uniqueById(answer.map((entity) => recordPerson(ctx, entity, null)));
  step(ctx, "find_person", true, `found ${people.length} matching people`);
  return { content: listContent("people", people, pastGuestsLeftOut(ctx, answer)), isError: false };
};

const recentEpisodeTitles: Handler<"recent_episode_titles"> = async (ctx) => {
  const titles = ctx.episodeTitles
    .slice(0, MAX_EPISODE_TITLES)
    .map((title) => cleanField(title, MAX_TITLE_CHARS))
    .filter((title) => title !== "");
  step(ctx, "recent_episode_titles", true, `shared ${titles.length} episode titles`);
  return { content: listContent("titles", titles), isError: false };
};

const finishBoard: Handler<"finish_board"> = async (ctx, _qloo, input, _today, opts) => {
  const finished: Array<{ personId: string; angle: string }> = [];
  const rejected: Array<{ index: number; reason: RejectReason; hint: string }> = [];
  const removed = { links: 0, emails: 0 };
  const seen = new Set<string>();

  for (const [index, pick] of input.picks.entries()) {
    if (!ctx.people.has(pick.personId)) {
      rejected.push({ index, reason: "unknown_person", hint: PICK_HINTS.unknown_person });
      continue;
    }
    if (seen.has(pick.personId)) {
      rejected.push({ index, reason: "duplicate", hint: PICK_HINTS.duplicate });
      continue;
    }
    seen.add(pick.personId);
    // Cleaned before checkProse, so a link split by an invisible character is
    // found and removed whole instead of being joined back up by a later clean.
    const angle = cleanText(pick.angle, { maxChars: MAX_ANGLE_INPUT_CHARS });
    // Checked before checkProse, so an angle naming a release gets the
    // release hint even when the title also holds a number word. It reads the
    // text with links already cut, the text the board stores, so a link
    // wedged inside a title cannot hide it.
    const release = releaseNamed(ctx, withoutLinks(angle).text);
    if (release !== null) {
      rejected.push({ index, reason: "release_claim", hint: releaseTitleHint(release) });
      continue;
    }
    // With no trend data behind the board, an angle may not call anyone rising.
    const check = checkProse(angle, { maxChars: MAX_ANGLE_CHARS, placeholders: [], noTrendClaims: !opts.trends });
    if (!check.ok) {
      const reason = check.reason ?? "empty";
      rejected.push({ index, reason, hint: PICK_HINTS[reason] });
      continue;
    }
    removed.links += check.removed.links;
    removed.emails += check.removed.emails;
    finished.push({ personId: pick.personId, angle: check.text });
  }

  if (rejected.length > 0) {
    step(ctx, "finish_board", false, `rejected ${rejected.length} of ${input.picks.length} picks`);
    return { content: JSON.stringify({ error: "PICKS_REJECTED", rejected }), isError: true };
  }
  const removals = removed.links + removed.emails > 0 ? `, removed ${removed.links} links and ${removed.emails} emails` : "";
  step(ctx, "finish_board", true, `accepted ${finished.length} picks${removals}`);
  return { content: JSON.stringify({ accepted: finished.length }), isError: false, finished };
};

const HANDLERS: { [K in ToolName]: Handler<K> } = {
  people_for_show: peopleForShow,
  audience_of: audienceOf,
  trend_of: trendOf,
  shared_taste: sharedTaste,
  upcoming_releases: upcomingReleases,
  find_person: findPerson,
  recent_episode_titles: recentEpisodeTitles,
  finish_board: finishBoard,
};

async function dispatch<K extends ToolName>(
  name: K,
  ctx: RunContext,
  qloo: MeteredQloo,
  input: unknown,
  today: Date,
  opts: ToolOptions,
): Promise<ToolOutcome> {
  const parsed = INPUTS[name].safeParse(input);
  if (!parsed.success) return refusal(ctx, name, "BAD_INPUT", "refused: input did not match the tool");
  return HANDLERS[name](ctx, qloo, parsed.data as Inputs[K], today, opts);
}

/**
 * Runs one tool call the model asked for. Every check here is code, never a
 * question to the model (C2.1). In order: an unknown tool name, a tool past
 * its TOOL_LIMITS count for this run, input that fails the tool's strict
 * schema, and a personId no tool returned in this run are each refused with
 * no Qloo call (C2.2). With opts.trends false, trend_of is refused as
 * NO_TREND_DATA with no Qloo call, and finish_board refuses an angle that
 * calls someone rising (reason "trend_claim"). finish_board always refuses,
 * with reason "release_claim", an angle whose words hold, in a row, the words
 * of any title upcoming_releases returned in this run, both taken under
 * matchKey with "the", "a" and "an" dropped (C8.3), for every title left with
 * at least two words; its hint names that title, cut to 120 characters. Every
 * attempt at a known tool counts toward its limit.
 * Qloo requests are built from checked fields only (C2.3). Content is JSON of
 * at most 4,000 characters, and every Qloo name, tag and title and every
 * episode title in it has been through cleanText (C2.8). Angles are cleaned
 * the same way before checkProse. A QlooError becomes an error outcome whose
 * content is only its code, never a message, URL or key (C2.6). Each call adds
 * one step summary of fixed words and counts, with no ids and no upstream
 * text, so it is safe to stream. With opts.signal every Qloo call the tool
 * makes carries it, so one still running when it fires is cut off and comes
 * back as a QLOO_TIMEOUT error outcome (C2.4).
 *
 * find_person runs on the harness attachHarness gave this run.
 *
 * Throws RangeError for an invalid `today`, Error for find_person in a run
 * with no harness attached, and rethrows anything that is not a QlooError,
 * such as StoreError when the database fails, so the run loop fails the run
 * instead of carrying on (C5.7, C6.4).
 */
export async function runTool(
  ctx: RunContext,
  qloo: MeteredQloo,
  name: string,
  input: unknown,
  today: Date,
  opts: ToolOptions,
): Promise<ToolOutcome> {
  if (!Number.isFinite(today.getTime())) throw new RangeError("today must be a valid date.");
  if (!isToolName(name)) return refusal(ctx, "unknown", "UNKNOWN_TOOL", "refused: unknown tool");

  const used = ctx.toolCalls.get(name) ?? 0;
  if (used >= TOOL_LIMITS[name]) return refusal(ctx, name, "LIMIT_REACHED", "refused: call limit reached");
  ctx.toolCalls.set(name, used + 1);
  if (name === "trend_of" && !opts.trends) return refusal(ctx, name, "NO_TREND_DATA", "refused: trend data is not available");

  try {
    return await dispatch(name, ctx, opts.signal === undefined ? qloo : withSignal(qloo, opts.signal), input, today, opts);
  } catch (error) {
    if (error instanceof QlooError) return refusal(ctx, name, error.code, `failed: ${error.code}`);
    throw error;
  }
}
