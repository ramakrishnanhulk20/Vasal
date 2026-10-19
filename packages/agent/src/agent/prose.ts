import { LinkifyIt, REBuilder } from "linkify-it";
import { stripBidiControls } from "../text/normalize.js";

export type ProseCheck = {
  ok: boolean;
  text: string;
  removed: { links: number; emails: number };
  reason?: "digits" | "too_long" | "empty";
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
// superscript and Roman numeral digits all read as figures on screen. A phone
// number needs digits, so this also keeps phone numbers out (C3.5).
const NUMBER_CHARACTER = /\p{N}/u;
const SPACE_RUN = /[^\S\r\n]{2,}/g;

const refuse = (reason: NonNullable<ProseCheck["reason"]>, removed: ProseCheck["removed"]): ProseCheck => ({
  ok: false,
  text: "",
  removed,
  reason,
});

function withoutLinks(text: string): { text: string; removed: ProseCheck["removed"] } {
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
 * whose name is in `placeholders` (C3.4). A placeholder not on that list is
 * plain text, so any digit inside it fails. Text left empty by removals is
 * refused as "empty". On refusal `text` is "", so failed prose cannot be shown
 * by mistake.
 *
 * Throws RangeError when maxChars is not a positive integer.
 */
export function checkProse(raw: string, opts: { maxChars: number; placeholders: readonly string[] }): ProseCheck {
  if (!Number.isSafeInteger(opts.maxChars) || opts.maxChars < 1) throw new RangeError("maxChars must be a positive integer.");
  const noneRemoved = { links: 0, emails: 0 };
  if (typeof raw !== "string") return refuse("empty", noneRemoved);

  const trimmed = stripBidiControls(raw).trim();
  if (trimmed === "") return refuse("empty", noneRemoved);
  if ([...trimmed].length > opts.maxChars) return refuse("too_long", noneRemoved);

  const { text, removed } = withoutLinks(trimmed);
  if (text === "") return refuse("empty", removed);

  const allowed = new Set(opts.placeholders);
  const outsidePlaceholders = text.replace(PLACEHOLDER, (token, name: string) => (allowed.has(name) ? "" : token));
  if (NUMBER_CHARACTER.test(outsidePlaceholders)) return refuse("digits", removed);

  return { ok: true, text, removed };
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
