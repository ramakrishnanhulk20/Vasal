import { ServerError } from "../server/errors.js";
import type { Db } from "../store/db.js";

/**
 * The fixed limits on the MCP door (D3.6, D1.5). One human check buys one
 * key, and one key buys at most 3 runs a day for 30 days, so 90 runs before
 * a new human check is needed.
 */
export const MCP_LIMITS = {
  runsPerDay: 3,
  findsPerDay: 20,
  briefsPerDay: 15,
  inflightPerToken: 3,
  keysPerVisitorPerDay: 3,
  tokenLifeDays: 30,
} as const;

export type TokenUseKind = "runs" | "finds" | "briefs";

// The column comes only from this fixed table, never from a value (C6.6).
const COUNT_USE: Record<TokenUseKind, string> = {
  runs: `INSERT INTO mcp_token_daily AS d (token_id, day, runs) VALUES ($1::uuid, $2::date, 1)
         ON CONFLICT (token_id, day) DO UPDATE SET runs = d.runs + 1 WHERE d.runs < $3
         RETURNING d.token_id`,
  finds: `INSERT INTO mcp_token_daily AS d (token_id, day, finds) VALUES ($1::uuid, $2::date, 1)
          ON CONFLICT (token_id, day) DO UPDATE SET finds = d.finds + 1 WHERE d.finds < $3
          RETURNING d.token_id`,
  briefs: `INSERT INTO mcp_token_daily AS d (token_id, day, briefs) VALUES ($1::uuid, $2::date, 1)
           ON CONFLICT (token_id, day) DO UPDATE SET briefs = d.briefs + 1 WHERE d.briefs < $3
           RETURNING d.token_id`,
};
const READ_USE: Record<TokenUseKind, string> = {
  runs: "SELECT runs AS n FROM mcp_token_daily WHERE token_id = $1::uuid AND day = $2::date",
  finds: "SELECT finds AS n FROM mcp_token_daily WHERE token_id = $1::uuid AND day = $2::date",
  briefs: "SELECT briefs AS n FROM mcp_token_daily WHERE token_id = $1::uuid AND day = $2::date",
};

const MAX_DAILY_CAP = 1_000;
const MAX_INFLIGHT = 20;
const MAX_KEYS_PER_VISITOR = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// visitorKey returns a hex HMAC-SHA256. Accepting only that shape means a raw
// address can never reach the issue counter by mistake (C6.8).
const VISITOR_HASH = /^[0-9a-f]{64}$/;

const badInput = (): ServerError => new ServerError("SRV_BAD_INPUT");

function checkTokenId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw badInput();
  return value;
}

function checkWhole(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw badInput();
  return value;
}

function utcDayOf(now: unknown): string {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw badInput();
  return now.toISOString().slice(0, 10);
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
 * Counts one use of `kind` for a key in the UTC day of `now`, if that count
 * is still under `cap` (D3.6). It is one atomic statement: insert the
 * (token, day) row with this kind at 1, or add 1 only while the kind is under
 * the cap, so simultaneous calls can never count past it. Returns true when
 * the use was counted and false when the key is at its cap. `tokenId` is the
 * key row's id, never the key. Throws ServerError("SRV_BAD_INPUT") for an id
 * that is not a lower-case UUID, a kind other than runs, finds or briefs, a
 * cap outside 1 to 1,000 or an invalid date, and
 * ServerError("SRV_UNAVAILABLE") if the database fails or the key row does
 * not exist, so callers refuse (C5.7).
 */
export async function countTokenUse(
  db: Db,
  tokenId: string,
  kind: TokenUseKind,
  cap: number,
  now: Date = new Date(),
): Promise<boolean> {
  const id = checkTokenId(tokenId);
  if (typeof kind !== "string" || !Object.hasOwn(COUNT_USE, kind)) throw badInput();
  checkWhole(cap, 1, MAX_DAILY_CAP);
  const day = utcDayOf(now);
  const { rows } = await stored(() => db.query(COUNT_USE[kind], [id, day, cap]));
  return rows.length === 1;
}

/**
 * True when a key has already used `cap` of `kind` in the UTC day of `now`.
 * A plain read with no write and no lock, so it only lets a call that is
 * sure to be refused stop before it takes anything; countTokenUse stays the
 * gate (D3.6). A key with no row for the day has used none. A count that
 * does not read back as a whole number counts as at the cap (C5.7). Throws
 * ServerError("SRV_BAD_INPUT") for the inputs countTokenUse refuses, and
 * ServerError("SRV_UNAVAILABLE") if the database fails.
 */
export async function tokenUseAtCap(db: Db, tokenId: string, kind: TokenUseKind, cap: number, now: Date): Promise<boolean> {
  const id = checkTokenId(tokenId);
  if (typeof kind !== "string" || !Object.hasOwn(READ_USE, kind)) throw badInput();
  checkWhole(cap, 1, MAX_DAILY_CAP);
  const day = utcDayOf(now);
  const { rows } = await stored(() => db.query(READ_USE[kind], [id, day]));
  if (rows.length === 0) return false;
  const used: unknown = rows[0]?.["n"];
  return typeof used !== "number" || !Number.isSafeInteger(used) || used >= cap;
}

/**
 * Takes one of a key's calls in flight (D3.6). One atomic statement inserts
 * the key's counter at 1 or adds 1 only while it is under `max`, so
 * simultaneous calls can never hold more than `max`. Returns false when the
 * key is at its limit. Throws ServerError("SRV_BAD_INPUT") for a bad id or a
 * max outside 1 to 20, and ServerError("SRV_UNAVAILABLE") if the database
 * fails or the key row does not exist.
 */
export async function acquireTokenInflight(db: Db, tokenId: string, max: number): Promise<boolean> {
  const id = checkTokenId(tokenId);
  checkWhole(max, 1, MAX_INFLIGHT);
  const { rows } = await stored(() =>
    db.query(
      `INSERT INTO mcp_token_inflight AS f (token_id, n) VALUES ($1::uuid, 1)
       ON CONFLICT (token_id) DO UPDATE SET n = f.n + 1 WHERE f.n < $2
       RETURNING f.n`,
      [id, max],
    ),
  );
  return rows.length === 1;
}

/**
 * Gives back one of a key's calls in flight. Never takes the count below 0,
 * so an extra release cannot hand out a call that was never taken. Throws
 * ServerError("SRV_BAD_INPUT") for a bad id and
 * ServerError("SRV_UNAVAILABLE") if the database fails.
 */
export async function releaseTokenInflight(db: Db, tokenId: string): Promise<void> {
  const id = checkTokenId(tokenId);
  await stored(() => db.query("UPDATE mcp_token_inflight SET n = n - 1 WHERE token_id = $1::uuid AND n > 0", [id]));
}

/**
 * Startup step, alongside resetInflight: sets every key's calls in flight
 * back to 0, so calls held by a process that died do not lock a key out.
 * Like resetInflight, it assumes one agent server process per database.
 * Throws ServerError("SRV_UNAVAILABLE") if the database fails.
 */
export async function resetTokenInflight(db: Db): Promise<void> {
  await stored(() => db.query("UPDATE mcp_token_inflight SET n = 0 WHERE n <> 0"));
}

/**
 * Counts one agent key issued to a visitor in the UTC day of `now`, if they
 * are still under `cap` (D1.5). One atomic statement, as countTokenUse, so
 * simultaneous requests can never count past the cap. Returns true when the
 * key was counted. `visitorHash` must be the 64-character hex key from
 * visitorKey, never a raw address (C5.3, C6.8). Throws
 * ServerError("SRV_BAD_INPUT") for any other hash, a cap outside 1 to 100 or
 * an invalid date, and ServerError("SRV_UNAVAILABLE") if the database fails.
 */
export async function countKeyIssue(db: Db, visitorHash: string, cap: number, now: Date = new Date()): Promise<boolean> {
  if (typeof visitorHash !== "string" || !VISITOR_HASH.test(visitorHash)) throw badInput();
  checkWhole(cap, 1, MAX_KEYS_PER_VISITOR);
  const day = utcDayOf(now);
  const { rows } = await stored(() =>
    db.query(
      `INSERT INTO mcp_key_issue AS k (visitor_hash, day, n) VALUES ($1, $2::date, 1)
       ON CONFLICT (visitor_hash, day) DO UPDATE SET n = k.n + 1 WHERE k.n < $3
       RETURNING k.n`,
      [visitorHash, day, cap],
    ),
  );
  return rows.length === 1;
}
