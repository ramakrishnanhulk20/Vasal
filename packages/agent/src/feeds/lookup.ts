import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { safeFetch } from "../net/safe-fetch.js";
import { cacheGet, cachePut } from "../store/cache.js";
import type { Db } from "../store/db.js";
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

/**
 * Where directory answers are kept between runs. get resolves null on a
 * miss; whatever it gives back is checked against the candidate schema
 * before use, so the store is never trusted (C6.5).
 */
export type DirectoryCache = {
  get(key: string): Promise<unknown | null>;
  put(key: string, value: unknown, ttlMs: number): Promise<void>;
};

/**
 * `cache` keeps answers for an hour (createDirectoryCache in production).
 * `surface` is the run's surface: an "mcp" lookup also takes a place from
 * MCP's own limiter. `fetchImpl` and `limiter` are for tests; every other
 * caller leaves them out and shares the process's limiters.
 */
export type LookupOptions = {
  fetchImpl?: typeof safeFetch;
  limiter?: DirectoryLimiter;
  cache?: DirectoryCache;
  surface?: "web" | "mcp";
};

/** The lookup options a run passes on: the shared cache and its own surface. */
export type DirectoryLookup = Pick<LookupOptions, "cache" | "surface">;

const SEARCH_ENDPOINT = "https://itunes.apple.com/search";
const LOOKUP_ENDPOINT = "https://itunes.apple.com/lookup";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RESULTS = 5;
const MAX_TERM_CHARS = 300;
const APPLE_ID = /^\d{3,12}$/;
// Apple documents roughly 20 calls a minute for the Search API, and going
// over gets the server's one address throttled for the website and MCP alike.
const DIRECTORY_PER_MINUTE = 20;
// Half of the minute, so agents alone can never starve the website's lookups.
const MCP_DIRECTORY_PER_MINUTE = 10;
const DIRECTORY_WINDOW_MS = 60_000;
const DIRECTORY_MAX_WAIT_MS = 5_000;
const DIRECTORY_CACHE_TTL_MS = 60 * 60 * 1_000;
// Qloo's keys start with "GET " or "RAW GET ", so the shared table can
// never hand a Qloo body to the directory or the other way round.
const CACHE_KEY_PREFIX = "APPLE GET ";

/**
 * A limiter for Apple directory requests: at most `perMinute` (default 20,
 * a whole number from 1 to 20) in any rolling 60 seconds. take() resolves
 * true and records the request when a place is free. Otherwise it sleeps
 * until the oldest recorded request turns a minute old, if that keeps its
 * total wait within 5 seconds, and resolves false at once when it would not.
 * Time waited is the larger of clock time and time slept, so it ends even
 * with an injected clock that never moves. A clock that reads as an invalid
 * date gives false (fail closed); one that steps back only keeps old
 * requests counted for longer. `now` and `sleep` are injected for tests, as
 * in waitForQlooSlot. Throws RangeError at creation for a bad perMinute;
 * take() never throws unless `sleep` does.
 */
export function createDirectoryLimiter(
  opts: { now?: () => Date; sleep?: (ms: number) => Promise<void>; perMinute?: number } = {},
): DirectoryLimiter {
  const perMinute = opts.perMinute ?? DIRECTORY_PER_MINUTE;
  if (!Number.isSafeInteger(perMinute) || perMinute < 1 || perMinute > DIRECTORY_PER_MINUTE) {
    throw new RangeError("perMinute must be a whole number from 1 to 20.");
  }
  const clock = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms: number) => delay(ms));
  // Send times, oldest first. It never holds more than perMinute.
  const sent: number[] = [];
  return {
    async take() {
      const startedAt = clock().getTime();
      let slept = 0;
      for (;;) {
        const at = clock().getTime();
        if (!Number.isFinite(at) || !Number.isFinite(startedAt)) return false;
        while (sent.length > 0 && sent[0]! <= at - DIRECTORY_WINDOW_MS) sent.shift();
        if (sent.length < perMinute) {
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
const mcpDirectory = createDirectoryLimiter({ perMinute: MCP_DIRECTORY_PER_MINUTE });

/**
 * The production DirectoryCache: rows in the shared cache table through
 * cacheGet and cachePut (store/cache.ts), each expiring `ttlMs` after `now`.
 * get passes the stored JSON back unchecked, since searchShows and
 * lookupShow check it themselves, and both pass on StoreError so an outage
 * is never mistaken for a miss.
 */
export function createDirectoryCache(db: Db, now: () => Date = () => new Date()): DirectoryCache {
  return {
    get: (key) => cacheGet(db, key, z.unknown(), now()),
    put: (key, value, ttlMs) => cachePut(db, key, value, ttlMs, now()),
  };
}

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

// A cached answer is the results that passed resultSchema, read back
// through that same schema, so it becomes exactly the candidates a fresh
// answer would.
const cachedResults = z.array(resultSchema).max(MAX_RESULTS);

function toCandidate(result: z.output<typeof resultSchema>): ShowCandidate {
  return {
    appleId: String(result.collectionId),
    name: result.collectionName,
    publisher: result.artistName ?? "",
    feedUrl: httpUrlOrNull(result.feedUrl),
    genre: result.primaryGenreName ?? null,
  };
}

// MCP's own limiter goes first, so a lookup it refuses never holds one of
// the shared places. Anything other than a plain website lookup is held to
// MCP's share (fail closed).
async function takePlace(opts: LookupOptions): Promise<boolean> {
  if (opts.surface !== undefined && opts.surface !== "web" && !(await mcpDirectory.take())) return false;
  return (opts.limiter ?? directory).take();
}

async function fetchCandidates(url: URL, opts: LookupOptions): Promise<ShowCandidate[]> {
  // Keyed on the URL that would be sent, so a cached answer is always the
  // answer to this exact request.
  const cacheKey = `${CACHE_KEY_PREFIX}${url.href}`;
  if (opts.cache !== undefined) {
    const cached = cachedResults.safeParse(await opts.cache.get(cacheKey));
    if (cached.success) return cached.data.map(toCandidate);
  }

  if (!(await takePlace(opts))) throw new FeedError("LOOKUP_FAILED");
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
  const results = parsed.data.results.slice(0, MAX_RESULTS).flatMap((raw) => {
    const result = resultSchema.safeParse(raw);
    return result.success ? [result.data] : [];
  });
  await opts.cache?.put(cacheKey, results, DIRECTORY_CACHE_TTL_MS);
  return results.map(toCandidate);
}

/**
 * Searches Apple's podcast directory by show name and returns up to 5
 * candidates. The term travels only as one URLSearchParams value, so `&` or
 * `#` in it cannot add or cut parameters (C2.3). Entries that fail the schema
 * are dropped; a feed URL that is not http or https becomes null.
 *
 * With opts.cache, an answer for the same normalised term (NFC, trimmed) in
 * the last hour is served from it, with no request and no limiter place, if
 * it still passes the candidate schema; one that fails is a miss. Only a
 * parsed answer is stored, as the results that passed the schema. Otherwise
 * the request first takes a place from the process's directory limiter, 20
 * a minute shared with lookupShow (createDirectoryLimiter, D3.7). An "mcp"
 * lookup first takes a place from MCP's own limiter, 10 a minute, so MCP
 * alone never holds more than half the shared places.
 *
 * Throws FeedError FEED_BAD_INPUT for an empty term or one over 300
 * characters (no request is made), and LOOKUP_FAILED when no limiter place
 * frees within 5 seconds (no request is made) or for any network, status,
 * JSON or schema failure. Whatever the cache throws is passed on.
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
 * with exactly that id. The cache, the directory limiter and MCP's own
 * limiter work exactly as in searchShows, keyed here by the id (D3.7).
 *
 * Throws FeedError FEED_BAD_INPUT unless the id is 3 to 12 digits (no request
 * is made), and LOOKUP_FAILED when no limiter place frees within 5 seconds
 * (no request is made) or for any network, status, JSON or schema failure.
 * Whatever the cache throws is passed on.
 */
export async function lookupShow(appleId: string, opts: LookupOptions = {}): Promise<ShowCandidate | null> {
  if (!APPLE_ID.test(appleId)) throw new FeedError("FEED_BAD_INPUT");
  const url = new URL(LOOKUP_ENDPOINT);
  url.search = new URLSearchParams({ id: appleId, entity: "podcast" }).toString();
  const candidates = await fetchCandidates(url, opts);
  return candidates.find((candidate) => candidate.appleId === appleId) ?? null;
}
