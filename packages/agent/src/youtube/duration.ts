const MAX_LENGTH = 32;

// Days, hours, minutes and seconds, each optional but in that order. The
// lookahead after P refuses a bare "P", and the one after T refuses "PT" and
// "P1DT". Years, months and weeks are refused because YouTube never sends
// them and their length in seconds is not fixed. P0D, which YouTube sends for
// live and upcoming streams, reads as 0.
const PATTERN = /^P(?!$)(?:([0-9]+)D)?(?:T(?=[0-9])(?:([0-9]+)H)?(?:([0-9]+)M)?(?:([0-9]+)S)?)?$/;

/**
 * Converts a YouTube video duration such as PT1H2M3S, PT45M, P1DT2H or PT0S
 * into whole seconds.
 *
 * Returns null for anything else, including strings over 32 characters,
 * fractions, signs, lower case, years, months, weeks, and totals beyond the
 * safe integer range. Never throws.
 */
export function isoDurationSeconds(text: string): number | null {
  if (typeof text !== "string" || text.length > MAX_LENGTH) return null;
  const match = PATTERN.exec(text);
  if (match === null) return null;

  const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
  const total = Number(days) * 86_400 + Number(hours) * 3_600 + Number(minutes) * 60 + Number(seconds);
  return Number.isSafeInteger(total) ? total : null;
}
