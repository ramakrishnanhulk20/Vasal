import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { isoDurationSeconds } from "./duration.js";
import { YouTubeError, type YouTubeErrorCode } from "./errors.js";
import {
  CHANNEL_ID,
  PLAYLIST_ID,
  VIDEO_ID,
  parseChannelsResponse,
  parsePlaylistItemsResponse,
  parseVideosResponse,
} from "./schemas.js";

export type YouTubeClientOptions = {
  apiKey: string;
  reserveUnits: (units: number) => Promise<boolean>; // the budget meter; called before every request
  fetchImpl?: typeof fetch;
  timeoutMs?: number; // default 15000
  maxRetries?: number; // default 2, on 5xx only
  sleep?: (ms: number) => Promise<void>;
};

export type VideoRef = { videoId: string; title: string; publishedAt: string | null };

export type VideoStats = {
  videoId: string;
  channelId: string;
  title: string;
  publishedAt: string;
  viewCount: number;
  durationSec: number | null;
};

export type YouTubeClient = {
  /**
   * Reads a channel's title and the id of its uploads playlist. One request.
   * Throws YT_BAD_INPUT unless `channelId` matches /^UC[A-Za-z0-9_-]{22}$/,
   * and YT_NOT_FOUND when YouTube returns no channel with exactly that id.
   */
  channelUploads(channelId: string): Promise<{ channelTitle: string; uploadsPlaylistId: string }>;
  /**
   * Lists a playlist's videos in YouTube's order, 50 per request, until
   * `maxItems` (default 500, at most 2000) are read, there is no next page, or
   * 40 pages have been read, whichever comes first. Throws YT_BAD_INPUT for a
   * playlist id outside /^[A-Za-z0-9_-]{10,64}$/ or a `maxItems` that is not
   * an integer from 1 to 2000.
   */
  listUploads(playlistId: string, opts?: { maxItems?: number }): Promise<VideoRef[]>;
  /**
   * Reads title, publish time, channel, view count and duration for up to
   * 2000 videos, in requests of at most 50 ids. Duplicate ids are asked for
   * once. Videos YouTube does not return (deleted or private) and videos whose
   * view count is hidden are left out, never reported as 0. Throws
   * YT_BAD_INPUT if any id is outside /^[A-Za-z0-9_-]{11}$/ or there are more
   * than 2000, and YT_SCHEMA if YouTube returns an id that was not asked for.
   */
  videoStats(videoIds: string[]): Promise<VideoStats[]>;
};

const BASE_URL = "https://www.googleapis.com/youtube/v3/";
// The search endpoint is absent on purpose. It costs 100 units a call where
// these cost 1, and the backtest reads pinned channel ids, never searches (C8.5).
type Endpoint = "channels" | "playlistItems" | "videos";

const UNITS_PER_REQUEST = 1;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;
const MAX_RETRIES_LIMIT = 5;
const BACKOFF_MS = [500, 1_500] as const;
// A full page of 50 videos with long descriptions is well under 1 MiB. A body
// past 2 MiB is refused rather than buffered.
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const PAGE_SIZE = 50;
const DEFAULT_MAX_ITEMS = 500;
const MAX_ITEMS_LIMIT = 2_000;
const MAX_PAGES = 40;
const IDS_PER_REQUEST = 50;
// The most ids listUploads can return, which keeps one videoStats call to at
// most 40 requests.
const MAX_VIDEO_IDS = MAX_ITEMS_LIMIT;

const PRINTABLE_ASCII = /^[\x21-\x7E]+$/;

const QUOTA_REASONS: ReadonlySet<string> = new Set(["quotaExceeded", "dailyLimitExceeded"]);
const ERROR_INFO_TYPE = "type.googleapis.com/google.rpc.ErrorInfo";

const ErrorBody = z
  .object({
    error: z
      .object({
        errors: z.array(z.unknown()).optional(),
        details: z.array(z.unknown()).optional(),
      })
      .passthrough(),
  })
  .passthrough();
const ReasonEntry = z.object({ reason: z.string() }).passthrough();
const ErrorInfoEntry = z.object({ "@type": z.literal(ERROR_INFO_TYPE), reason: z.string() }).passthrough();

type Reasons = { first: string | undefined; apiKeyInvalid: boolean };

// Only machine-readable reason fields are read, and only to choose a code.
// Nothing from the body is kept, returned or copied into an error (C3.6).
// The YouTube docs name `keyInvalid` in errors[0].reason, but Google's
// gateway was seen on 19 Oct 2026 to answer a bad key with `badRequest`
// there and put API_KEY_INVALID in an ErrorInfo detail, so both are read.
function readReasons(body: string | undefined): Reasons {
  const none: Reasons = { first: undefined, apiKeyInvalid: false };
  if (body === undefined) return none;
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return none;
  }
  const parsed = ErrorBody.safeParse(json);
  if (!parsed.success) return none;

  const first = ReasonEntry.safeParse(parsed.data.error.errors?.[0]);
  const apiKeyInvalid = (parsed.data.error.details ?? []).some((detail) => {
    const info = ErrorInfoEntry.safeParse(detail);
    return info.success && info.data.reason === "API_KEY_INVALID";
  });
  return { first: first.success ? first.data.reason : undefined, apiKeyInvalid };
}

function codeForFailure(status: number, body: string | undefined): YouTubeErrorCode {
  if (status === 401) return "YT_AUTH";
  if (status === 404) return "YT_NOT_FOUND";
  if (status === 403) {
    const { first } = readReasons(body);
    return first !== undefined && QUOTA_REASONS.has(first) ? "YT_QUOTA" : "YT_AUTH";
  }
  if (status === 400) {
    const { first, apiKeyInvalid } = readReasons(body);
    return first === "keyInvalid" || apiKeyInvalid ? "YT_AUTH" : "YT_UPSTREAM";
  }
  return "YT_UPSTREAM";
}

async function readBodyCapped(response: Response): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  const parts: string[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new YouTubeError("YT_UPSTREAM");
    }
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join("");
}

const isId = (pattern: RegExp, value: unknown): value is string => typeof value === "string" && pattern.test(value);

/**
 * Creates the one client that reads the YouTube Data API v3.
 *
 * It calls only channels.list, playlistItems.list and videos.list, by GET,
 * with every query built by URLSearchParams from checked ids (C2.3). The key
 * travels only in the X-goog-api-key header, so no URL a caller logs or
 * stores can carry it (C4.3). Redirects are refused, because fetch would
 * forward that header to wherever a redirect points.
 *
 * Before every request, including each page and each retry, it calls
 * `reserveUnits(1)`. Unless that resolves to exactly true, it throws
 * YT_BUDGET_REFUSED and sends nothing (C5.1). Each attempt has its own
 * timeout (default 15 s) and a 2 MiB body cap. Only 5xx answers are retried,
 * at most `maxRetries` times (default 2), after 500 ms and then 1500 ms.
 *
 * Throws YouTubeError("YT_KEY_MISSING") for a blank key, and
 * YouTubeError("YT_BAD_INPUT") for a key with spaces or non-ASCII characters,
 * a missing meter, or limits that are not positive integers.
 */
export function createYouTubeClient(opts: YouTubeClientOptions): YouTubeClient {
  if (typeof opts.apiKey !== "string" || opts.apiKey.trim() === "") throw new YouTubeError("YT_KEY_MISSING");
  if (!PRINTABLE_ASCII.test(opts.apiKey)) throw new YouTubeError("YT_BAD_INPUT");
  if (typeof opts.reserveUnits !== "function") throw new YouTubeError("YT_BAD_INPUT");

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const sleep = opts.sleep ?? ((ms: number) => delay(ms));
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new YouTubeError("YT_BAD_INPUT");
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > MAX_RETRIES_LIMIT) {
    throw new YouTubeError("YT_BAD_INPUT");
  }

  const headers = { Accept: "application/json", "X-goog-api-key": opts.apiKey };

  // A meter that throws or answers anything but true counts as a refusal, so
  // an unreadable budget never lets a request through (C5.7).
  async function reserveOrRefuse(): Promise<void> {
    let granted: unknown = false;
    try {
      granted = await opts.reserveUnits(UNITS_PER_REQUEST);
    } catch {
      granted = false;
    }
    if (granted !== true) throw new YouTubeError("YT_BUDGET_REFUSED");
  }

  // One attempt, body included, under one timeout. The underlying error is
  // dropped because fetch errors can quote the request and its headers.
  async function attempt(url: URL): Promise<{ ok: boolean; status: number; body: string | undefined }> {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetchImpl(url, { method: "GET", headers, redirect: "error", signal });
      const reasonMatters = response.status === 400 || response.status === 403;
      if (!response.ok && !reasonMatters) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, status: response.status, body: undefined };
      }
      return { ok: response.ok, status: response.status, body: await readBodyCapped(response) };
    } catch (err) {
      if (err instanceof YouTubeError) throw err;
      throw new YouTubeError(signal.aborted ? "YT_TIMEOUT" : "YT_UPSTREAM");
    }
  }

  async function getJson(endpoint: Endpoint, params: Array<[string, string]>): Promise<unknown> {
    const url = new URL(endpoint, BASE_URL);
    url.search = new URLSearchParams(params).toString();

    for (let retriesUsed = 0; ; retriesUsed += 1) {
      await reserveOrRefuse();
      const outcome = await attempt(url);
      if (outcome.ok) {
        try {
          return JSON.parse(outcome.body ?? "");
        } catch {
          throw new YouTubeError("YT_SCHEMA");
        }
      }
      if (outcome.status >= 500 && outcome.status <= 599 && retriesUsed < maxRetries) {
        await sleep(BACKOFF_MS[Math.min(retriesUsed, BACKOFF_MS.length - 1)] ?? BACKOFF_MS[1]);
        continue;
      }
      throw new YouTubeError(codeForFailure(outcome.status, outcome.body));
    }
  }

  return {
    async channelUploads(channelId) {
      if (!isId(CHANNEL_ID, channelId)) throw new YouTubeError("YT_BAD_INPUT");
      const response = parseChannelsResponse(
        await getJson("channels", [
          ["part", "snippet,contentDetails"],
          ["id", channelId],
        ]),
      );
      const channel = response.items.find((item) => item.id === channelId);
      if (channel === undefined) throw new YouTubeError("YT_NOT_FOUND");
      return { channelTitle: channel.snippet.title, uploadsPlaylistId: channel.contentDetails.relatedPlaylists.uploads };
    },

    async listUploads(playlistId, listOpts = {}) {
      if (!isId(PLAYLIST_ID, playlistId)) throw new YouTubeError("YT_BAD_INPUT");
      const maxItems = listOpts.maxItems ?? DEFAULT_MAX_ITEMS;
      if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > MAX_ITEMS_LIMIT) {
        throw new YouTubeError("YT_BAD_INPUT");
      }

      const refs: VideoRef[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_PAGES && refs.length < maxItems; page += 1) {
        const params: Array<[string, string]> = [
          ["part", "snippet,contentDetails"],
          ["playlistId", playlistId],
          ["maxResults", String(PAGE_SIZE)],
        ];
        if (pageToken !== undefined) params.push(["pageToken", pageToken]);

        const response = parsePlaylistItemsResponse(await getJson("playlistItems", params));
        for (const item of response.items) {
          refs.push({
            videoId: item.contentDetails.videoId,
            title: item.snippet.title,
            publishedAt: item.contentDetails.videoPublishedAt ?? null,
          });
        }
        if (response.nextPageToken === undefined || response.nextPageToken === pageToken) break;
        pageToken = response.nextPageToken;
      }
      return refs.slice(0, maxItems);
    },

    async videoStats(videoIds) {
      if (!Array.isArray(videoIds) || videoIds.length > MAX_VIDEO_IDS) throw new YouTubeError("YT_BAD_INPUT");
      // for...of visits holes in a sparse array as undefined, so they fail the check.
      for (const id of videoIds) {
        if (!isId(VIDEO_ID, id)) throw new YouTubeError("YT_BAD_INPUT");
      }

      const unique = [...new Set(videoIds)];
      const stats: VideoStats[] = [];
      for (let start = 0; start < unique.length; start += IDS_PER_REQUEST) {
        const batch = unique.slice(start, start + IDS_PER_REQUEST);
        const awaited = new Set(batch);
        const response = parseVideosResponse(
          await getJson("videos", [
            ["part", "snippet,statistics,contentDetails"],
            ["id", batch.join(",")],
          ]),
        );
        for (const item of response.items) {
          // Each id asked for may come back once. Anything else means the
          // answer is not the one requested.
          if (!awaited.delete(item.id)) throw new YouTubeError("YT_SCHEMA");
          const viewCount = item.statistics?.viewCount;
          if (viewCount === undefined) continue;
          stats.push({
            videoId: item.id,
            channelId: item.snippet.channelId,
            title: item.snippet.title,
            publishedAt: item.snippet.publishedAt,
            viewCount,
            durationSec: isoDurationSeconds(item.contentDetails.duration),
          });
        }
      }
      return stats;
    },
  };
}
