import { z } from "zod";
import { normalizeName } from "../text/normalize.js";

// The pre-registration's window: published from 1 Oct 2024 to 31 Jul 2026
// inclusive, in UTC. The end is held as the first instant after it.
export const WINDOW_FROM = "2024-10-01";
export const WINDOW_TO = "2026-07-31";
export const WINDOW_START_MS = Date.UTC(2024, 9, 1);
export const WINDOW_END_EXCLUSIVE_MS = Date.UTC(2026, 7, 1);
export const MIN_DURATION_SEC = 1_200;

// Date.parse alone accepts loose formats, reads some of them in local
// time, and rolls 30 February over into March. Only ISO 8601 instants with
// an explicit offset or Z are read, with or without seconds. The dataset
// schema uses this same parser, so a date that passed the window check
// always reads back.
export const IsoInstant = z.union([z.iso.datetime({ offset: true }), z.iso.datetime({ offset: true, precision: -1 })]);

const WORD_CHARACTER = /^[\p{L}\p{M}\p{N}]$/u;

/**
 * True when `publishedAt` is an ISO 8601 instant from 2024-10-01T00:00Z to
 * 2026-07-31T23:59:59.999Z inclusive. Anything that does not parse as one
 * is outside the window, so a malformed date can never let an episode in.
 */
export function isInWindow(publishedAt: string): boolean {
  if (!IsoInstant.safeParse(publishedAt).success) return false;
  const ms = Date.parse(publishedAt);
  return Number.isFinite(ms) && ms >= WINDOW_START_MS && ms < WINDOW_END_EXCLUSIVE_MS;
}

/**
 * True only when `publishedAt` is an ISO 8601 instant before 2024-10-01T00:00Z.
 * A date that does not parse is not known to be before the window, so the
 * upload-cap check treats it as possibly inside it.
 */
export function isBeforeWindow(publishedAt: string | null): boolean {
  if (publishedAt === null || !IsoInstant.safeParse(publishedAt).success) return false;
  const ms = Date.parse(publishedAt);
  return Number.isFinite(ms) && ms < WINDOW_START_MS;
}

/**
 * True when the video is at least 20 minutes (1200 seconds) long. An
 * unknown length is treated as too short, because it cannot be shown to be
 * a full episode.
 */
export function isFullLength(durationSec: number | null): boolean {
  return durationSec !== null && Number.isFinite(durationSec) && durationSec >= MIN_DURATION_SEC;
}

function codePointBefore(text: string, index: number): number | undefined {
  if (index <= 0) return undefined;
  const low = text.charCodeAt(index - 1);
  if (index >= 2 && low >= 0xdc00 && low <= 0xdfff) {
    const high = text.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.codePointAt(index - 2);
  }
  return low;
}

const isWordCharacter = (codePoint: number | undefined) =>
  codePoint !== undefined && WORD_CHARACTER.test(String.fromCodePoint(codePoint));

/**
 * True when the guest name appears in the title as whole words, after both
 * pass through normalizeName, the one normaliser of threat model C8.3. This
 * is the C9.1 check on every name the model extracts: "Dax Shepard" is in
 * "#123 DAX  SHEPARD on fame", but "Dax" is not in "Daxton tells all".
 * A whole word means the characters just outside the match are not
 * letters, marks or digits in any script. A name that is empty after
 * normalising never matches. It does not catch nicknames, misspellings or
 * lookalike letters; those names are dropped, not guessed at.
 */
export function nameAppearsInTitle(name: string, title: string): boolean {
  const needle = normalizeName(name);
  const haystack = normalizeName(title);
  if (needle === "") return false;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const end = at + needle.length;
    if (!isWordCharacter(codePointBefore(haystack, at)) && !isWordCharacter(haystack.codePointAt(end))) return true;
  }
  return false;
}

/**
 * The pre-registration's podcast match (change log, 19 Oct 2026): after
 * normalizeName, the two names are equal, or one is the other followed by a
 * space and more words. "armchair expert" matches "armchair expert with dax
 * shepard", and "armchair" matches "armchair expert", but "armchair
 * expertise" does not match "armchair expert". Empty names never match.
 */
export function podcastNameMatches(showName: string, qlooName: string): boolean {
  const show = normalizeName(showName);
  const qloo = normalizeName(qlooName);
  if (show === "" || qloo === "") return false;
  return show === qloo || show.startsWith(`${qloo} `) || qloo.startsWith(`${show} `);
}

export type PodcastPick = { kind: "match"; id: string; name: string } | { kind: "ambiguous" } | { kind: "none" };

function pickFromTier(tier: Array<{ id: string; name: string }>): PodcastPick | undefined {
  const first = tier[0];
  if (first === undefined) return undefined;
  return new Set(tier.map((candidate) => candidate.id)).size === 1 ? { kind: "match", id: first.id, name: first.name } : { kind: "ambiguous" };
}

/**
 * Chooses the show's Qloo podcast in two tiers (pre-registration change
 * log, refinement 2). Tier 1 is the candidates whose normalised name equals
 * the show's. Only when tier 1 is empty does tier 2 count: the candidates
 * that pass `podcastNameMatches`, where one name is the other followed by
 * more words. The winning tier gives a match when it holds exactly one
 * distinct id, and "ambiguous" when it holds more, so one is never picked
 * at random. No candidate in either tier gives "none". So "Flagrant"
 * matches a podcast named "Flagrant" even when "Flagrant and Funny with
 * ..." is also returned.
 */
export function pickPodcastMatch(showName: string, candidates: Array<{ id: string; name: string }>): PodcastPick {
  const show = normalizeName(showName);
  if (show === "") return { kind: "none" };
  const exact = candidates.filter((candidate) => normalizeName(candidate.name) === show);
  const longer = candidates.filter((candidate) => podcastNameMatches(showName, candidate.name));
  return pickFromTier(exact) ?? pickFromTier(longer) ?? { kind: "none" };
}
