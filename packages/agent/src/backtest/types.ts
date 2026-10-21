import { z } from "zod";
import { normalizeName } from "../text/normalize.js";
import { CHANNEL_ID, VIDEO_ID } from "../youtube/schemas.js";
import { IsoInstant } from "./eligibility.js";
import type { BootstrapInterval } from "./stats.js";

// YouTube handles are 3 to 30 letters, digits, dots, hyphens or underscores.
const HANDLE = /^@[A-Za-z0-9._-]{3,30}$/;
const Count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Finite = z.number().refine(Number.isFinite, "must be a finite number");

/**
 * One show in docs/backtest-shows.json. The channel id and handle are both
 * set or both null; null means no official channel could be pinned under
 * the evidence rule, and the reason is in `evidenceUrl`. The channel id is
 * checked with the same pattern the YouTube client uses before any request.
 * `titleMustContain` is set only for channels shared with other shows: an
 * upload counts for the show only if its normalised title contains this
 * text, normalised the same way (change log, refinement 3).
 */
export const ShowConfigSchema = z
  .object({
    name: z.string().min(1).max(300),
    youtubeChannelId: z.string().regex(CHANNEL_ID).nullable(),
    youtubeHandle: z.string().regex(HANDLE).nullable(),
    titleMustContain: z
      .string()
      .max(300)
      .refine((text) => normalizeName(text) !== "", "must not be empty after normalising")
      .optional(),
    evidenceUrl: z.string().min(1).max(1_000),
    checkedOn: z.iso.date(),
  })
  .strict()
  .refine((show) => (show.youtubeChannelId === null) === (show.youtubeHandle === null), {
    message: "youtubeChannelId and youtubeHandle must both be set or both be null",
  });

/** The whole pinned show list: names unique after normalizeName, channel ids unique. */
export const ShowListSchema = z
  .array(ShowConfigSchema)
  .min(1)
  .max(100)
  .superRefine((shows, ctx) => {
    const names = new Set<string>();
    const channels = new Set<string>();
    for (const [index, show] of shows.entries()) {
      const name = normalizeName(show.name);
      if (names.has(name)) ctx.addIssue({ code: "custom", message: "duplicate show name", path: [index, "name"] });
      names.add(name);
      if (show.youtubeChannelId === null) continue;
      if (channels.has(show.youtubeChannelId)) {
        ctx.addIssue({ code: "custom", message: "duplicate channel id", path: [index, "youtubeChannelId"] });
      }
      channels.add(show.youtubeChannelId);
    }
  });

export type ShowConfig = z.infer<typeof ShowConfigSchema>;

/** An upload with public stats, before any guest work. */
export type Episode = {
  videoId: string;
  title: string;
  publishedAt: string;
  views: number;
  durationSec: number | null;
};

// One counter per exclusion the pre-registration names. Keys starting with
// "show" count shows; the rest count episodes.
export const DropCountsSchema = z
  .object({
    notThisShow: Count,
    notInWindow: Count,
    tooShort: Count,
    hiddenViews: Count,
    extractFailed: Count,
    noSingleGuest: Count,
    nameNotInTitle: Count,
    guestNotResolved: Count,
    noFitScore: Count,
    noFame: Count,
    showNoChannel: Count,
    showNoPodcastMatch: Count,
    showAmbiguousPodcast: Count,
    showTooFewEpisodes: Count,
  })
  .strict();
export type DropCounts = z.infer<typeof DropCountsSchema>;

export const DatasetRowSchema = z
  .object({
    showName: z.string().min(1).max(300),
    videoId: z.string().regex(VIDEO_ID),
    title: z.string().max(1_000),
    publishedAt: IsoInstant,
    // At least 1, because adjusted views take log(age).
    ageDays: z.number().int().min(1).max(100_000),
    views: Count,
    guestName: z.string().min(1).max(300),
    personId: z.string().min(1).max(200),
    fit: Finite,
    fame: Finite,
  })
  .strict();
export type DatasetRow = z.infer<typeof DatasetRowSchema>;

export const SHOW_STATUSES = ["kept", "noChannel", "noPodcastMatch", "ambiguousPodcast", "tooFewEpisodes"] as const;

export const ShowOutcomeSchema = z
  .object({
    name: z.string().min(1).max(300),
    youtubeChannelId: z.string().regex(CHANNEL_ID).nullable(),
    podcastId: z.string().min(1).max(200).nullable(),
    status: z.enum(SHOW_STATUSES),
    uploadsRead: Count,
    eligibleEpisodes: Count,
    resolvedGuests: Count,
    rows: Count,
    // The upload cap was hit while the oldest upload read was still on or
    // after the window's first day, so earlier episodes were never seen
    // (change log, refinement 4). The show stays in.
    cutShort: z.boolean(),
  })
  .strict();
export type ShowOutcome = z.infer<typeof ShowOutcomeSchema>;

/**
 * Everything the analysis reads, as stored after the data pull. It holds
 * Qloo ids and scores, so a stored copy belongs in a git-ignored folder
 * (threat model C7.3).
 */
export const DatasetSchema = z
  .object({
    builtAt: IsoInstant,
    shows: z.array(ShowOutcomeSchema).max(100),
    rows: z.array(DatasetRowSchema).max(250_000),
    drops: DropCountsSchema,
  })
  .strict();
export type Dataset = z.infer<typeof DatasetSchema>;

export type Decision = "supported" | "not supported" | "insufficient data";

export type HypothesisResult = {
  pooledRho: number | null;
  interval: BootstrapInterval | null;
  decision: Decision;
};

export type ShowResult = {
  name: string;
  n: number;
  cutShort: boolean;
  rhoFitViews: number | null;
  partialRhoFitViewsGivenFame: number | null;
};

export type BacktestResult = {
  status: "analysed" | "insufficient data";
  sample: { shows: number; episodes: number };
  shows: ShowResult[];
  h1: HypothesisResult;
  h2: HypothesisResult;
  descriptive: { medianAdjustedViewRatioTopToBottomFitQuintile: number | null };
  drops: DropCounts;
  showOutcomes: ShowOutcome[];
  bootstrap: { iterations: number; seed: number };
  datasetBuiltAt: string;
  method: string[];
};
