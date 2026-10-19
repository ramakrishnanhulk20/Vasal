import { z } from "zod";
import { YouTubeError } from "./errors.js";

// One predicate per id kind, used both to check ids before a request and to
// check ids that come back in a response, so the two sides can never be
// judged by different rules.
export const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
export const PLAYLIST_ID = /^[A-Za-z0-9_-]{10,64}$/;
export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

// YouTube caps titles at 100 characters. The far higher cap here only stops
// an absurd value from reaching the store or the model.
const Title = z.string().max(1_000);
const Instant = z.iso.datetime({ offset: true });

// The token is sent back as one URLSearchParams value, so it cannot inject a
// parameter. It is bounded to printable ASCII so a hostile value cannot grow
// the next request without limit.
const PageToken = z.string().regex(/^[\x21-\x7E]{1,256}$/);

// Digits only, at most 16 of them, and inside the safe integer range, so the
// number used is exactly the number YouTube sent.
const ViewCount = z
  .string()
  .regex(/^[0-9]{1,16}$/)
  .transform(Number)
  .pipe(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER));

// Objects pass unknown keys through so new YouTube fields do not break
// parsing. YouTube leaves `items` out entirely when nothing matches, so a
// missing list reads as empty.
const ChannelsSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.string().regex(CHANNEL_ID),
            snippet: z.object({ title: Title }).passthrough(),
            contentDetails: z
              .object({
                relatedPlaylists: z.object({ uploads: z.string().regex(PLAYLIST_ID) }).passthrough(),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

const PlaylistItemsSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            snippet: z.object({ title: Title }).passthrough(),
            contentDetails: z
              .object({
                videoId: z.string().regex(VIDEO_ID),
                videoPublishedAt: Instant.optional(),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .default([]),
    nextPageToken: PageToken.optional(),
  })
  .passthrough();

const VideosSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.string().regex(VIDEO_ID),
            snippet: z
              .object({
                title: Title,
                publishedAt: Instant,
                channelId: z.string().regex(CHANNEL_ID),
              })
              .passthrough(),
            // A channel can hide its counts; then viewCount is absent and the
            // caller drops the video rather than read it as 0.
            statistics: z.object({ viewCount: ViewCount.optional() }).passthrough().optional(),
            contentDetails: z.object({ duration: z.string() }).passthrough(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

export type ChannelsResponse = z.output<typeof ChannelsSchema>;
export type PlaylistItemsResponse = z.output<typeof PlaylistItemsSchema>;
export type VideosResponse = z.output<typeof VideosSchema>;

function parseWith<S extends z.ZodType>(schema: S, json: unknown): z.output<S> {
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new YouTubeError("YT_SCHEMA");
  return parsed.data;
}

/**
 * Checks a decoded channels.list body: each item's channel id, title and
 * uploads playlist id. Throws YouTubeError("YT_SCHEMA") on any mismatch; the
 * error never carries the body.
 */
export function parseChannelsResponse(json: unknown): ChannelsResponse {
  return parseWith(ChannelsSchema, json);
}

/**
 * Checks a decoded playlistItems.list body: each item's video id, title and
 * optional publish time, plus the optional next page token. Throws
 * YouTubeError("YT_SCHEMA") on any mismatch; the error never carries the body.
 */
export function parsePlaylistItemsResponse(json: unknown): PlaylistItemsResponse {
  return parseWith(PlaylistItemsSchema, json);
}

/**
 * Checks a decoded videos.list body: each item's id, title, publish time,
 * channel id, duration text and optional view count, which comes back as a
 * number. Throws YouTubeError("YT_SCHEMA") on any mismatch, including a view
 * count that is not a plain non-negative safe integer; the error never
 * carries the body.
 */
export function parseVideosResponse(json: unknown): VideosResponse {
  return parseWith(VideosSchema, json);
}
