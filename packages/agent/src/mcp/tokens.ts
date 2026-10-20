import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { ServerError } from "../server/errors.js";
import type { Db } from "../store/db.js";
import { MCP_LIMITS } from "./usage.js";

/** The one shape an agent key has: vsl_ and 32 random bytes as unpadded base64url (D1.1). */
export const TOKEN_PATTERN = /^vsl_[A-Za-z0-9_-]{43}$/;

/** The app_flags row that switches the MCP door on. Missing or unreadable means off (D1.6). */
export const MCP_ENABLED_FLAG = "mcp_enabled";

const TOKEN_PREFIX = "vsl_";
const TOKEN_BYTES = 32;
const HOURS_PER_DAY = 24;
const TOKEN_LIFE_MS = MCP_LIMITS.tokenLifeDays * HOURS_PER_DAY * 60 * 60 * 1_000;
// Written out letter by letter so only ASCII spellings of the scheme pass. A
// case fold could map some other character onto one of these letters.
const BEARER_SCHEME = /^[Bb][Ee][Aa][Rr][Ee][Rr]$/;
const BEARER_LENGTH = "Bearer".length;
/** The most key rows listTokens returns, newest first. */
export const TOKEN_LIST_LIMIT = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const instant = z
  .union([z.date(), z.string()])
  .transform((value) => new Date(value))
  .pipe(z.date());
const count = z
  .union([z.number(), z.string().regex(/^\d+$/)])
  .transform(Number)
  .pipe(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER));

// A live key row as issueToken writes it. A row whose life is longer than
// issue grants, or that ends before it starts, was not written by this code
// and reads as missing (D6.1, C6.5).
const liveTokenRow = z
  .object({
    id: z.string().regex(UUID),
    token_hash: z.string().regex(/^[0-9a-f]{64}$/),
    created_at: instant,
    expires_at: instant,
    revoked: z.literal(false),
  })
  .refine((row) => {
    const life = row.expires_at.getTime() - row.created_at.getTime();
    return life > 0 && life <= TOKEN_LIFE_MS;
  });

const listedRow = z.object({ id: z.string().regex(UUID), created_at: instant, expires_at: instant, revoked: z.boolean() });

// The one function that turns a key into what is stored and looked up, so
// issue and check can never disagree (D1 general standard 2).
function hashOf(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

async function stored<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ServerError) throw error;
    throw new ServerError("SRV_UNAVAILABLE");
  }
}

/**
 * Issues one agent key (D1.1). The key is vsl_ followed by 32 bytes from
 * crypto.randomBytes as unpadded base64url. Only its SHA-256 hex is stored,
 * with created_at and expires_at taken from the database clock (now() and
 * 30 days later), so no machine's clock can stretch a key's life (D1.3). The
 * row holds no visitor address or hash (D1.7). The key itself is in the
 * return value and nowhere else: it is never logged or stored, and the
 * caller sends it once and drops it (D1.4). Throws
 * ServerError("SRV_UNAVAILABLE") if the database fails or the written row
 * does not read back as a live key.
 */
export async function issueToken(db: Db): Promise<{ id: string; token: string; expiresAt: Date }> {
  const token = `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
  if (!TOKEN_PATTERN.test(token)) throw new ServerError("SRV_UNAVAILABLE");
  const id = randomUUID();
  const hash = hashOf(token);
  // A whole number of hours, not days: a day interval follows the session
  // time zone across a clock change, and the row check wants an exact life.
  const { rows } = await stored(() =>
    db.query(
      `INSERT INTO mcp_tokens (id, token_hash, created_at, expires_at, revoked)
       VALUES ($1::uuid, $2, now(), now() + make_interval(hours => $3::int), false)
       RETURNING id::text AS id, token_hash, created_at, expires_at, revoked`,
      [id, hash, MCP_LIMITS.tokenLifeDays * HOURS_PER_DAY],
    ),
  );
  const parsed = liveTokenRow.safeParse(rows[0]);
  if (!parsed.success || parsed.data.id !== id || parsed.data.token_hash !== hash) throw new ServerError("SRV_UNAVAILABLE");
  return { id, token, expiresAt: parsed.data.expires_at };
}

/**
 * Reads an agent key from an Authorization header value (D1.2). Accepts only
 * the scheme Bearer, in any mix of ASCII upper and lower case, then exactly
 * one space, then a value matching TOKEN_PATTERN, with nothing before or
 * after. Anything else gives null: a missing header, Basic, two spaces, a
 * tab, a short or long key, a VSL_ prefix, or trailing text. It reads no
 * other header, no cookie, query string or body. Never throws and touches no
 * database.
 */
export function parseBearer(header: string | null | undefined): string | null {
  if (typeof header !== "string") return null;
  if (header.indexOf(" ") !== BEARER_LENGTH) return null;
  const scheme = header.slice(0, BEARER_LENGTH);
  const token = header.slice(BEARER_LENGTH + 1);
  if (!BEARER_SCHEME.test(scheme) || !TOKEN_PATTERN.test(token)) return null;
  return token;
}

/**
 * Says which key row a presented key belongs to, or null (D1.3). Runs one
 * query on the key's hash that also requires revoked = false and
 * expires_at > now() on the database clock, so a revoked or expired key is
 * refused on the very next request and no answer outlives the call. A value
 * that does not match TOKEN_PATTERN is null without any database read. A row
 * that fails the key row schema, including one whose life is longer than
 * issue grants, is null (D6.1). Throws ServerError("SRV_UNAVAILABLE") if the
 * database fails, so an outage is never mistaken for a refusal or a pass.
 */
export async function authenticateToken(db: Db, token: string): Promise<{ id: string } | null> {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;
  const hash = hashOf(token);
  const { rows } = await stored(() =>
    db.query(
      `SELECT id::text AS id, token_hash, created_at, expires_at, revoked FROM mcp_tokens
       WHERE token_hash = $1 AND revoked = false AND expires_at > now()`,
      [hash],
    ),
  );
  if (rows.length !== 1) return null;
  const parsed = liveTokenRow.safeParse(rows[0]);
  if (!parsed.success || parsed.data.token_hash !== hash) return null;
  return { id: parsed.data.id };
}

/**
 * True only when the app_flags row mcp_enabled exists and holds boolean true.
 * A missing row, any other value, or any failure returns false, so an
 * unreadable flag keeps the MCP door shut (C5.7, D1.6). Never throws.
 */
export async function mcpEnabled(db: Db): Promise<boolean> {
  try {
    const { rows } = await db.query("SELECT value FROM app_flags WHERE name = $1", [MCP_ENABLED_FLAG]);
    return rows.length === 1 && rows[0]?.["value"] === true;
  } catch {
    return false;
  }
}

export type TokenListing = { id: string; createdAt: Date; expiresAt: Date; revoked: boolean };

/**
 * Operator use. Lists key rows newest first, at most 500, with the total
 * count. Each entry holds the row id, created and expiry times and whether
 * it is revoked, never the hash. A row that fails its schema is left out
 * (C6.5). Throws ServerError("SRV_UNAVAILABLE") if the database fails.
 */
export async function listTokens(db: Db): Promise<{ total: number; tokens: TokenListing[] }> {
  const totals = await stored(() => db.query("SELECT count(*)::int AS n FROM mcp_tokens"));
  const total = count.safeParse(totals.rows[0]?.["n"]);
  if (!total.success) throw new ServerError("SRV_UNAVAILABLE");
  const { rows } = await stored(() =>
    db.query(
      `SELECT id::text AS id, created_at, expires_at, revoked FROM mcp_tokens
       ORDER BY created_at DESC, id LIMIT $1`,
      [TOKEN_LIST_LIMIT],
    ),
  );
  const tokens: TokenListing[] = [];
  for (const row of rows) {
    const parsed = listedRow.safeParse(row);
    if (parsed.success) {
      tokens.push({ id: parsed.data.id, createdAt: parsed.data.created_at, expiresAt: parsed.data.expires_at, revoked: parsed.data.revoked });
    }
  }
  return { total: total.data, tokens };
}

/**
 * Operator use, as the owner role: the app role has no UPDATE on mcp_tokens
 * (D1.6). Marks one key revoked, so authenticateToken refuses it from the
 * next request on. Revoking an already revoked key changes nothing and still
 * returns true. Returns false when no key row has that id. Throws
 * ServerError("SRV_BAD_INPUT") for an id that is not a lower-case UUID and
 * ServerError("SRV_UNAVAILABLE") if the database fails.
 */
export async function revokeToken(db: Db, tokenId: string): Promise<boolean> {
  if (typeof tokenId !== "string" || !UUID.test(tokenId)) throw new ServerError("SRV_BAD_INPUT");
  const { rows } = await stored(() =>
    db.query("UPDATE mcp_tokens SET revoked = true WHERE id = $1::uuid RETURNING id", [tokenId]),
  );
  return rows.length === 1;
}

/**
 * Operator use, as the owner role (D1.6). Marks every key that is not yet
 * revoked as revoked, in one statement, and returns how many changed. Throws
 * ServerError("SRV_UNAVAILABLE") if the database fails.
 */
export async function revokeAllTokens(db: Db): Promise<number> {
  const { rows } = await stored(() =>
    db.query(
      `WITH changed AS (UPDATE mcp_tokens SET revoked = true WHERE revoked = false RETURNING 1)
       SELECT count(*)::int AS n FROM changed`,
    ),
  );
  const parsed = count.safeParse(rows[0]?.["n"]);
  if (!parsed.success) throw new ServerError("SRV_UNAVAILABLE");
  return parsed.data;
}
