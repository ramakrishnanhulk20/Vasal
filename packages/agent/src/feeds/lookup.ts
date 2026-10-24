import { setTimeout as delay } from "node:timers/promises";
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

/** Hands out places for Apple directory requests; take() resolves false when none frees in time. */
export type DirectoryLimiter = { take(): Promise<boolean> };

/** `limiter` is for tests; every other caller leaves it out and shares the process's one limiter. */
export type LookupOptions = { fetchImpl?: typeof safeFetch; limiter?: DirectoryLimiter };

const SEARCH_ENDPOINT = "https://itunes.apple.com/search";
const LOOKUP_ENDPOINT = "https://itunes.apple.com/lookup";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RESULTS = 5;
const MAX_TERM_CHARS = 300;
const APPLE_ID = /^\d{3,12}$/;
// Apple documents roughly 20 calls a minute for the Search API, and going
// over gets the server's one address throttled for the website and MCP alike.
const DIRECTORY_PER_MINUTE = 20;
const DIRECTORY_WINDOW_MS = 60_000;
const DIRECTORY_MAX_WAIT_MS = 5_000;

/**
 * A limiter for Apple directory requests: at most 20 in any rolling 60
 * seconds. take() resolves true and records the request when a place is
 * free. Otherwise it sleeps until the oldest of the 20 turns a minute old,
 * if that keeps its total wait within 5 seconds, and resolves false at once
 * when it would not. Time waited is the larger of clock time and time slept,
 * so it ends even with an injected clock that never moves. A clock that
 * reads as an invalid date gives false (fail closed); one that steps back
 * only keeps old requests counted for longer. `now` and `sleep` are
 * injected for tests, as in waitForQlooSlot. Never throws unless `sleep`
 * does.
 */
export function createDirectoryLimiter(opts: { now?: () => Date; sleep?: (ms: number) => Promise<void> } = {}): DirectoryLimiter {
  const clock = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms: number) => delay(ms));
  // Send times, oldest first. It never holds more than 20.
  const sent: number[] = [];
  return {
    async take() {
      const startedAt = clock().getTime();
      let slept = 0;
      for (;;) {
        const at = clock().getTime();
        if (!Number.isFinite(at) || !Number.isFinite(startedAt)) return false;
        while (sent.length > 0 && sent[0]! <= at - DIRECTORY_WINDOW_MS) sent.shift();
        if (sent.length < DIRECTORY_PER_MINUTE) {
          sent.push(at);
          return true;
        }
        const pause = sent[0]! + DIRECTORY_WINDOW_MS - at;
        if (Math.max(at - startedAt, slept) + pause > DIRECTORY_MAX_WAIT_MS) return false;
        await sleep(pause);
        slept += pause;
      }
    },
  };
}

// One per process, so every search and lookup, whether a website run or an
// MCP find_show asked for it, counts against the same 20 a minute (D3.7).
const directory = createDirectoryLimiter();

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

async function fetchCandidates(url: URL, opts: LookupOptions): Promise<ShowCandidate[]> {
  if (!(await (opts.limiter ?? directory).take())) throw new FeedError("LOOKUP_FAILED");
  const fetchImpl = opts.fetchImpl ?? safeFetch;
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
 * are dropped; a feed URL that is not http or https becomes null. The
 * request first takes a place from the process's directory limiter, shared
 * with lookupShow (createDirectoryLimiter, D3.7).
 *
 * Throws FeedError FEED_BAD_INPUT for an empty term or one over 300
 * characters (no request is made), and LOOKUP_FAILED when no limiter place
 * frees within 5 seconds (no request is made) or for any network, status,
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
  return fetchCandidates(url, opts);
}

/**
 * Looks one show up by its Apple id. Returns null when Apple has no podcast
 * with exactly that id. The request takes a place from the same directory
 * limiter as searchShows (D3.7).
 *
 * Throws FeedError FEED_BAD_INPUT unless the id is 3 to 12 digits (no request
 * is made), and LOOKUP_FAILED when no limiter place frees within 5 seconds
 * (no request is made) or for any network, status, JSON or schema failure.
 */
export async function lookupShow(appleId: string, opts: LookupOptions = {}): Promise<ShowCandidate | null> {
  if (!APPLE_ID.test(appleId)) throw new FeedError("FEED_BAD_INPUT");
  const url = new URL(LOOKUP_ENDPOINT);
  url.search = new URLSearchParams({ id: appleId, entity: "podcast" }).toString();
  const candidates = await fetchCandidates(url, opts);
  return candidates.find((candidate) => candidate.appleId === appleId) ?? null;
}
