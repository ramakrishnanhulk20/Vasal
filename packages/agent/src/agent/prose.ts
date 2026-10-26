import { LinkifyIt, REBuilder } from "linkify-it";
import { cleanText } from "../text/normalize.js";

export type ProseCheck = {
  ok: boolean;
  text: string;
  removed: { links: number; emails: number };
  reason?: "digits" | "too_long" | "empty" | "trend_claim" | "sensitive_trait" | "accusation" | "release_claim" | "family_claim";
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
// A figure in words is still a made-up figure (C3.4): "her second Emmy", "a
// decade on tour" and "won twice" all state a count the data never gave.
// Refused, case-insensitively on word boundaries: the cardinals two to
// nineteen; the tens twenty to ninety, which also refuses a tens word joined
// to a unit by a hyphen or a space ("twenty-five", "forty two"); the
// ordinals second to nineteenth, twentieth to ninetieth, hundredth,
// thousandth, millionth, billionth and trillionth; hundred, thousand,
// million, billion and trillion, singular or plural; decade, decades,
// century, centuries, twice, thrice, dozen, dozens, percent and "per cent",
// so "half a century" and "a quarter century" are caught too; double,
// triple, quadruple and quintuple, with or without a final "d", "s" or
// "ing" ("a double Emmy winner", "she doubled her audience", "her sales
// triples", "doubling every year"), except "doubles" right before tennis,
// match or partner; sextuple, septuple and octuple; halve, halved, halves
// and halving; any word that ends in "fold" after at least one letter
// ("twofold", "tenfold"), which also refuses "unfold", "manifold" and
// "scaffold" at the cost of one rewrite, as "mid-century" does; "one time"
// or "one-time"; and a run of four or more digit words, which spells out a
// phone number (C3.5). "One", "first", "single", "zero", "half" and
// "quarter" on their own pass ("half the fun", "a quarter of the episode"),
// and so do longer words that start with a listed one, such as "seconds",
// "secondary", "tenths" and "sextupled". A tens word fused to its unit with
// no gap ("fortytwo") is not caught.
const NUMBER_WORDS =
  /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth|fortieth|fiftieth|sixtieth|seventieth|eightieth|ninetieth|hundredth|thousandth|millionth|billionth|trillionth|hundreds?|thousands?|millions?|billions?|trillions?|decades?|centur(?:y|ies)|twice|thrice|dozens?|percent|per\s+cent|doubl(?:e|ed|ing)|doubles(?![\s\p{Pd}]+(?:tennis|match|partner)\b)|tripl(?:e|ed|es|ing)|quadrupl(?:e|ed|es|ing)|quintupl(?:e|ed|es|ing)|sextuple|septuple|octuple|halv(?:e|ed|es|ing)|\p{L}+fold|one[\s\p{Pd}]+times?|(?:(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)[\s\p{Pd},.]+){3,}(?:zero|oh|one|two|three|four|five|six|seven|eight|nine))\b/iu;
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
/** The sentence the prompts and finish_board's hint share. */
export const RELEASE_CLAIM_RULE =
  "Qloo does not say who is in a release, so never write that someone has a film, show, book or album coming out. Pick them for it if you like, but write the angle about their work so far.";
// upcoming_releases lists titles only and Qloo never says who is in one, so
// "her new film" or "his album is on the way" is a guess about a real
// person's work (A2-5). Matched case-insensitively on word boundaries, each
// gap any run of spaces or Unicode dashes. A lead word (upcoming,
// forthcoming, new, latest, next, debut, coming) counts when a kind of work
// is one of the next three words, so "the upcoming Dune sequel" and "his new
// Netflix series" are caught; its gaps also take a comma, so "her upcoming,
// untitled film" is caught too. A word in between may not be exactly to, on,
// for, of, at, in, with, the, this, that, our, your or their, because those
// start a phrase about something else, so "new to the show" and "new on this
// show" pass; that also lets "the next of her books" through. A release verb
// in the present (comes, coming, drops, dropping, releases, releasing,
// arrives, arriving, lands, landing, hits, premieres, opens) counts right
// before "in", "this", "next" or "later this", with "out" allowed between,
// and then the name of a month, or week, month, year, season or a time of
// year, so "comes out in May", "drops this fall" and "arrives later this
// year" are caught; up to two words may also sit between the verb and "later
// this" plus a time, or "in" plus a month's name, so "hits stores in March"
// is caught. A verb in the past
// ("came out in spring") is not a claim about what is coming. "Coming out
// as" and "coming out story" are refused earlier as sensitive traits.
// "Episode", "release" on its own, "before release", "an upcoming episode"
// and "premier" pass. It does not catch every way to say it, such as "has a
// film out soon"; the prompts forbid those too.
const RELEASE_CLAIM =
  /\b(?:coming[\s\p{Pd}]+out|on[\s\p{Pd}]+the[\s\p{Pd}]+way|out[\s\p{Pd}]+(?:this|next)[\s\p{Pd}]+(?:week|month|year|spring|summer|fall|autumn|winter)|due(?:[\s\p{Pd}]+out)?[\s\p{Pd}]+(?:this|next)[\s\p{Pd}]+(?:week|month|year|season|spring|summer|fall|autumn|winter)|(?:upcoming|forthcoming|new|latest|next|debut|coming)(?:[\s\p{Pd},]+(?!(?:to|on|for|of|at|in|with|the|this|that|our|your|their)(?![^\s\p{Pd},]))[^\s\p{Pd},]+){0,2}[\s\p{Pd},]+(?:films?|movies?|series|shows?|specials?|books?|memoirs?|novels?|albums?|records?|singles?|tours?|seasons?|documentar(?:y|ies)|projects?|sequels?|prequels?|reboots?|remakes?|spin\p{Pd}?offs?|adaptations?)|(?:comes|coming|drops|dropping|releases|releasing|arrives|arriving|lands|landing|hits|premieres|opens)(?:[\s\p{Pd}]+(?:out[\s\p{Pd}]+)?(?:in|this|next|later(?:[\s\p{Pd}]+this)?)[\s\p{Pd}]+(?:january|february|march|april|may|june|july|august|september|october|november|december|week|month|year|season|spring|summer|fall|autumn|winter)|(?:[\s\p{Pd}]+[^\s\p{Pd}]+){0,2}[\s\p{Pd}]+(?:later[\s\p{Pd}]+this[\s\p{Pd}]+(?:week|month|year|season|spring|summer|fall|autumn|winter)|in[\s\p{Pd}]+(?:january|february|march|april|may|june|july|august|september|october|november|december)))|slated[\s\p{Pd}]+(?:for|to)|set[\s\p{Pd}]+to[\s\p{Pd}]+(?:premiere|release|debut|open|drop)|premier(?:es?|ed|ing)|in[\s\p{Pd}]+theat(?:er|re)s|hits[\s\p{Pd}]+(?:theat(?:er|re)s|shelves))\b/iu;
/** The sentence the prompts and finish_board's hint share. */
export const FAMILY_RULE =
  "Do not mention the guest's partner, marriage, children or other family: what a model remembers about a real person's family is often wrong.";
// A model's memory of who a real person married, divorced or had children
// with is often wrong, and the guest's team reads the pitch. Matched
// case-insensitively on whole words, so "Sonic", "Babylon" and "sonnet"
// pass. "Partner" and "family" pass too, because business
// partners and family comedy are everyday topics; the prompts forbid those
// claims instead. checkProse's NFC cleaning composes a typed accent first, so
// "fiancé" arrives as one letter é. \b counts é as a non-word character and
// would never match after it, so the accented forms end where no letter,
// digit or underscore follows instead. A form not listed, such as "fiancés"
// or "stepson", is not caught.
const FAMILY_CLAIM =
  /\b(?:wife|wives|husbands?|spouses?|marriages?|married|divorced?|fiancee?|girlfriends?|boyfriends?|motherhood|fatherhood|parenthood|parenting|kids?|children|sons?|daughters?|baby|babies|newborns?|widows?|widowed|widowers?)\b|\bfiancée?(?![\p{L}\p{N}_])/iu;
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
 * figure in words ("two", "ninety-five", "second", "a decade", "twice", "a
 * dozen", "three million", "ninety percent", "double", "tenfold",
 * "millionth") or spells out four or more digits in a row, as a phone
 * number would be (C3.5); "one", "first" and "single" pass. A placeholder not on that list is
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
 * or a scandal, such as "arrested", "accused" or "lawsuit", with reason
 * "release_claim" if it says someone has a release coming, such as "coming
 * out", "her new film", "the upcoming Dune sequel", "out next month", "due
 * next year", "slated for spring", "set to premiere" or "premieres", and with reason
 * "family_claim" if it names a spouse, a marriage, a child or a parenthood,
 * such as "wife", "married", "kids" or "daughter"; "partner" and "family"
 * pass. These checks run
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
  if (RELEASE_CLAIM.test(outsidePlaceholders)) return refuse("release_claim", removed);
  if (FAMILY_CLAIM.test(outsidePlaceholders)) return refuse("family_claim", removed);

  return { ok: true, text, removed };
}

// The tag families whose tags describe a work or a conversation: genres,
// styles, tone, aesthetics, the host's manner and the kind of audience.
// Families that describe a person (ethnicity, nationality, gender,
// religion, residence, occupation, lifestyle, hobby) or hold free-form
// topics (theme, keyword, category, archetype, characteristic) are left
// out. An allowlist rather than a denylist, so a family Qloo adds later is
// dropped until someone reads what it holds. The names in a family listed
// here can still be sensitive ("African American" sits in genre:media), so
// isShowableTag checks every name as well.
const SHOWABLE_TAG_FAMILIES: ReadonlySet<string> = new Set([
  "urn:tag:genre:media",
  "urn:tag:genre:qloo",
  "urn:tag:subgenre:qloo",
  "urn:tag:style:qloo",
  "urn:tag:content:qloo",
  "urn:tag:emotional_tone:qloo",
  "urn:tag:aesthetic_property:qloo",
  "urn:tag:host:qloo",
  "urn:tag:audience:qloo",
]);
// A chip sits next to a real person's name and reads as a fact about them,
// and a dropped chip costs nothing, so chips use this broad topic net while
// prose keeps its narrow lists. Matched case-insensitively on whole words,
// so "Monumental", "Experimental" and "Dragon centric" pass, and harmless
// names that use a listed word, such as "Space race film", are dropped too.
const CHIP_TOPIC =
  /\b(?:crimes?|criminal|sex|sexual|sexually|sexuality|erotica?|political|politically|politics|sociopolitical|sociopolitically|geopolitical|geopolitically|progressive|conservative|liberal|partisan|republicans?|democrats?|religions?|religious|faith|spiritual|spiritually|spirituality|health|mental|therapy|therapists?|anxiety|depression|cancer|illness(?:es)?|diseases?|disability|addiction|addictive|recovery|sobriety|race|racial|ethnic|ethnicity|immigrants?|asians?|gender|drag|environmental|environmentally|activism|activists?)\b/iu;
// These two are harmless inside a longer name ("Mature storytelling"), but
// standing alone beside a name they read as a claim about the person.
const CHIP_WHOLE_NAME = /^\s*(?:socially[\s\p{Pd}]+conscious|mature)\s*$/iu;
// A family is the first four parts of the id, and at least one lowercase
// part follows it ("urn:tag:genre:media:comedy", and Qloo's own
// "urn:tag:genre:media:media:action"). Any other shape, including a bare
// family or a different case, gives no family.
const TAG_ID = /^(urn:tag:[a-z_]+:[a-z_]+)(?::[a-z0-9_]+)+$/;

/**
 * Whether a Qloo tag id belongs to a family whose tags may be shown as taste
 * chips: genre:media, genre:qloo, subgenre:qloo, style:qloo, content:qloo,
 * emotional_tone:qloo, aesthetic_property:qloo, host:qloo and audience:qloo.
 * False for every other family, such as theme, keyword, ethnicity, religion
 * or gender, for a family not seen before, and for an id of any other shape.
 * It says nothing about the tag's name; use isShowableTag for that too.
 */
export function isShowableTagId(tagId: string): boolean {
  if (typeof tagId !== "string") return false;
  const family = TAG_ID.exec(tagId)?.[1];
  return family !== undefined && SHOWABLE_TAG_FAMILIES.has(family);
}

/**
 * Whether a Qloo tag name may be shown as a taste chip. A taste chip shown
 * next to a person reads as a fact about them, so identity words never
 * appear as chips: false when the name uses a word checkProse refuses as a
 * sensitive trait or an accusation, an ethnicity, religion or gender word
 * such as "Black", "Muslim" or "Women", or a crime, sex, politics, faith,
 * health, addiction, race, gender or activism topic word such as "Mental
 * Health", "Faith oriented" or "Political comedy", or is exactly "Socially
 * conscious" or "Mature"; true otherwise. Words
 * match whole, so "Blackjack", "Menswear" and "Experimental" pass. A dropped
 * chip costs nothing, so this errs toward dropping: "Jack Black", "Mad Men"
 * and "Space race film" go too. Check the name
 * exactly as it will be shown, since cutting a name can leave a new whole
 * word at its end. This is the second net under isShowableTagId, not a
 * replacement for it.
 */
export function isShowableTag(name: string): boolean {
  return !SENSITIVE_TRAIT.test(name) && !IDENTITY_TAG.test(name) && !ACCUSATION.test(name) && !CHIP_TOPIC.test(name) && !CHIP_WHOLE_NAME.test(name);
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
