import { cleanText, normalizeName } from "../text/normalize.js";
import type { Demographics, RunContext, SharedTag, TrendRow } from "./context.js";
import { sameName } from "./past-guests.js";

export type Rising = { state: "rising" | "steady" | "falling" | "unknown"; points: number | null };
export type BringsNew = { segment: string; label: string; gap: number } | null;
/** How hard a guest is likely to book. "unknown" means Qloo gave no popularity, never that booking is easy. */
export type Reach = "household name" | "well known" | "bookable" | "unknown";
export type BoardEntry = {
  personId: string;
  name: string;
  fit: number;
  // False when Qloo gave no affinity for this person. Their fit shows as 0
  // and they rank below everyone with a real fit.
  fitKnown: boolean;
  fitRank: number;
  reach: Reach;
  rising: Rising;
  bringsNew: BringsNew;
  sharedTags: string[];
  angle: string;
};

const RECENT_WEEKS = 4;
const BASELINE_WEEKS = 8;
// Starting values in percentile points. The live probe may retune them once
// it has seen how much real trend rows move from week to week.
const RISING_AT_POINTS = 2;
const FALLING_AT_POINTS = -2;

const HOUSEHOLD_NAME_AT = 0.95;
const WELL_KNOWN_AT = 0.8;

/**
 * The fit a pick needs when only find_person returned it. A pasted feed's
 * titles can steer the model's name searches to anyone, so such a pick stays
 * only when Qloo scores it as a real fit for this show (G18).
 */
export const FIND_PERSON_FIT_FLOOR = 0.5;
const SHARED_TAGS_SHOWN = 5;
const MAX_NAME_CHARS = 120;
const MAX_TAG_CHARS = 40;
const MAX_ANGLE_CHARS = 400;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Fixed labels for the bands Qloo documents. A key Qloo adds later is ignored
// rather than turned into a label, so no upstream text reaches the screen here.
const AGE_LABELS: ReadonlyArray<[string, string]> = [
  ["24_and_younger", "listeners 24 and younger"],
  ["25_to_29", "listeners 25 to 29"],
  ["30_to_34", "listeners 30 to 34"],
  ["35_to_44", "listeners 35 to 44"],
  ["45_to_54", "listeners 45 to 54"],
  ["55_and_older", "listeners 55 and older"],
  ["35_and_younger", "listeners 35 and younger"],
  ["36_to_55", "listeners 36 to 55"],
];
const GENDER_LABELS: ReadonlyArray<[string, string]> = [
  ["female", "women"],
  ["male", "men"],
];
const SEGMENTS: ReadonlyArray<["age" | "gender", ReadonlyArray<[string, string]>]> = [
  ["age", AGE_LABELS],
  ["gender", GENDER_LABELS],
];

// `|| 0` turns -0 into 0, so a flat trend never prints as "-0".
const round1 = (value: number) => Math.round(value * 10) / 10 || 0;
const round2 = (value: number) => Math.round(value * 100) / 100 || 0;
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const byScoreDesc = (a: SharedTag, b: SharedTag) => {
  if (a.score === b.score) return 0;
  if (a.score === null) return 1;
  if (b.score === null) return -1;
  return b.score - a.score;
};

// Repeats are judged on the cleaned text the page shows, through the one
// name normaliser, because Qloo often files one concept in two tag families.
function uniqueNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  return names.filter((name) => {
    const key = normalizeName(name);
    if (key === "" || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// The board is what gets stored and shown, so it cleans every name, tag and
// angle itself rather than trusting whatever filled the context (C3.7,
// D5.2). Trimming comes between cleaning and the cap, so spaces hidden behind
// an invisible character never use up the cap.
function cleanLine(text: string, maxChars: number): string {
  const whole = cleanText(text, { maxChars: Number.POSITIVE_INFINITY }).trim();
  return cleanText(whole, { maxChars }).trim();
}

/**
 * Turns weekly trending rows into rising, steady or falling. Takes the newest
 * 12 weeks that have a date and a percentile (one row per date, newest first
 * by date whatever order they arrive in), then compares the mean percentile of
 * the newest 4 with the mean of the 8 before, in percentile points rounded to
 * one decimal. Values all within 0 to 1 are read as fractions and scaled by
 * 100. Rising at +2 points or more, falling at -2 or less, else steady.
 * Returns unknown with null points when fewer than 12 usable weeks remain.
 */
export function risingFrom(rows: readonly TrendRow[]): Rising {
  const byDate = new Map<string, number>();
  for (const row of rows) {
    const value = row.population_percentile;
    if (!ISO_DATE.test(row.date) || !isFiniteNumber(value) || byDate.has(row.date)) continue;
    byDate.set(row.date, value);
  }
  const weeks = [...byDate].sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0)).map(([, value]) => value);
  if (weeks.length < RECENT_WEEKS + BASELINE_WEEKS) return { state: "unknown", points: null };

  const window = weeks.slice(0, RECENT_WEEKS + BASELINE_WEEKS);
  const scale = window.every((value) => value >= 0 && value <= 1) ? 100 : 1;
  const points = round1((mean(window.slice(0, RECENT_WEEKS)) - mean(window.slice(RECENT_WEEKS))) * scale);

  if (points >= RISING_AT_POINTS) return { state: "rising", points };
  if (points <= FALLING_AT_POINTS) return { state: "falling", points };
  return { state: "steady", points };
}

/**
 * Finds the audience a guest would bring that the show does not have yet.
 * For each documented age band and gender present in both breakdowns, the gap
 * is person minus show. Returns the largest gap among segments where the
 * person over-indexes (above 0) and the show does not (0 or below), with a
 * fixed plain label and the gap rounded to 2 decimals. Age and gender are
 * separate in Qloo's data, so a label never combines them. Returns null when
 * no segment qualifies.
 */
export function bringsNewFrom(show: Demographics, person: Demographics): BringsNew {
  let best: BringsNew = null;
  for (const [kind, labels] of SEGMENTS) {
    const showSide = show[kind];
    const personSide = person[kind];
    for (const [key, label] of labels) {
      if (!Object.hasOwn(showSide, key) || !Object.hasOwn(personSide, key)) continue;
      const showValue = showSide[key];
      const personValue = personSide[key];
      if (!isFiniteNumber(showValue) || !isFiniteNumber(personValue)) continue;
      if (personValue <= 0 || showValue > 0) continue;
      const gap = round2(personValue - showValue);
      if (best === null || gap > best.gap) best = { segment: `${kind}:${key}`, label, gap };
    }
  }
  return best;
}

/**
 * Where an audience is strongest: every documented age band and gender whose
 * index is above 0, strongest first, as the same fixed labels bringsNewFrom
 * uses, at most `count` of them.
 */
export function strongestSegments(audience: Demographics, count: number): string[] {
  const found: Array<{ label: string; value: number }> = [];
  for (const [kind, labels] of SEGMENTS) {
    const side = audience[kind];
    for (const [key, label] of labels) {
      if (!Object.hasOwn(side, key)) continue;
      const value = side[key];
      if (isFiniteNumber(value) && value > 0) found.push({ label, value });
    }
  }
  return found
    .sort((a, b) => b.value - a.value)
    .slice(0, Math.max(0, count))
    .map((segment) => segment.label);
}

/**
 * How hard a guest is likely to book, from Qloo popularity (0 to 1): 0.95 and
 * up is a household name, 0.8 and up is well known, any other number is
 * bookable. A missing or non-finite value is unknown, so absent data never
 * reads as the favourable label (G15).
 */
export function reachFrom(popularity: number | null): Reach {
  if (popularity === null || !Number.isFinite(popularity)) return "unknown";
  if (popularity >= HOUSEHOLD_NAME_AT) return "household name";
  if (popularity >= WELL_KNOWN_AT) return "well known";
  return "bookable";
}

/**
 * Computes the ranked guest board from the model's picks. Pure.
 *
 * A pick is kept only if its personId is one a tool returned in this run and
 * not one the run dropped (ctx.dropped), it is not a repeat of an earlier
 * pick, and the person's cleaned name is not empty and does not match an
 * exclusion. A pick no people_for_show answer returned (ctx.listedForShow)
 * came only from find_person, so it is kept only when its fit is known and
 * at least FIND_PERSON_FIT_FLOOR (G18). With opts.applyFitFloor false that
 * floor is skipped, for the size check made before the fit call gives every
 * pick a comparable fit. Names, shared tags and angles go through cleanText
 * and are capped at 120, 40 and 400 code points (C3.7, D5.2). The exclusion
 * check uses the cleaned name, the one the page shows, and sameName, the
 * past-guest matcher, so case, spacing, invisible characters, accents,
 * punctuation, a trailing Jr or Sr and a middle name do not matter (C2.7,
 * C8.3). Every number comes from the context: fit is the Qloo affinity
 * rounded to 2 decimals, ranked by the unrounded affinity highest first, so
 * two guests who both show 0.95 still rank in their true order, ties broken
 * by lower popularity and then by pick order. A person with no affinity gets
 * fit 0, fitKnown false, and ranks last. Shared tags are deduplicated through
 * normalizeName before the top 5 are kept. Precondition: each angle has
 * already passed checkProse, which finish_board does before it returns picks.
 */
export function buildBoard(
  ctx: RunContext,
  picks: ReadonlyArray<{ personId: string; angle: string }>,
  opts: { applyFitFloor: boolean } = { applyFitFloor: true },
): BoardEntry[] {
  const exclusions = ctx.exclusions.filter((exclusion) => exclusion.trim() !== "");
  const seen = new Set<string>();
  const kept: Array<{
    personId: string;
    angle: string;
    name: string;
    affinity: number;
    fitKnown: boolean;
    popularity: number | null;
  }> = [];

  for (const pick of picks) {
    const person = ctx.people.get(pick.personId);
    if (person === undefined || ctx.dropped.has(pick.personId) || seen.has(pick.personId)) continue;
    seen.add(pick.personId);
    const name = cleanLine(person.name, MAX_NAME_CHARS);
    if (name === "" || exclusions.some((exclusion) => sameName(exclusion, name))) continue;
    const { affinity } = person;
    const vouched = ctx.listedForShow.has(pick.personId) || (isFiniteNumber(affinity) && affinity >= FIND_PERSON_FIT_FLOOR);
    if (opts.applyFitFloor && !vouched) continue;
    kept.push({
      personId: pick.personId,
      angle: cleanLine(pick.angle, MAX_ANGLE_CHARS),
      name,
      affinity: isFiniteNumber(affinity) ? affinity : 0,
      fitKnown: isFiniteNumber(affinity),
      popularity: isFiniteNumber(person.popularity) ? person.popularity : null,
    });
  }

  kept.sort((a, b) => {
    if (a.fitKnown !== b.fitKnown) return a.fitKnown ? -1 : 1;
    if (a.affinity !== b.affinity) return b.affinity - a.affinity;
    if (a.popularity === b.popularity) return 0;
    if (a.popularity === null) return 1;
    if (b.popularity === null) return -1;
    return a.popularity - b.popularity;
  });

  return kept.map((entry, index) => {
    const personDemographics = ctx.personDemographics.get(entry.personId);
    const sharedTags = uniqueNames(
      [...(ctx.compares.get(entry.personId) ?? [])].sort(byScoreDesc).map((tag) => cleanLine(tag.name, MAX_TAG_CHARS)),
    ).slice(0, SHARED_TAGS_SHOWN);
    return {
      personId: entry.personId,
      name: entry.name,
      fit: round2(entry.affinity),
      fitKnown: entry.fitKnown,
      fitRank: index + 1,
      reach: reachFrom(entry.popularity),
      rising: risingFrom(ctx.trends.get(entry.personId) ?? []),
      bringsNew:
        ctx.showDemographics !== null && personDemographics !== undefined
          ? bringsNewFrom(ctx.showDemographics, personDemographics)
          : null,
      sharedTags,
      angle: entry.angle,
    };
  });
}
