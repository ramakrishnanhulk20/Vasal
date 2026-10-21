import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { QlooError } from "../qloo/errors.js";
import type { MeteredQloo } from "../qloo/metered.js";
import type { EntityType, QlooOperation } from "../qloo/request.js";
import type { QlooCompareResult, QlooDemographic, QlooEntity, QlooTrendRow } from "../qloo/schemas.js";
import { cleanText, normalizeName } from "../text/normalize.js";
import { reachFrom, risingFrom, strongestSegments } from "./board.js";
import type { Demographics, RunContext, SharedTag, StepSummary } from "./context.js";
import { checkProse } from "./prose.js";

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
type Handler<K extends ToolName> = (ctx: RunContext, qloo: MeteredQloo, input: Inputs[K], today: Date) => Promise<ToolOutcome>;

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
 * because strict tool schemas do not accept those keywords. Returns new
 * objects on every call.
 */
export function researchTools(): Anthropic.Tool[] {
  return [
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
        "Use it to find guests who would bring the show listeners it does not reach yet. " +
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
      "Titles of the show's recent episodes, so you can avoid suggesting someone who was on the show recently. Call it once.",
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
}

const isToolName = (name: string): name is ToolName => Object.hasOwn(TOOL_LIMITS, name);
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
// here; every string was already capped when it came in.
function listContent<T>(key: string, items: readonly T[]): string {
  for (let kept = items.length; kept > 0; kept -= 1) {
    const omitted = items.length - kept;
    const text = JSON.stringify(omitted > 0 ? { [key]: items.slice(0, kept), omitted } : { [key]: items.slice(0, kept) });
    if (text.length <= MAX_CONTENT_CHARS) return text;
  }
  return JSON.stringify(items.length > 0 ? { [key]: [], omitted: items.length } : { [key]: [] });
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
// comparison come out of the same normaliser.
function sharedTagsOf({ tags, a, b }: QlooCompareResult): SharedTag[] {
  const keyOf = (name: string) => normalizeName(cleanField(name, MAX_NAME_CHARS));
  const personSide = new Set(b.map((tag) => keyOf(tag.name)));
  const seen = new Set<string>();
  const shared: SharedTag[] = [];
  const add = (raw: string, score: number | null) => {
    const name = cleanField(raw, MAX_NAME_CHARS);
    const key = normalizeName(name);
    if (key === "" || seen.has(key)) return;
    seen.add(key);
    shared.push({ name, score });
  };
  for (const tag of tags) add(tag.name, isFiniteNumber(tag.query?.score) ? tag.query.score : null);
  for (const tag of a) if (personSide.has(keyOf(tag.name))) add(tag.name, null);
  return shared;
}

// Qloo ranks people who have died as high as anyone, and they can never be
// booked. Any death date that is not empty counts, including one in a shape
// never seen, so an odd value drops the person rather than letting them in.
function hasDied(entity: QlooEntity): boolean {
  const died = entity.properties?.date_of_death;
  return died !== undefined && died !== null && died !== "";
}

// Every person a tool returns passes through here, so a person dropped here
// never reaches the model, the board, compare or demographics.
function recordPerson(ctx: RunContext, entity: QlooEntity, affinity: number | null): { personId: string; name: string } | null {
  if (!QLOO_ID.test(entity.entity_id)) return null;
  // A later answer can carry a death date an earlier one lacked; the person
  // then leaves the run, so the board never lists them.
  if (hasDied(entity)) {
    ctx.people.delete(entity.entity_id);
    return null;
  }
  const name = cleanField(entity.name, MAX_NAME_CHARS);
  if (name === "") return null;
  const popularity = isFiniteNumber(entity.popularity) ? entity.popularity : null;
  const known = ctx.people.get(entity.entity_id);
  // The first affinity seen is kept, so the board's fit never changes under
  // the model once it has been shown a number for this person.
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
  const people = uniqueById(
    listOf<QlooEntity>(data).map((entity) => {
      const affinity = entity.query?.affinity ?? entity.properties?.affinity;
      return recordPerson(ctx, entity, isFiniteNumber(affinity) ? affinity : null);
    }),
  ).map(({ personId, name }) => {
    const record = ctx.people.get(personId);
    return {
      personId,
      name,
      affinity: isFiniteNumber(record?.affinity) ? round2(record.affinity) : null,
      reach: reachFrom(record?.popularity ?? null),
    };
  });
  step(ctx, "people_for_show", true, `found ${people.length} people`);
  return { content: listContent("people", people), isError: false };
};

const audienceOf: Handler<"audience_of"> = async (ctx, qloo, input) => {
  if (!ctx.people.has(input.personId)) return refusal(ctx, "audience_of", "UNKNOWN_PERSON", "refused: person not found in this run");
  // The show's own audience is fetched once per run, so the board can tell
  // which listeners a guest would bring that the show does not have.
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
  const tags = sharedTagsOf(compareOf(data));
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
  step(ctx, "upcoming_releases", true, `found ${titles.length} upcoming ${RELEASE_WORDS[input.kind]}`);
  return { content: listContent("titles", titles), isError: false };
};

const findPerson: Handler<"find_person"> = async (ctx, qloo, input) => {
  const { data } = await qloo.call<QlooEntity[]>({
    op: "search",
    query: input.name,
    types: ["urn:entity:person"],
    take: FIND_TAKE,
  });
  // A search score says how well a name matched, not how well a person fits
  // the show, so it is never recorded as affinity.
  const people = uniqueById(listOf<QlooEntity>(data).map((entity) => recordPerson(ctx, entity, null)));
  step(ctx, "find_person", true, `found ${people.length} matching people`);
  return { content: listContent("people", people), isError: false };
};

const recentEpisodeTitles: Handler<"recent_episode_titles"> = async (ctx) => {
  const titles = ctx.episodeTitles
    .slice(0, MAX_EPISODE_TITLES)
    .map((title) => cleanField(title, MAX_TITLE_CHARS))
    .filter((title) => title !== "");
  step(ctx, "recent_episode_titles", true, `shared ${titles.length} episode titles`);
  return { content: listContent("titles", titles), isError: false };
};

const finishBoard: Handler<"finish_board"> = async (ctx, _qloo, input) => {
  const finished: Array<{ personId: string; angle: string }> = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  const removed = { links: 0, emails: 0 };
  const seen = new Set<string>();

  for (const [index, pick] of input.picks.entries()) {
    if (!ctx.people.has(pick.personId)) {
      rejected.push({ index, reason: "unknown_person" });
      continue;
    }
    if (seen.has(pick.personId)) {
      rejected.push({ index, reason: "duplicate" });
      continue;
    }
    seen.add(pick.personId);
    // Cleaned before checkProse, so a link split by an invisible character is
    // found and removed whole instead of being joined back up by a later clean.
    const angle = cleanText(pick.angle, { maxChars: MAX_ANGLE_INPUT_CHARS });
    const check = checkProse(angle, { maxChars: MAX_ANGLE_CHARS, placeholders: [] });
    if (!check.ok) {
      rejected.push({ index, reason: check.reason ?? "empty" });
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
): Promise<ToolOutcome> {
  const parsed = INPUTS[name].safeParse(input);
  if (!parsed.success) return refusal(ctx, name, "BAD_INPUT", "refused: input did not match the tool");
  return HANDLERS[name](ctx, qloo, parsed.data as Inputs[K], today);
}

/**
 * Runs one tool call the model asked for. Every check here is code, never a
 * question to the model (C2.1). In order: an unknown tool name, a tool past
 * its TOOL_LIMITS count for this run, input that fails the tool's strict
 * schema, and a personId no tool returned in this run are each refused with
 * no Qloo call (C2.2). Every attempt at a known tool counts toward its limit.
 * Qloo requests are built from checked fields only (C2.3). Content is JSON of
 * at most 4,000 characters, and every Qloo name, tag and title and every
 * episode title in it has been through cleanText (C2.8). Angles are cleaned
 * the same way before checkProse. A QlooError becomes an error outcome whose
 * content is only its code, never a message, URL or key (C2.6). Each call adds
 * one step summary of fixed words and counts, with no ids and no upstream
 * text, so it is safe to stream.
 *
 * Throws RangeError for an invalid `today`, and rethrows anything that is not
 * a QlooError, such as StoreError when the database fails, so the run loop
 * fails the run instead of carrying on (C5.7, C6.4).
 */
export async function runTool(
  ctx: RunContext,
  qloo: MeteredQloo,
  name: string,
  input: unknown,
  today: Date,
): Promise<ToolOutcome> {
  if (!Number.isFinite(today.getTime())) throw new RangeError("today must be a valid date.");
  if (!isToolName(name)) return refusal(ctx, "unknown", "UNKNOWN_TOOL", "refused: unknown tool");

  const used = ctx.toolCalls.get(name) ?? 0;
  if (used >= TOOL_LIMITS[name]) return refusal(ctx, name, "LIMIT_REACHED", "refused: call limit reached");
  ctx.toolCalls.set(name, used + 1);

  try {
    return await dispatch(name, ctx, qloo, input, today);
  } catch (error) {
    if (error instanceof QlooError) return refusal(ctx, name, error.code, `failed: ${error.code}`);
    throw error;
  }
}
