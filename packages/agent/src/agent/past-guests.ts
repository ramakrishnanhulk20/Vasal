import { normalizeName } from "../text/normalize.js";

/**
 * A show's episode titles and the names it goes by (directory name,
 * publisher, Qloo name, feed title), each reduced to its match key and padded
 * with one space on both sides, so a name can only match whole words. Built
 * once per run by pastGuestIndex.
 */
export type PastGuestIndex = { readonly titles: readonly string[] };

/** The index for a show whose feed could not be read: nobody is a past guest. */
export const NO_PAST_GUESTS: PastGuestIndex = Object.freeze({ titles: Object.freeze([] as string[]) });

const MARK = /\p{M}/gu;
const NOT_LETTER_OR_DIGIT = /[^\p{L}\p{N}]/gu;
const SPACE_RUN = / {2,}/gu;
const SUFFIXES: ReadonlySet<string> = new Set(["jr", "sr", "ii", "iii", "iv"]);

// Built on normalizeName, so curly and straight quotes and case already agree.
// Accents are then dropped, because feeds write "Beyonce" where Qloo writes
// "Beyoncé", and every mark of punctuation becomes a space, so "O'Brien",
// "O’Brien" and "Keegan-Michael" break into the same words on both sides.
function matchKey(text: string): string {
  return normalizeName(text)
    .normalize("NFKD")
    .replace(MARK, "")
    .replace(NOT_LETTER_OR_DIGIT, " ")
    .replace(SPACE_RUN, " ")
    .trim();
}

// Titles write "Mel Kiper Jr." and "Mel Kiper" alike, and rarely carry a
// middle name or initial, so the suffix goes and first plus last is tried as
// well as the whole name. A suffix stays when taking it off would leave one
// word, so a two-word name never shrinks to a surname alone.
function nameTokens(name: string): string[] {
  const tokens = matchKey(name)
    .split(" ")
    .filter((token) => token !== "");
  while (tokens.length > 2 && SUFFIXES.has(tokens.at(-1) ?? "")) tokens.pop();
  return tokens;
}

function nameKeys(tokens: readonly string[]): string[] {
  const first = tokens[0];
  const last = tokens.at(-1);
  if (first === undefined || last === undefined) return [];
  return tokens.length >= 3 ? [tokens.join(" "), `${first} ${last}`] : [tokens.join(" ")];
}

// Titles often shorten a first name: Las Culturistas titled Megan Stalter's
// 2021 episode "w/ Meg Stalter" (found 23 Oct). So a title word that starts
// with the first name's first three letters, right before the same surname,
// also counts. "Mike" for Michael and "Bill" for William are still missed.
const SHORT_FORM_LETTERS = 3;

function shortFormIn(title: string, tokens: readonly string[]): boolean {
  const first = tokens[0];
  const last = tokens.at(-1);
  if (tokens.length < 2 || first === undefined || last === undefined || first.length < SHORT_FORM_LETTERS) return false;
  const stem = first.slice(0, SHORT_FORM_LETTERS);
  const words = title.trim().split(" ");
  return words.some((word, at) => at > 0 && word === last && (words[at - 1] ?? "").startsWith(stem));
}

/**
 * Builds the index isPastGuest reads from a show's episode titles, every one
 * of them, in any order. The run context adds the names the show goes by as
 * extra entries, because a host is named there and rarely in a title. The
 * titles are not kept, only their match keys. The result is frozen.
 */
export function pastGuestIndex(titles: readonly string[]): PastGuestIndex {
  return Object.freeze({ titles: Object.freeze(titles.map((title) => ` ${matchKey(title)} `)) });
}

/**
 * True when the two names share a match key: the whole name, or first plus
 * last name once a trailing Jr, Sr, II, III or IV is dropped, after the same
 * normalising isPastGuest uses (normalizeName, accents dropped, punctuation
 * as spaces). So "Jose Andres" matches "José Andrés", "Mel Kiper" matches
 * "Mel Kiper, Jr." and "Nassim Taleb" matches "Nassim Nicholas Taleb". A
 * surname alone, a word that only starts the same ("Kiper" in "Kiperman"),
 * a short first name ("Meg" for Megan), nicknames, misspellings and
 * lookalike letters from other scripts do not match. An empty name matches
 * nothing. A false match can only drop a person, never add one.
 */
export function sameName(a: string, b: string): boolean {
  const left = new Set(nameKeys(nameTokens(a)));
  return left.size > 0 && nameKeys(nameTokens(b)).some((key) => left.has(key));
}

/**
 * True when some episode title in `index` holds this person's whole name, or
 * their first and last name, as whole words, or a short form of the first
 * name (a word starting with its first three letters, such as "Meg" for
 * Megan) right before the surname. Case, accents, quote marks and
 * punctuation are ignored, and a trailing Jr, Sr, II, III or IV is dropped.
 * A surname alone in a title never matches, so "Taleb" in a title does not
 * mark "Nassim Nicholas Taleb" as a past guest. An empty name never matches.
 *
 * It reads the index's entries only, so a guest neither the titles nor the
 * show's own names hold is missed, and a
 * different person with the same surname and a similar first name is taken
 * for a past guest. That false match only leaves a person off the board; it
 * can never put anyone on it. Nicknames that do not share the first three
 * letters ("Mike" for Michael), misspellings and lookalike letters from
 * other scripts are not matched.
 */
export function isPastGuest(index: PastGuestIndex, name: string): boolean {
  const tokens = nameTokens(name);
  const keys = nameKeys(tokens).map((key) => ` ${key} `);
  return keys.length > 0 && index.titles.some((title) => keys.some((key) => title.includes(key)) || shortFormIn(title, tokens));
}
