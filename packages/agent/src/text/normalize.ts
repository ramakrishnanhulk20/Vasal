const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
const BIDI_CONTROL = /\p{Bidi_Control}/gu;
const WHITESPACE_RUN = /\s+/gu;
// NFKC keeps typographic quotes distinct from ASCII ones, and Apple writes
// "Conan O’Brien" where Qloo may write "Conan O'Brien". These are the only
// quote marks folded.
const SINGLE_QUOTE_MARKS = /[‘’‛ʼ′]/gu;
const DOUBLE_QUOTE_MARKS = /[“”‟″]/gu;

/**
 * The one normaliser for comparing names (threat model C8.3, C9.1): NFKC,
 * invisible characters removed, typographic quote marks folded to ASCII,
 * lower case, whitespace collapsed and trimmed. It makes "Dax  Shepard",
 * "DAX SHEPARD", "O’Brien" and "O'Brien", and a name with a zero-width space
 * equal. It does not handle lookalike letters from other scripts, nicknames
 * or misspellings; anything that must survive those is matched by Qloo id.
 */
export function normalizeName(text: string): string {
  return text
    .normalize("NFKC")
    .replace(DEFAULT_IGNORABLE, "")
    .replace(SINGLE_QUOTE_MARKS, "'")
    .replace(DOUBLE_QUOTE_MARKS, '"')
    .toLowerCase()
    .replace(WHITESPACE_RUN, " ")
    .trim();
}

/**
 * Removes Unicode direction-control characters so upstream text displays the
 * way it is stored. Everything else is left as is. cleanText does this and
 * more; prefer it for anything shown to a person or a model.
 */
export function stripBidiControls(text: string): string {
  return text.replace(BIDI_CONTROL, "");
}

const CONTROL = /\p{Cc}/gu;
const CONTROL_EXCEPT_NEWLINE = /(?!\n)\p{Cc}/gu;
// Whitespace controls separate words, so they become a space rather than
// vanishing: "Ada\tLovelace" must not read "AdaLovelace". CRLF and CR become a
// newline first, so a kept line break survives either line ending.
const LINE_ENDING = /\r\n?/gu;
const SPACING_CONTROL = /[\t\v\f]/gu;
const HORIZONTAL_SPACE_RUN = /[^\S\n]{2,}/gu;

/**
 * The one cleaner for third-party and model-written text before it reaches a
 * person, Vasal's model or another agent (threat model C2.8, C3.7, D5.2):
 * NFC, control characters removed (newlines kept only when asked), every
 * default-ignorable code point removed (this takes out the invisible Unicode
 * tag characters U+E0000 to U+E007F and zero-width characters), direction
 * controls removed, then cut to maxChars code points. It does not remove
 * visible text that reads like an instruction, or lookalike letters.
 */
export function cleanText(text: string, opts: { maxChars: number; keepNewlines?: boolean }): string {
  const keepNewlines = opts.keepNewlines === true;
  const cleaned = text
    .normalize("NFC")
    .replace(LINE_ENDING, "\n")
    .replace(SPACING_CONTROL, " ")
    .replace(keepNewlines ? /(?!)/gu : /\n/gu, " ")
    .replace(keepNewlines ? CONTROL_EXCEPT_NEWLINE : CONTROL, "")
    .replace(DEFAULT_IGNORABLE, "")
    .replace(BIDI_CONTROL, "")
    .replace(HORIZONTAL_SPACE_RUN, " ");
  const points = Array.from(cleaned);
  return points.length <= opts.maxChars ? cleaned : points.slice(0, opts.maxChars).join("");
}
