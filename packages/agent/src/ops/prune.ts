import { z } from "zod";
import type { Db } from "../store/db.js";
import { StoreError } from "../store/errors.js";
import { pruneSecondBuckets } from "../store/meter.js";

export type PruneCounts = {
  cacheRows: number;
  secondBuckets: number;
  visitorCounters: number;
  mcpTokens: number;
  mcpTokenDaily: number;
  mcpKeyIssue: number;
};

const DAY_MS = 24 * 60 * 60 * 1_000;
// Visitor counters use one UTC day per window (server/caps.ts), and so do the
// MCP key and key-issue counters. Deleting only days that started more than
// 2 days ago keeps today's and yesterday's rows, so a prune just after
// midnight, or a host whose clock lags, never removes a day that is still
// being counted (C6.8).
const DAILY_COUNTER_KEEP_MS = 2 * DAY_MS;
// A key stays a week past its expiry, so the operator can still see it in
// the list while looking into anything it did.
const EXPIRED_TOKEN_KEEP_MS = 7 * DAY_MS;

const removed = z.object({ removed: z.number().int().min(0) });

async function deleteCounted(db: Db, text: string, params: unknown[]): Promise<number> {
  const { rows } = await db.query(text, params);
  const parsed = removed.safeParse(rows[0]);
  if (!parsed.success) throw new StoreError("STORE_UNAVAILABLE");
  return parsed.data.removed;
}

/**
 * Operator use. Deletes, in one transaction:
 * - qloo_cache rows whose expires_at is at or before `now`, the same rule
 *   cacheGet uses to call an entry expired (C7.2);
 * - per-second Qloo buckets whose window has ended, through
 *   pruneSecondBuckets;
 * - visitor_counters rows whose window started more than 2 days before
 *   `now`, so hashed visitor keys do not outlive their window (C6.8);
 * - mcp_key_issue and mcp_token_daily rows whose UTC day started more than
 *   2 days before `now`, for the same reason;
 * - agent keys that expired more than 7 days before `now` and that no run
 *   points to, with their remaining counter rows by cascade (D6.2). A key a
 *   run points to is kept, expired and unusable, because runs are never
 *   deleted and each MCP run keeps the record of which key made it.
 * Day and month buckets are never deleted; an ended one is reset by the
 * budget roll instead. Returns how many rows each step removed.
 *
 * Needs DELETE, which the app role vasal_app does not hold, so it must run
 * on the owner connection. Throws StoreError("STORE_BAD_INPUT") for an
 * invalid date and StoreError("STORE_UNAVAILABLE") if the database fails, in
 * which case nothing is deleted.
 */
export async function pruneExpired(db: Db, now: Date): Promise<PruneCounts> {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new StoreError("STORE_BAD_INPUT");
  const dayCutoff = new Date(now.getTime() - DAILY_COUNTER_KEEP_MS);
  const tokenCutoff = new Date(now.getTime() - EXPIRED_TOKEN_KEEP_MS);

  return db.transaction(async (tx) => {
    const cacheRows = await deleteCounted(
      tx,
      `WITH gone AS (DELETE FROM qloo_cache WHERE expires_at <= $1::timestamptz RETURNING 1)
       SELECT count(*)::int AS removed FROM gone`,
      [now.toISOString()],
    );
    const secondBuckets = await pruneSecondBuckets(tx, now);
    const visitorCounters = await deleteCounted(
      tx,
      `WITH gone AS (DELETE FROM visitor_counters WHERE window_start < $1::timestamptz RETURNING 1)
       SELECT count(*)::int AS removed FROM gone`,
      [dayCutoff.toISOString()],
    );
    // A date column holds no time zone, so each day is read as starting at
    // 00:00 UTC, the same day start the counters were written with.
    const mcpKeyIssue = await deleteCounted(
      tx,
      `WITH gone AS (DELETE FROM mcp_key_issue WHERE (day::timestamp AT TIME ZONE 'UTC') < $1::timestamptz RETURNING 1)
       SELECT count(*)::int AS removed FROM gone`,
      [dayCutoff.toISOString()],
    );
    const mcpTokenDaily = await deleteCounted(
      tx,
      `WITH gone AS (DELETE FROM mcp_token_daily WHERE (day::timestamp AT TIME ZONE 'UTC') < $1::timestamptz RETURNING 1)
       SELECT count(*)::int AS removed FROM gone`,
      [dayCutoff.toISOString()],
    );
    const mcpTokens = await deleteCounted(
      tx,
      `WITH gone AS (
         DELETE FROM mcp_tokens t
         WHERE t.expires_at < $1::timestamptz AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.token_id = t.id)
         RETURNING 1
       )
       SELECT count(*)::int AS removed FROM gone`,
      [tokenCutoff.toISOString()],
    );
    return { cacheRows, secondBuckets, visitorCounters, mcpTokens, mcpTokenDaily, mcpKeyIssue };
  });
}
