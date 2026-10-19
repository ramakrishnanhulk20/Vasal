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
 * way it is stored (threat model C3.7). Everything else is left as is.
 */
export function stripBidiControls(text: string): string {
  return text.replace(BIDI_CONTROL, "");
}
