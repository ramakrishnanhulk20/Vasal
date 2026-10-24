import { NO_PAST_GUESTS, pastGuestIndex, type PastGuestIndex } from "./past-guests.js";
import type { ToolName } from "./tools.js";

/** A person some tool returned in this run. Only these may appear on the board. */
export type PersonRecord = { name: string; affinity: number | null; popularity: number | null };

/** Signed Qloo indices per age band and per gender: above 0 means stronger than average. */
export type Demographics = { age: Readonly<Record<string, number>>; gender: Readonly<Record<string, number>> };

/** One weekly trending row as Qloo returns it. */
export type TrendRow = { date: string; population_percentile?: number | null | undefined };

/** One taste the show's audience and a person's audience share. */
export type SharedTag = { name: string; score: number | null };

/** What the live stream may show about one tool call: fixed words and counts only. */
export type StepSummary = { tool: ToolName | "unknown"; ok: boolean; summary: string };

/** One episode as the feed gave it, for the past-guest check. publishedAt is an ISO date or null. */
export type PastGuestEpisode = { title: string; publishedAt: string | null };

/**
 * How far the past-guest check reached. checked is true only when the feed
 * gave at least one episode title; titles is how many it gave, and since is
 * the month of the oldest dated one as "YYYY-MM", or null when none is dated.
 * The index also holds the names the show goes by, so its hosts are left out
 * even when checked is false.
 */
export type PastGuestCheck = {
  readonly checked: boolean;
  readonly titles: number;
  readonly since: string | null;
  readonly index: PastGuestIndex;
  readonly skipped: Set<string>;
};

/**
 * Everything one research run has learned, held in memory for that run only.
 * Tools write to it and the board is computed from it, so the model never
 * supplies a figure, a person or an id that code did not see come back from
 * Qloo. It holds no URL of any kind.
 */
export type RunContext = {
  readonly show: { readonly qlooId: string; readonly name: string };
  readonly episodeTitles: readonly string[];
  readonly exclusions: readonly string[];
  readonly people: Map<string, PersonRecord>;
  showDemographics: Demographics | null;
  readonly personDemographics: Map<string, Demographics>;
  readonly trends: Map<string, TrendRow[]>;
  readonly compares: Map<string, SharedTag[]>;
  readonly toolCalls: Map<ToolName, number>;
  readonly steps: StepSummary[];
  // checked is false when the show's feed gave no title to check, so the run
  // can say past guests were not checked instead of implying there were none.
  readonly pastGuests: PastGuestCheck;
  // Every id left out as dead or as a past guest. A later answer may spell
  // the name another way or leave the death date out, so these ids are
  // refused for the rest of the run, whatever comes back.
  readonly dropped: Set<string>;
  // Ids some people_for_show answer returned, so Qloo ranked them for this
  // show's audience. Anyone else reached the run only through find_person,
  // whose input a pasted feed's titles can steer, so the board asks more of
  // them.
  readonly listedForShow: Set<string>;
};

const YEAR_MONTH = /^\d{4}-\d{2}$/;

// The oldest dated episode bounds how far back the check reached. A date
// outside four-digit years would not print as YYYY-MM, so it gives no month
// rather than a misleading one.
function oldestMonth(episodes: readonly PastGuestEpisode[]): string | null {
  let oldest = Number.POSITIVE_INFINITY;
  for (const episode of episodes) {
    const ms = episode.publishedAt === null ? Number.NaN : Date.parse(episode.publishedAt);
    if (Number.isFinite(ms) && ms < oldest) oldest = ms;
  }
  if (!Number.isFinite(oldest)) return null;
  const month = new Date(oldest).toISOString().slice(0, 7);
  return YEAR_MONTH.test(month) ? month : null;
}

/**
 * Starts the context for one run from the confirmed show, its recent episode
 * titles and the visitor's exclusion list. The lists are copied, so later
 * changes to the caller's arrays do not reach the run. The show's demographics
 * may be passed in when already known; otherwise the first audience_of call
 * fetches them.
 *
 * pastGuestEpisodes is every episode the feed gave, used only to leave past
 * guests out; undefined or null means the feed could not be read. An episode
 * whose title is blank is not counted. pastGuests.checked is true only when
 * at least one title is left, titles is that count and since the oldest
 * dated one's month. showRunners are the names the show goes by (its
 * directory name, publisher, Qloo name and feed title); they join the titles
 * in the index whether or not any title was given, so a host is left out
 * either way, and they never count as titles.
 */
export function createRunContext(input: {
  show: { qlooId: string; name: string };
  episodeTitles: readonly string[];
  exclusions: readonly string[];
  showDemographics?: Demographics | null;
  pastGuestEpisodes?: readonly PastGuestEpisode[] | null;
  showRunners?: readonly string[];
}): RunContext {
  const episodes = (input.pastGuestEpisodes ?? []).filter((episode) => episode.title.trim() !== "");
  const titles = episodes.map((episode) => episode.title);
  const entries = [...titles, ...(input.showRunners ?? []).filter((name) => name.trim() !== "")];
  return {
    show: Object.freeze({ qlooId: input.show.qlooId, name: input.show.name }),
    episodeTitles: Object.freeze([...input.episodeTitles]),
    exclusions: Object.freeze([...input.exclusions]),
    people: new Map(),
    showDemographics: input.showDemographics ?? null,
    personDemographics: new Map(),
    trends: new Map(),
    compares: new Map(),
    toolCalls: new Map(),
    steps: [],
    pastGuests: {
      checked: titles.length > 0,
      titles: titles.length,
      since: oldestMonth(episodes),
      index: entries.length > 0 ? pastGuestIndex(entries) : NO_PAST_GUESTS,
      skipped: new Set(),
    },
    dropped: new Set(),
    listedForShow: new Set(),
  };
}
