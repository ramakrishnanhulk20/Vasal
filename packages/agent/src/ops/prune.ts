import { z } from "zod";
import type { Db } from "../store/db.js";
import { StoreError } from "../store/errors.js";
import { pruneSecondBuckets } from "../store/meter.js";

export type PruneCounts = { cacheRows: number; secondBuckets: number; visitorCounters: number };

// Visitor counters use one UTC day per window (server/caps.ts). Deleting only
// windows that started more than 2 days ago keeps today's and yesterday's
// rows, so a prune just after midnight, or a host whose clock lags, never
// removes a window that is still being counted (C6.8).
const VISITOR_COUNTER_KEEP_MS = 2 * 24 * 60 * 60 * 1_000;

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
 *   `now`, so hashed visitor keys do not outlive their window (C6.8).
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
  const visitorCutoff = new Date(now.getTime() - VISITOR_COUNTER_KEEP_MS);

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
      [visitorCutoff.toISOString()],
    );
    return { cacheRows, secondBuckets, visitorCounters };
  });
}
