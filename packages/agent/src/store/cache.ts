import type { z } from "zod";
import type { Db } from "./db.js";
import { StoreError } from "./errors.js";

const MAX_KEY_LENGTH = 4_096;
const MAX_BODY_LENGTH = 1_000_000;
const MAX_TTL_MS = 366 * 24 * 60 * 60 * 1_000;

const badInput = (): StoreError => new StoreError("STORE_BAD_INPUT");

function checkCacheKey(cacheKey: unknown): string {
  if (typeof cacheKey !== "string" || cacheKey.length === 0 || cacheKey.length > MAX_KEY_LENGTH) throw badInput();
  return cacheKey;
}

function checkInstant(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw badInput();
  return value;
}

/**
 * Reads a cached Qloo body. `cacheKey` is the opaque key from the one request
 * builder that also builds the request sent, never a key assembled here
 * (C7.1). The body is read back as the exact text stored and must pass
 * `schema` before it is returned (C6.5). Returns null when the key is missing,
 * the entry expired at or before `now`, or the stored body fails the schema.
 * Throws StoreError("STORE_BAD_INPUT") for a key outside 1 to 4,096
 * characters or an invalid date, and StoreError("STORE_UNAVAILABLE") if the
 * database fails, so an outage is never mistaken for a miss.
 */
export async function cacheGet<T>(
  db: Db,
  cacheKey: string,
  schema: z.ZodType<T>,
  now: Date = new Date(),
): Promise<T | null> {
  const key = checkCacheKey(cacheKey);
  checkInstant(now);
  // body::text returns the stored characters untouched, so key order and
  // number spelling survive whichever driver parses the row.
  const { rows } = await db.query(
    "SELECT body::text AS body FROM qloo_cache WHERE cache_key = $1 AND expires_at > $2::timestamptz",
    [key, now.toISOString()],
  );
  const text = rows[0]?.["body"];
  if (typeof text !== "string") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const checked = schema.safeParse(parsed);
  return checked.success ? checked.data : null;
}

/**
 * Stores or replaces a cached Qloo body that expires `ttlMs` after `now`.
 * Precondition (C7.2): call this only with a body from a 200 response that
 * parsed and passed its response schema. Errors, 429s and schema failures
 * must never reach it. `cacheKey` must come from the request builder (C7.1).
 * Throws StoreError("STORE_BAD_INPUT") for a key outside 1 to 4,096
 * characters, a body that does not serialise to JSON or serialises to more
 * than 1,000,000 characters (C6.7), a ttlMs that is not an integer from 1 ms
 * to 366 days, or an invalid date. Throws StoreError("STORE_UNAVAILABLE") if
 * the database fails.
 */
export async function cachePut(
  db: Db,
  cacheKey: string,
  body: unknown,
  ttlMs: number,
  now: Date = new Date(),
): Promise<void> {
  const key = checkCacheKey(cacheKey);
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS) throw badInput();
  checkInstant(now);

  let text: string | undefined;
  try {
    text = JSON.stringify(body);
  } catch {
    throw badInput();
  }
  if (typeof text !== "string" || text.length > MAX_BODY_LENGTH) throw badInput();

  // The body travels as text and is cast in SQL, so no driver serialiser can
  // encode it a second time.
  await db.query(
    `INSERT INTO qloo_cache (cache_key, body, fetched_at, expires_at)
     VALUES ($1, $2::text::json, $3::timestamptz, $4::timestamptz)
     ON CONFLICT (cache_key) DO UPDATE SET
       body = excluded.body, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
    [key, text, now.toISOString(), new Date(now.getTime() + ttlMs).toISOString()],
  );
}
