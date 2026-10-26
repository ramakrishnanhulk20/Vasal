import { normalizeName } from "../text/normalize.js";

/**
 * Everything a run checks a person against before they can reach the board,
 * each entry reduced to its match key and padded with one space on both
 * sides, so a name can only match whole words. An entry holding a run of
 * single letters ("w j j watt") also keeps keys with that run joined whole
 * ("wjj watt") and with only its last two or three letters joined ("w jj
 * watt"), at most four keys in all. titles are episode titles,
 * descriptions are episode descriptions, and hosts are the names of the
 * people who make the show (its directory name, publisher, Qloo name, feed
 * title, feed authors and any host the operator names). Built once per run
 * by pastGuestIndex.
 */
export type PastGuestIndex = {
  readonly titles: readonly string[];
  readonly descriptions: readonly string[];
  readonly hosts: readonly string[];
};

const NONE: readonly string[] = Object.freeze([] as string[]);

/** The index for a show whose feed could not be read: nobody is a past guest. */
export const NO_PAST_GUESTS: PastGuestIndex = Object.freeze({ titles: NONE, descriptions: NONE, hosts: NONE });

const MARK = /\p{M}/gu;
const NOT_LETTER_OR_DIGIT = /[^\p{L}\p{N}]/gu;
const SPACE_RUN = / {2,}/gu;
const SINGLE_LETTER = /^\p{L}$/u;
const SUFFIXES: ReadonlySet<string> = new Set(["jr", "sr", "ii", "iii", "iv"]);

/**
 * The match key past-guest checks compare: normalizeName, then accents
 * dropped and every character that is not a letter or digit turned into a
 * space, with spaces collapsed and trimmed. Feeds write "Beyonce" where Qloo
 * writes "Beyoncé", and "O'Brien", "O’Brien" and "Keegan-Michael" break into
 * the same words on both sides. Lookalike letters from other scripts are not
 * folded.
 */
export function matchKey(text: string): string {
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

// The most initials a name is taken to carry in one run, as in "J.R.R.".
// Without a bound, a pasted feed's description of a thousand single letters
// would give each entry a thousand keys of its full length.
const MAX_INITIALS = 3;

// matchKey writes "J.J. Watt" and "J. J. Watt" as "j j watt" and "JJ Watt" as
// "jj watt", so a run of single letters is also tried joined into one word.
// This spelling keeps each run's first letters apart and joins only its last
// `joined` letters, or the whole run when it is that short: with 2, "w/ J.J.
// Watt" gives "w jj watt", so a stray letter before the initials ("w/",
// "Q&A") does not hide them.
function withRunsJoined(tokens: readonly string[], joined: number): string[] {
  const out: string[] = [];
  let run: string[] = [];
  const flush = (): void => {
    const apart = Math.max(0, run.length - joined);
    out.push(...run.slice(0, apart));
    if (run.length > apart) out.push(run.slice(apart).join(""));
    run = [];
  };
  for (const token of tokens) {
    if (SINGLE_LETTER.test(token)) {
      run.push(token);
      continue;
    }
    flush();
    out.push(token);
  }
  flush();
  return out;
}

const joinInitials = (tokens: readonly string[]): string[] => withRunsJoined(tokens, Number.POSITIVE_INFINITY);

function nameKeys(tokens: readonly string[]): string[] {
  const first = tokens[0];
  const last = tokens.at(-1);
  if (first === undefined || last === undefined) return [];
  return tokens.length >= 3 ? [tokens.join(" "), `${first} ${last}`] : [tokens.join(" ")];
}

// Titles often shorten a first name: Las Culturistas titled Megan Stalter's
// 2021 episode "w/ Meg Stalter" (found 23 Oct). So a word that starts with
// the first name's first three letters, right before the same surname, also
// counts. "Mike" for Michael and "Bill" for William are still missed.
const SHORT_FORM_LETTERS = 3;

// Walks the padded entry by index rather than splitting it, because a run
// asks this of every description for every person it meets.
function shortFormIn(entry: string, tokens: readonly string[]): boolean {
  const first = tokens[0];
  const last = tokens.at(-1);
  if (tokens.length < 2 || first === undefined || last === undefined || first.length < SHORT_FORM_LETTERS) return false;
  const stem = first.slice(0, SHORT_FORM_LETTERS);
  const surname = ` ${last} `;
  for (let at = entry.indexOf(surname); at !== -1; at = entry.indexOf(surname, at + 1)) {
    if (entry.slice(entry.lastIndexOf(" ", at - 1) + 1, at).startsWith(stem)) return true;
  }
  return false;
}

type Person = { readonly tokens: readonly string[]; readonly keys: readonly string[] };

const personFrom = (tokens: readonly string[]): Person => ({ tokens, keys: nameKeys(tokens).map((key) => ` ${key} `) });

// Each spelling the name can take: as written and, when it holds a run of
// single letters, with that run joined. An empty name gives none.
function spellingsOf(name: string): Person[] {
  const tokens = nameTokens(name);
  if (tokens.length === 0) return [];
  const joined = joinInitials(tokens);
  return joined.length === tokens.length ? [personFrom(tokens)] : [personFrom(tokens), personFrom(joined)];
}

// Descriptions name people in passing ("Peyton talks about the Manning
// family"), so they need the name written as one: whole, or first and last
// side by side, or the short form.
function strictMatch(entry: string, person: Person): boolean {
  return person.keys.some((key) => entry.includes(key)) || shortFormIn(entry, person.tokens);
}

// A title or a host entry names people on purpose, often two at once ("Peyton
// and Eli Manning", "Jason & Travis Kelce"), so the name's words count as
// whole words anywhere in it, in any order. Every word is needed, not only
// the first and last: "Michael B. Jordan" and "Michael I. Jordan" share a
// first and last name but are two people. A name that repeats a word, or has
// only one, still needs the strict rule.
function looseMatch(entry: string, person: Person): boolean {
  const { tokens } = person;
  if (tokens.length >= 2 && new Set(tokens).size === tokens.length && tokens.every((token) => entry.includes(` ${token} `))) return true;
  return strictMatch(entry, person);
}

// The spaced form, each run joined whole ("Q&A: J.J. Watt" as "qajj watt"),
// and each run with only its last two or three letters joined ("q a jj
// watt"), so the initials match whatever single letters come before them.
function entryKeys(text: string): string[] {
  const tokens = matchKey(text).split(" ");
  const spellings = new Set([tokens.join(" "), joinInitials(tokens).join(" ")]);
  for (let joined = 2; joined <= MAX_INITIALS; joined += 1) spellings.add(withRunsJoined(tokens, joined).join(" "));
  return [...spellings].map((key) => ` ${key} `);
}

const keysOf = (texts: readonly string[] | undefined): readonly string[] =>
  texts === undefined ? NONE : Object.freeze(texts.flatMap(entryKeys));

/**
 * Builds the index isPastGuest and isHost read: one match key per title, per
 * description and per host entry, every one of them, in any order, plus, for
 * an entry that holds a run of single letters, a key with each run joined
 * whole and keys with only each run's last two and last three letters
 * joined. The texts themselves are not kept, only their match keys.
 * descriptions and hosts default to none. The result and its lists are
 * frozen.
 */
export function pastGuestIndex(source: { titles: readonly string[]; descriptions?: readonly string[]; hosts?: readonly string[] }): PastGuestIndex {
  return Object.freeze({ titles: keysOf(source.titles), descriptions: keysOf(source.descriptions), hosts: keysOf(source.hosts) });
}

/**
 * True when the two names share a match key: the whole name, or first plus
 * last name once a trailing Jr, Sr, II, III or IV is dropped, after the same
 * normalising isPastGuest uses (normalizeName, accents dropped, punctuation
 * as spaces). So "Jose Andres" matches "José Andrés", "Mel Kiper" matches
 * "Mel Kiper, Jr.", "Nassim Taleb" matches "Nassim Nicholas Taleb", and
 * "J.J. Watt", "J. J. Watt" and "JJ Watt" match each other, because a run of
 * single letters is also tried joined. A
 * surname alone, a word that only starts the same ("Kiper" in "Kiperman"),
 * a short first name ("Meg" for Megan), nicknames, misspellings and
 * lookalike letters from other scripts do not match. An empty name matches
 * nothing. A false match can only drop a person, never add one.
 */
export function sameName(a: string, b: string): boolean {
  const left = new Set(spellingsOf(a).flatMap((spelling) => spelling.keys));
  return left.size > 0 && spellingsOf(b).some((spelling) => spelling.keys.some((key) => left.has(key)));
}

/**
 * True when anything in `index` names this person, so the run leaves them
 * out (C2.9). That includes a host: this is the one gate every person
 * passes, so it answers true for anyone isHost does too.
 *
 * Case, accents, quote marks and punctuation are ignored, words match only
 * whole ("Kiper" never matches "Kiperman"), and a trailing Jr, Sr, II, III
 * or IV is dropped. A title or a host entry matches when it holds every word
 * of the person's name as whole words anywhere in it, in any order, which
 * for a two-word name is the first name and the last name: "Peyton and Eli
 * Manning, Super Bowl 59 Preview" matches Peyton Manning and "New Heights
 * with Jason & Travis Kelce" matches Jason Kelce. It also matches on the
 * stricter rule below, so "David Sinclair" in a title still matches "David
 * A. Sinclair". A description matches only on that stricter rule, because
 * descriptions name people in passing: the whole name, or the first and
 * last name side by side. Either kind also matches a short form of the
 * first name (a word starting with its first three letters, such as "Meg"
 * for Megan) right before the surname. A one-word name, or one that repeats
 * a word, needs the whole name. A surname alone never matches, so "Taleb" in
 * a title does not mark "Nassim Nicholas Taleb". A run of single letters
 * in the name or an entry is also tried joined into one word, so "J.J.
 * Watt", "J. J. Watt" and "JJ Watt" all match each other, and in an entry
 * the run's last two or three letters are also tried joined on their own,
 * so "w/ J.J. Watt" and "Ep. 12 w/ D.J. Khaled" match "JJ Watt" and "DJ
 * Khaled". Four or more initials right after a stray letter are never tried
 * joined on their own. An empty name never matches.
 *
 * A guest no entry names is missed, and a different person with the same
 * first and last name (or a similar first name before the same surname) is
 * taken for a past guest. That false match only leaves a person off the
 * board; it can never put anyone on it. Nicknames that do not share the
 * first three letters ("Mike" for Michael), misspellings and lookalike
 * letters from other scripts are not matched.
 */
export function isPastGuest(index: PastGuestIndex, name: string): boolean {
  return spellingsOf(name).some(
    (person) =>
      index.titles.some((entry) => looseMatch(entry, person)) ||
      index.hosts.some((entry) => looseMatch(entry, person)) ||
      index.descriptions.some((entry) => strictMatch(entry, person)),
  );
}

/**
 * True when one of `index`'s host entries names this person, by the rule
 * isPastGuest applies to a host entry. Titles and descriptions never make
 * anyone a host. An empty name is never a host.
 */
export function isHost(index: PastGuestIndex, name: string): boolean {
  return spellingsOf(name).some((person) => index.hosts.some((entry) => looseMatch(entry, person)));
}
