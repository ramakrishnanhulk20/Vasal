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
};

/**
 * Starts the context for one run from the confirmed show, its recent episode
 * titles and the visitor's exclusion list. The lists are copied, so later
 * changes to the caller's arrays do not reach the run. The show's demographics
 * may be passed in when already known; otherwise the first audience_of call
 * fetches them.
 */
export function createRunContext(input: {
  show: { qlooId: string; name: string };
  episodeTitles: readonly string[];
  exclusions: readonly string[];
  showDemographics?: Demographics | null;
}): RunContext {
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
  };
}
