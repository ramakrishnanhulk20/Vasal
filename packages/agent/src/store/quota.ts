import { z } from "zod";
import type { QlooQuota } from "../qloo/client.js";
import type { Db } from "./db.js";
import { StoreError } from "./errors.js";

/** The fewest calls Qloo's own monthly count may show before metered calls and the probe stop. */
export const QLOO_QUOTA_FLOOR = 1_500;

// The largest value a Postgres integer column holds.
const MAX_COUNT = 2_147_483_647;
// Every Qloo reply records a fresh count, so a reading this old means no call
// has gone out since. Treating it as no reading lets one burst through after
// Qloo's reset; the first reply then records the new count, or a count still
// under the floor that stops the rest for another day.
const QUOTA_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

const count = z.number().int().min(0).max(MAX_COUNT);
// pg and PGlite both return timestamptz as a Date, but a string is accepted
// too and checked the same way, as meter.ts does (C6.5).
const instant = z
  .union([z.date(), z.string()])
  .transform((value) => new Date(value))
  .pipe(z.date());
const quotaRow = z.object({ remaining: count, quota_limit: count, seen_at: instant });

function checkCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_COUNT) throw new StoreError("STORE_BAD_INPUT");
  return value;
}

function checkInstant(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new StoreError("STORE_BAD_INPUT");
  return value;
}

/**
 * Stores Qloo's own monthly count from one reply as the single qloo_quota
 * row, stamped with the database's own clock (now()), never the caller's, so
 * a host whose clock runs fast cannot stamp a reading that no later one can
 * replace. The write lands only when its stamp is later than the stored
 * one's, so a slow write that began before a newer one committed never
 * replaces the newer count; an equal or older stamp changes nothing.
 * `quota.seenAt` is checked but not stored. Throws
 * StoreError("STORE_BAD_INPUT") for a remaining or limit that is not a whole
 * number from 0 to 2,147,483,647 or a seenAt that is not a valid Date,
 * before the database is touched, and StoreError("STORE_UNAVAILABLE") if the
 * database fails.
 */
export async function recordQuota(db: Db, quota: QlooQuota): Promise<void> {
  if (typeof quota !== "object" || quota === null) throw new StoreError("STORE_BAD_INPUT");
  const remaining = checkCount(quota.remaining);
  const limit = checkCount(quota.limit);
  checkInstant(quota.seenAt);
  await db.query(
    `INSERT INTO qloo_quota AS q (id, remaining, quota_limit, seen_at)
     VALUES (1, $1, $2, now())
     ON CONFLICT (id) DO UPDATE SET
       remaining = excluded.remaining, quota_limit = excluded.quota_limit, seen_at = excluded.seen_at
     WHERE q.seen_at < excluded.seen_at`,
    [remaining, limit],
  );
}

/**
 * Reads the stored Qloo monthly count. Returns null when no reply has been
 * recorded yet or the row fails its schema (a count outside 0 to
 * 2,147,483,647, or a time that is not a valid date), so a damaged row is
 * never read as a real count (C6.5). Throws StoreError("STORE_UNAVAILABLE")
 * if the database fails, so an outage is never mistaken for no reading.
 */
export async function readQuota(db: Db): Promise<QlooQuota | null> {
  const { rows } = await db.query("SELECT remaining, quota_limit, seen_at FROM qloo_quota WHERE id = 1");
  const parsed = quotaRow.safeParse(rows[0]);
  if (!parsed.success) return null;
  return { remaining: parsed.data.remaining, limit: parsed.data.quota_limit, seenAt: parsed.data.seen_at };
}

/**
 * Whether Qloo's own stored count lets one more call go out. The one floor
 * rule the metered client and the probe both apply. False only when a
 * reading is stored, was seen less than 24 hours before `now`, and its
 * remaining is below `floor`. True when nothing is stored, the row fails its
 * schema (readQuota gives null), or the reading is 24 hours old or more, so
 * after Qloo's reset only the calls that start before the first fresh reply
 * records the new count go out unchecked. A reading stamped after `now`
 * counts as fresh. Throws
 * StoreError("STORE_BAD_INPUT") for a floor that is not a whole number from 0
 * or a `now` that is not a valid Date, before the database is touched, and
 * StoreError("STORE_UNAVAILABLE") if the database fails, so an outage is
 * never read as a yes.
 */
export async function quotaAllows(db: Db, floor: number, now: Date): Promise<boolean> {
  if (!Number.isSafeInteger(floor) || floor < 0) throw new StoreError("STORE_BAD_INPUT");
  const at = checkInstant(now);
  const quota = await readQuota(db);
  if (quota === null) return true;
  return at.getTime() - quota.seenAt.getTime() >= QUOTA_MAX_AGE_MS || quota.remaining >= floor;
}
