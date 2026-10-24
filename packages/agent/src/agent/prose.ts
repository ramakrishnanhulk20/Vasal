import { LinkifyIt, REBuilder } from "linkify-it";
import { cleanText } from "../text/normalize.js";

export type ProseCheck = {
  ok: boolean;
  text: string;
  removed: { links: number; emails: number };
  reason?: "digits" | "too_long" | "empty" | "trend_claim" | "sensitive_trait" | "accusation";
};

// By default linkify-it treats a bare domain as a link only when its last
// label is on a short built-in list, so "evil.xyz/login" and "evil.example"
// pass straight through. This rule accepts any last label of 2 to 63 letters,
// or an xn-- label, which is what a top-level domain is. It also catches words
// such as "Node.js"; removing too much fails closed. It does not catch spelled
// out forms such as "evil dot com".
class AnyTopLevelDomain extends REBuilder {
  override get_tld(): RegExp {
    const cached = this.cache["tld"];
    if (cached !== undefined) return cached;
    const tld = new RegExp(`(?:(?![0-9])${this.get_pseudo_letter().source}){2,63}|${this.get_xn().source}`);
    this.cache["tld"] = tld;
    return tld;
  }
}

const linkify = new LinkifyIt({ fuzzyLink: true, fuzzyEmail: true, rebuilder: new AnyTopLevelDomain() });

const PLACEHOLDER = /\{\{([A-Za-z_][A-Za-z0-9_]{0,39})\}\}/g;
// Every Unicode number character, not only 0 to 9: fullwidth, Arabic-Indic,
// superscript and Roman numeral digits all read as figures on screen. This
// also keeps out phone numbers written in digits (C3.5).
const NUMBER_CHARACTER = /\p{N}/u;
// The digits hint used to ask for numbers in words, and a figure in words is
// still a made-up figure (C3.4). A run of four or more digit words spells out
// a phone number (C3.5). Only words that almost always state a figure are
// listed, so "one plain conversation" and "two hosts" pass. Matched
// case-insensitively on word boundaries.
const NUMBER_WORDS =
  /\b(?:hundreds?|thousands?|millions?|billions?|trillions?|dozens?|percent|per\s+cent|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)[\s\p{Pd}]+times?|(?:(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)[\s\p{Pd},.]+){3,}(?:zero|oh|one|two|three|four|five|six|seven|eight|nine))\b/iu;
const SPACE_RUN = /[^\S\r\n]{2,}/g;
/** The words the prompts and finish_board's hint name, kept next to TREND_CLAIM so the two cannot drift apart. */
export const TREND_CLAIM_WORDS = "rising, on the rise, trending, up and coming, a breakout, buzzy, surging or growing in popularity";
// Words that say someone is gaining popularity, matched case-insensitively on
// word boundaries, so "surprising", "uprising", "arising" and "risings" pass.
// Each gap takes any run of spaces or Unicode dashes, so "up and coming",
// "up-and-coming" and a non-breaking hyphen all match. A breakout role, film
// or album is a past work, not a claim about momentum, so "breakout" passes
// when a named kind of work follows it. "Breakout year", "breakout star" and
// "a breakout" on its own still claim momentum. It does not catch every
// synonym, such as "hot right now"; the prompts forbid those too.
const TREND_CLAIM =
  /\b(?:rising(?:\s+star)?|on\s+the\s+rise|trending|up[\s\p{Pd}]+and[\s\p{Pd}]+coming|breakout(?![\s\p{Pd}]+(?:roles?|films?|movies?|performances?|parts?|albums?|singles?|songs?|records?|hits?|shows?|series|seasons?|books?|novels?|specials?|plays?)\b)|buzzy|surging|growing\s+in\s+popularity)\b/iu;
/** The sentence the prompts and finish_board's hint share. */
export const SENSITIVE_TRAITS_RULE =
  "Do not describe the guest's sexuality, gender identity, health, religion, ethnicity or politics; talk about their work and ideas.";
// The list is narrow on purpose: each of these words, used about a person,
// almost always claims something about them. Religion, ethnicity and politics
// words are also everyday topics ("science and religion", "political
// satire"), and so are some health words ("cancer research", "tech
// addiction"), so those stay prompt rules only. A false refusal costs the
// model one rewrite. Matched case-insensitively on word boundaries, so
// "Transformers" and "Gaylord" pass. Because of those boundaries, plural and
// derived forms ("lesbians", "queerness", "bisexuality") are listed one by
// one. A named diagnosis such as PTSD, OCD, Parkinson's or epilepsy claims a
// person's health as plainly as "diagnosed" does, so those are listed too.
const SENSITIVE_TRAIT =
  /\b(?:queer(?:ness)?|gays?|lesbians?|bisexuals?|bisexuality|pansexuals?|pansexuality|asexuals?|asexuality|transgenders?|trans|genderqueer|gender[\s\p{Pd}]*fluid|nonbinary|non[\s\p{Pd}]+binary|intersex|lgbt[a-z+]*|sexuality|sexual\s+orientation|(?:came|coming)\s+out\s+as|coming\s+out\s+stor(?:y|ies)|diagnosed|autism|autistic|adhd|bipolar|schizophreni(?:a|c)|ptsd|ocd|parkinson[’']?s|alzheimer[’']?s|dementia|dyslexi(?:a|c)|tourette[’']?s|epilep(?:sy|tic)|anorexi(?:a|c)|bulimi(?:a|c)|chemotherapy|terminally\s+ill|miscarriages?|infertility|pregnan(?:t|cy)|hiv)\b/iu;
/** The sentence the prompts and finish_board's hint share. */
export const ACCUSATIONS_RULE = "Do not mention arrests, charges, lawsuits, accusations or scandals.";
// An angle is the one text the model writes knowing the name, and an
// accusation about a real person is the costliest thing it can get wrong.
// Only words that almost always report one are listed, so "current
// affairs", "a legal thriller" and "injury rehab" pass. "Cardiac arrest" is
// refused too, which costs one rewrite and is a health claim anyway. Matched
// case-insensitively on word boundaries.
const ACCUSATION =
  /\b(?:arrest(?:s|ed)?|convicted|convictions?|accused|accusations?|allegations?|allegedly|lawsuits?|sued|indicted|indictments?|charged\s+with|scandals?|overdosed?|overdoses|jailed|imprisoned|incarcerated|fraud|abused|abusers?|misconduct|harass(?:ed|ment))\b/iu;
// Ethnicity, religion and gender words. In prose they are everyday topics, so
// only isShowableTag uses them. Matched case-insensitively on word
// boundaries, so "Blackjack" and "Menswear" pass.
const IDENTITY_TAG =
  /\b(?:latin[oax]s?|hispanic|black|african[\s\p{Pd}]+american|asian[\s\p{Pd}]+american|indigenous|native[\s\p{Pd}]+american|arab|jewish|judaism|muslim|islam(?:ic)?|christian(?:ity)?|catholic|mormon|evangelical|hindu|buddhist|sikh|atheist|womens?|female|male|men|feminis[mt])\b/iu;

const refuse = (reason: NonNullable<ProseCheck["reason"]>, removed: ProseCheck["removed"]): ProseCheck => ({
  ok: false,
  text: "",
  removed,
  reason,
});

/**
 * Removes every link, bare domain and email address linkify-it finds in
 * `text` and counts them (C3.5, D5.3). The scan repeats until nothing is
 * found, so a cut that joins two pieces into a new link is caught too. When
 * anything was removed, runs of spaces (not newlines) collapse to one and the
 * result is trimmed; otherwise `text` comes back unchanged. Clean the text
 * with cleanText first, because an invisible character inside a link hides
 * it from the scan. It does not catch spelled out forms such as "evil dot
 * com". Never throws for a string.
 */
export function withoutLinks(text: string): { text: string; removed: ProseCheck["removed"] } {
  const removed = { links: 0, emails: 0 };
  let current = text;
  // Each pass removes at least one character, so this ends. It repeats
  // because cutting one link out can join the pieces around it into another.
  for (;;) {
    const matches = linkify.match(current);
    if (matches === null || matches.length === 0) break;
    let kept = "";
    let from = 0;
    for (const match of matches) {
      if (match.schema === "mailto:") removed.emails += 1;
      else removed.links += 1;
      kept += current.slice(from, match.index);
      from = match.lastIndex;
    }
    current = kept + current.slice(from);
  }
  if (removed.links + removed.emails === 0) return { text, removed };
  return { text: current.replace(SPACE_RUN, " ").trim(), removed };
}

/**
 * Checks prose the model wrote before it is stored or shown. In order: strips
 * Unicode direction controls (C3.7) and trims; refuses empty text and text
 * longer than `maxChars` code points; removes every link, bare domain and
 * email address linkify-it finds and counts them (C3.5); refuses with reason
 * "digits" if any number character is left outside a `{{name}}` placeholder
 * whose name is in `placeholders` (C3.4), and also if that text states a
 * figure in words ("three million", "a dozen", "ninety percent", "two-time")
 * or spells out four or more digits in a row, as a phone number would be
 * (C3.5). A placeholder not on that list is
 * plain text, so any digit inside it fails. With `noTrendClaims`, the same
 * text outside the listed placeholders is refused with reason "trend_claim"
 * if it calls someone rising, on the rise, trending, up and coming, "a
 * breakout" (but not a breakout role, film, album or other named work),
 * buzzy, surging or growing in popularity. Always, that text is refused with
 * reason "sensitive_trait" if it uses a word that almost always claims a
 * person's sexuality, gender identity or health, such as "queer", "trans" or
 * "diagnosed"; every prose check is about a real person, so this is not
 * optional. For the same reason it is always refused with reason
 * "accusation" if it reports an arrest, a charge, a lawsuit, an accusation
 * or a scandal, such as "arrested", "accused" or "lawsuit". These checks run
 * before placeholders are filled, so a filled-in
 * value never trips them. Text left empty by removals is refused as
 * "empty". On refusal `text` is "", so failed prose cannot be shown by
 * mistake.
 *
 * Throws RangeError when maxChars is not a positive integer.
 */
export function checkProse(
  raw: string,
  opts: { maxChars: number; placeholders: readonly string[]; noTrendClaims?: boolean },
): ProseCheck {
  if (!Number.isSafeInteger(opts.maxChars) || opts.maxChars < 1) throw new RangeError("maxChars must be a positive integer.");
  const noneRemoved = { links: 0, emails: 0 };
  if (typeof raw !== "string") return refuse("empty", noneRemoved);

  // Cleaned before the link scan: a zero-width character inside "https://" hides a
  // link from linkify-it, and cleaning only afterwards would hand the page a working URL.
  const trimmed = cleanText(raw, { maxChars: Number.MAX_SAFE_INTEGER, keepNewlines: true }).trim();
  if (trimmed === "") return refuse("empty", noneRemoved);
  if ([...trimmed].length > opts.maxChars) return refuse("too_long", noneRemoved);

  const { text, removed } = withoutLinks(trimmed);
  if (text === "") return refuse("empty", removed);

  const allowed = new Set(opts.placeholders);
  const outsidePlaceholders = text.replace(PLACEHOLDER, (token, name: string) => (allowed.has(name) ? "" : token));
  if (NUMBER_CHARACTER.test(outsidePlaceholders)) return refuse("digits", removed);
  if (NUMBER_WORDS.test(outsidePlaceholders)) return refuse("digits", removed);
  if (opts.noTrendClaims === true && TREND_CLAIM.test(outsidePlaceholders)) return refuse("trend_claim", removed);
  if (SENSITIVE_TRAIT.test(outsidePlaceholders)) return refuse("sensitive_trait", removed);
  if (ACCUSATION.test(outsidePlaceholders)) return refuse("accusation", removed);

  return { ok: true, text, removed };
}

/**
 * Whether a Qloo tag name may be shown as a taste chip. A taste chip shown
 * next to a person reads as a fact about them, so identity words never
 * appear as chips: false when the name uses a word checkProse refuses as a
 * sensitive trait, or an ethnicity, religion or gender word such as "Black",
 * "Muslim" or "Women"; true otherwise. Words match whole, so "Blackjack" and
 * "Menswear" pass. A dropped chip costs nothing, so this errs toward
 * dropping: "Jack Black" and "Mad Men" go too. Check the name exactly as it
 * will be shown, since cutting a name can leave a new whole word at its end.
 */
export function isShowableTag(name: string): boolean {
  return !SENSITIVE_TRAIT.test(name) && !IDENTITY_TAG.test(name);
}

/**
 * Replaces each `{{name}}` token whose name is a key of `values` with that
 * code-computed string, in one pass, so a value is never itself scanned for
 * tokens. Any other token is left exactly as typed. Run checkProse first:
 * it is what refuses digits typed outside the allowed placeholders.
 */
export function fillPlaceholders(text: string, values: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (token, name: string) => (Object.hasOwn(values, name) ? String(values[name]) : token));
}
