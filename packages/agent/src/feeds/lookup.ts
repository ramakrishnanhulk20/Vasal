import { z } from "zod";
import { safeFetch } from "../net/safe-fetch.js";
import { FeedError } from "./errors.js";

export type ShowCandidate = {
  appleId: string;
  name: string;
  publisher: string;
  feedUrl: URL | null;
  genre: string | null;
};

export type LookupOptions = { fetchImpl?: typeof safeFetch };

const SEARCH_ENDPOINT = "https://itunes.apple.com/search";
const LOOKUP_ENDPOINT = "https://itunes.apple.com/lookup";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RESULTS = 5;
const MAX_TERM_CHARS = 300;
const APPLE_ID = /^\d{3,12}$/;

const responseSchema = z.object({ results: z.array(z.unknown()) });

// Podcasters register their own names and feed URLs with Apple, so every
// field is treated as untrusted and bounded before anything downstream sees it.
const resultSchema = z.object({
  kind: z.literal("podcast"),
  collectionId: z.number().int().positive().max(999_999_999_999),
  collectionName: z.string().min(1).max(500),
  artistName: z.string().max(500).optional(),
  feedUrl: z.string().max(2048).optional(),
  primaryGenreName: z.string().max(200).optional(),
});

function httpUrlOrNull(raw: string | undefined): URL | null {
  if (raw === undefined) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function toCandidate(raw: unknown): ShowCandidate[] {
  const parsed = resultSchema.safeParse(raw);
  if (!parsed.success) return [];
  const result = parsed.data;
  return [
    {
      appleId: String(result.collectionId),
      name: result.collectionName,
      publisher: result.artistName ?? "",
      feedUrl: httpUrlOrNull(result.feedUrl),
      genre: result.primaryGenreName ?? null,
    },
  ];
}

async function fetchCandidates(url: URL, fetchImpl: typeof safeFetch): Promise<ShowCandidate[]> {
  let body: string;
  try {
    ({ body } = await fetchImpl(url, { maxBytes: MAX_RESPONSE_BYTES, accept: "application/json" }));
  } catch {
    throw new FeedError("LOOKUP_FAILED");
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new FeedError("LOOKUP_FAILED");
  }
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) throw new FeedError("LOOKUP_FAILED");
  return parsed.data.results.slice(0, MAX_RESULTS).flatMap(toCandidate);
}

/**
 * Searches Apple's podcast directory by show name and returns up to 5
 * candidates. The term travels only as one URLSearchParams value, so `&` or
 * `#` in it cannot add or cut parameters (C2.3). Entries that fail the schema
 * are dropped; a feed URL that is not http or https becomes null.
 *
 * Throws FeedError FEED_BAD_INPUT for an empty term or one over 300
 * characters (no request is made), and LOOKUP_FAILED for any network, status,
 * JSON or schema failure.
 */
export async function searchShows(term: string, opts: LookupOptions = {}): Promise<ShowCandidate[]> {
  const text = term.normalize("NFC").trim();
  if (text.length === 0 || [...text].length > MAX_TERM_CHARS) throw new FeedError("FEED_BAD_INPUT");
  const url = new URL(SEARCH_ENDPOINT);
  url.search = new URLSearchParams({
    media: "podcast",
    entity: "podcast",
    term: text,
    limit: String(MAX_RESULTS),
  }).toString();
  return fetchCandidates(url, opts.fetchImpl ?? safeFetch);
}

/**
 * Looks one show up by its Apple id. Returns null when Apple has no podcast
 * with exactly that id.
 *
 * Throws FeedError FEED_BAD_INPUT unless the id is 3 to 12 digits (no request
 * is made), and LOOKUP_FAILED for any network, status, JSON or schema failure.
 */
export async function lookupShow(appleId: string, opts: LookupOptions = {}): Promise<ShowCandidate | null> {
  if (!APPLE_ID.test(appleId)) throw new FeedError("FEED_BAD_INPUT");
  const url = new URL(LOOKUP_ENDPOINT);
  url.search = new URLSearchParams({ id: appleId, entity: "podcast" }).toString();
  const candidates = await fetchCandidates(url, opts.fetchImpl ?? safeFetch);
  return candidates.find((candidate) => candidate.appleId === appleId) ?? null;
}
