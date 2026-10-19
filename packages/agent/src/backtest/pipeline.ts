import { normalizeName } from "../text/normalize.js";
import {
  isBeforeWindow,
  isFullLength,
  isInWindow,
  nameAppearsInTitle,
  pickPodcastMatch,
  WINDOW_END_EXCLUSIVE_MS,
} from "./eligibility.js";
import { DatasetSchema, type Dataset, type DatasetRow, type DropCounts, type Episode, type ShowConfig, type ShowOutcome } from "./types.js";

// The most the YouTube client reads from one playlist (40 pages of 50).
export const MAX_UPLOADS_PER_CHANNEL = 2_000;
// The pre-registration's batch limit for /v2/insights with filter.results.entities.
export const FIT_BATCH_SIZE = 25;
export const MIN_EPISODES_PER_SHOW = 30;
const DAY_MS = 86_400_000;
const MAX_ID_LENGTH = 200;
// YouTube titles are at most 100 characters, so a longer "name" can only
// look like it is in the title because invisible characters were stripped.
const MAX_GUEST_NAME_LENGTH = 300;

export type FitScore = { affinity: number; popularity: number | null };

export type PipelineDeps = {
  youtube: {
    channelUploads(id: string): Promise<{ channelTitle: string; uploadsPlaylistId: string }>;
    listUploads(id: string, o?: { maxItems?: number }): Promise<Array<{ videoId: string; title: string; publishedAt: string | null }>>;
    videoStats(ids: string[]): Promise<
      Array<{ videoId: string; channelId: string; title: string; publishedAt: string; viewCount: number; durationSec: number | null }>
    >;
  };
  findPodcasts(showName: string): Promise<Array<{ id: string; name: string }>>; // Qloo search candidates
  extractGuest(title: string): Promise<{ kind: "one"; name: string } | { kind: "none" } | { kind: "several" }>;
  // Qloo search top result. Its popularity is not used: fame comes from the
  // same insights response as the fit score (change log, refinement 4).
  resolvePerson(name: string): Promise<{ id: string; name: string; popularity: number } | null>;
  // Qloo affinity and popularity percentile from one /v2/insights response,
  // called in batches of at most 25 by the pipeline.
  fitScores(podcastId: string, personIds: string[]): Promise<Map<string, FitScore>>;
  now: () => Date;
};

type Person = { id: string; name: string };
type NamedEpisode = { episode: Episode; guestName: string };
type ResolvedEpisode = NamedEpisode & { person: Person };

function emptyDrops(): DropCounts {
  return {
    notThisShow: 0,
    notInWindow: 0,
    tooShort: 0,
    hiddenViews: 0,
    noSingleGuest: 0,
    nameNotInTitle: 0,
    guestNotResolved: 0,
    noFitScore: 0,
    noFame: 0,
    showNoChannel: 0,
    showNoPodcastMatch: 0,
    showAmbiguousPodcast: 0,
    showTooFewEpisodes: 0,
  };
}

const isUsableId = (id: unknown): id is string => typeof id === "string" && id !== "" && id.length <= MAX_ID_LENGTH;
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

// Qloo's answers are checked like any input before they are trusted. A
// person without a usable id is unresolved. A score without a finite
// affinity is no score; a popularity that is not a finite number is
// treated as missing, so that row is dropped as noFame, never guessed.
function asPerson(value: unknown): Person | null {
  if (typeof value !== "object" || value === null) return null;
  const { id, name } = value as Record<string, unknown>;
  return isUsableId(id) && typeof name === "string" ? { id, name } : null;
}

function asScore(value: unknown): FitScore | null {
  if (typeof value !== "object" || value === null) return null;
  const { affinity, popularity } = value as Record<string, unknown>;
  if (!isFiniteNumber(affinity)) return null;
  return { affinity, popularity: isFiniteNumber(popularity) ? popularity : null };
}

/**
 * Builds the backtest dataset from the pinned show list, applying the
 * pre-registration's rules, change log included, in its order and counting
 * every drop by reason.
 *
 * Per show: a null channel drops it (showNoChannel). The Qloo podcast is
 * chosen by `pickPodcastMatch`, exact names first; no match drops the show
 * (showNoPodcastMatch) and more than one podcast in the winning tier drops
 * it (showAmbiguousPodcast), so one is never picked. Then up to 2000
 * uploads of the pinned channel are read through the uploads playlist; the
 * pipeline has no search method and never searches (C8.5). If the 2000 cap
 * was reached and no upload read is known to predate 2024-10-01, the show
 * is marked cutShort and stays in.
 *
 * Per upload, in order: on a shared channel, a title that does not contain
 * the show's `titleMustContain` after normalizeName (notThisShow); no public
 * stats (hiddenViews); outside the window (notInWindow); under 20 minutes
 * or of unknown length (tooShort); not exactly one guest (noSingleGuest);
 * the name not in the title (nameNotInTitle, C9.1); no Qloo person whose
 * normalised name equals the extracted one (guestNotResolved); no fit score
 * (noFitScore); no popularity in that same response (noFame). A show is
 * kept only with at least 30 eligible episodes, then at least 30 resolved
 * guests, then at least 30 rows; failing any is one showTooFewEpisodes,
 * and later stages are not run for it, so their episode counts do not
 * include it.
 *
 * Fit and fame are asked for in batches of at most 25 person ids. Person
 * lookups are made once per distinct extracted name. ageDays is whole days
 * from publishedAt to now().
 *
 * Throws RangeError when now() is not at least a day after the window ends,
 * because ages would be zero or negative. Throws Error when YouTube returns
 * a video that was not asked for or that belongs to another channel. Any
 * error from a dependency is passed through, so a failed call stops the
 * build instead of silently shrinking the sample.
 */
export async function buildDataset(shows: ShowConfig[], deps: PipelineDeps): Promise<Dataset> {
  const now = deps.now();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs) || nowMs < WINDOW_END_EXCLUSIVE_MS + DAY_MS) {
    throw new RangeError("the backtest can only be built at least one day after the episode window ends");
  }

  const drops = emptyDrops();
  const outcomes: ShowOutcome[] = [];
  const rows: DatasetRow[] = [];
  const people = new Map<string, Person | null>();

  const resolveOnce = async (name: string): Promise<Person | null> => {
    const known = people.get(name);
    if (known !== undefined) return known;
    const person = asPerson(await deps.resolvePerson(name));
    const matched = person !== null && normalizeName(person.name) === normalizeName(name) ? person : null;
    people.set(name, matched);
    return matched;
  };

  for (const show of shows) {
    const outcome: ShowOutcome = {
      name: show.name,
      youtubeChannelId: show.youtubeChannelId,
      podcastId: null,
      status: "kept",
      uploadsRead: 0,
      eligibleEpisodes: 0,
      resolvedGuests: 0,
      rows: 0,
      cutShort: false,
    };
    outcomes.push(outcome);
    const tooFew = () => {
      drops.showTooFewEpisodes += 1;
      outcome.status = "tooFewEpisodes";
    };

    const channelId = show.youtubeChannelId;
    if (channelId === null) {
      drops.showNoChannel += 1;
      outcome.status = "noChannel";
      continue;
    }

    const candidates = (await deps.findPodcasts(show.name)).filter(
      (candidate) => isUsableId(candidate.id) && typeof candidate.name === "string",
    );
    const pick = pickPodcastMatch(show.name, candidates);
    if (pick.kind === "ambiguous") {
      drops.showAmbiguousPodcast += 1;
      outcome.status = "ambiguousPodcast";
      continue;
    }
    if (pick.kind === "none") {
      drops.showNoPodcastMatch += 1;
      outcome.status = "noPodcastMatch";
      continue;
    }
    const podcastId = pick.id;
    outcome.podcastId = podcastId;

    const channel = await deps.youtube.channelUploads(channelId);
    const uploads = await deps.youtube.listUploads(channel.uploadsPlaylistId, { maxItems: MAX_UPLOADS_PER_CHANNEL });
    const listed = new Map<string, { title: string; publishedAt: string | null }>();
    for (const upload of uploads) if (!listed.has(upload.videoId)) listed.set(upload.videoId, upload);
    const uploadIds = [...listed.keys()].slice(0, MAX_UPLOADS_PER_CHANNEL);
    outcome.uploadsRead = uploadIds.length;

    const asked = new Set(uploadIds);
    const statsById = new Map<string, Episode>();
    for (const stats of uploadIds.length === 0 ? [] : await deps.youtube.videoStats(uploadIds)) {
      if (!asked.has(stats.videoId) || statsById.has(stats.videoId)) {
        throw new Error("YouTube returned a video that was not asked for");
      }
      if (stats.channelId !== channelId) throw new Error("YouTube returned a video from another channel");
      statsById.set(stats.videoId, {
        videoId: stats.videoId,
        title: stats.title,
        publishedAt: stats.publishedAt,
        views: stats.viewCount,
        durationSec: stats.durationSec,
      });
    }

    // Uploads come newest first, so a capped list that never reaches back
    // before the window may have missed episodes inside it. A date that is
    // unknown cannot prove otherwise, so it leaves the flag on.
    const reachedBeforeWindow = uploadIds.some((id) =>
      isBeforeWindow(statsById.get(id)?.publishedAt ?? listed.get(id)?.publishedAt ?? null),
    );
    outcome.cutShort = uploads.length >= MAX_UPLOADS_PER_CHANNEL && !reachedBeforeWindow;

    const mustContain = show.titleMustContain === undefined ? null : normalizeName(show.titleMustContain);
    const named: NamedEpisode[] = [];
    for (const videoId of uploadIds) {
      const episode = statsById.get(videoId);
      // The stats title is the one stored with the row, so it decides when
      // there is one; a hidden video only has its playlist title.
      const title = episode?.title ?? listed.get(videoId)?.title ?? "";
      if (mustContain !== null && !normalizeName(title).includes(mustContain)) {
        drops.notThisShow += 1;
        continue;
      }
      if (episode === undefined) {
        drops.hiddenViews += 1;
        continue;
      }
      if (!isInWindow(episode.publishedAt)) {
        drops.notInWindow += 1;
        continue;
      }
      if (!isFullLength(episode.durationSec)) {
        drops.tooShort += 1;
        continue;
      }
      const guest = await deps.extractGuest(episode.title);
      if (guest.kind !== "one" || typeof guest.name !== "string") {
        drops.noSingleGuest += 1;
        continue;
      }
      if (guest.name.length > MAX_GUEST_NAME_LENGTH || !nameAppearsInTitle(guest.name, episode.title)) {
        drops.nameNotInTitle += 1;
        continue;
      }
      named.push({ episode, guestName: guest.name });
    }
    outcome.eligibleEpisodes = named.length;
    if (named.length < MIN_EPISODES_PER_SHOW) {
      tooFew();
      continue;
    }

    const resolved: ResolvedEpisode[] = [];
    for (const item of named) {
      const person = await resolveOnce(item.guestName);
      if (person === null) {
        drops.guestNotResolved += 1;
        continue;
      }
      resolved.push({ ...item, person });
    }
    outcome.resolvedGuests = resolved.length;
    if (resolved.length < MIN_EPISODES_PER_SHOW) {
      tooFew();
      continue;
    }

    const personIds = [...new Set(resolved.map((item) => item.person.id))];
    const scoreById = new Map<string, FitScore>();
    for (let start = 0; start < personIds.length; start += FIT_BATCH_SIZE) {
      const batch = personIds.slice(start, start + FIT_BATCH_SIZE);
      const scores = await deps.fitScores(podcastId, batch);
      // Only ids that were asked for are read back.
      for (const id of batch) {
        const score = asScore(scores.get(id));
        if (score !== null) scoreById.set(id, score);
      }
    }

    const showRows: DatasetRow[] = [];
    for (const { episode, guestName, person } of resolved) {
      const score = scoreById.get(person.id);
      if (score === undefined) {
        drops.noFitScore += 1;
        continue;
      }
      if (score.popularity === null) {
        drops.noFame += 1;
        continue;
      }
      showRows.push({
        showName: show.name,
        videoId: episode.videoId,
        title: episode.title,
        publishedAt: episode.publishedAt,
        ageDays: Math.floor((nowMs - Date.parse(episode.publishedAt)) / DAY_MS),
        views: episode.views,
        guestName,
        personId: person.id,
        fit: score.affinity,
        fame: score.popularity,
      });
    }
    outcome.rows = showRows.length;
    if (showRows.length < MIN_EPISODES_PER_SHOW) {
      tooFew();
      continue;
    }
    rows.push(...showRows);
  }

  // The stored dataset is the input of the published analysis (C9.3), so it
  // must pass the same schema the analysis reads it back with.
  return DatasetSchema.parse({ builtAt: now.toISOString(), shows: outcomes, rows, drops });
}
