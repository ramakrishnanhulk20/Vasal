import type { Db } from "../store/db.js";
import { setBucket, usage } from "../store/meter.js";
import { profileFor, type BucketWindow, type BudgetPolicy } from "./policy.js";

export type BucketState = { cap: number; used: number; windowEnd: Date };

/**
 * One bucket after a roll. `changed` lists what moved: "created" for a new
 * bucket, "cap" for a new cap, "window" when an ended window was reset to 0
 * used and moved on. An empty list means the roll changed nothing.
 * `windowEndWanted` is where the policy would end the window today; when it
 * differs from `after.windowEnd`, a live window set some other way is still
 * running and is left alone until it ends.
 */
export type BucketRoll = {
  key: string;
  window: BucketWindow;
  before: BucketState | null;
  after: BucketState | null;
  windowEndWanted: Date;
  changed: Array<"created" | "cap" | "window">;
};

export type RollOutcome =
  | { covered: false }
  | { covered: true; profile: { from: string; to: string }; buckets: BucketRoll[] };

// Reservations only ever add to used, and one may commit between the two
// reads here, so a rise in used is not a change made by the roll. Only a
// moved window end or a fall in used (the reset) is.
const windowMoved = (before: BucketState, after: BucketState) =>
  before.windowEnd.getTime() !== after.windowEnd.getTime() || after.used < before.used;

/**
 * The end of the window that holds `now`: the next 00:00 UTC for a day, and
 * 00:00 UTC on the first of the next month for a month. Always later than
 * `now`, so a roll at exactly midnight opens the window that starts then.
 * Throws RangeError for an invalid date.
 */
export function windowEndFor(window: BucketWindow, now: Date): Date {
  if (!Number.isFinite(now.getTime())) throw new RangeError("now must be a valid date");
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return window === "day" ? new Date(Date.UTC(year, month, now.getUTCDate() + 1)) : new Date(Date.UTC(year, month + 1, 1));
}

/**
 * Operator use, as the owner role (the app role cannot change a cap or a
 * window). Calls setBucket for every bucket in the profile covering `now`,
 * with that bucket's cap and the window end from windowEndFor, all in one
 * transaction so a failure leaves every bucket as it was. setBucket keeps
 * `used` and the window end inside a live window and resets them only once
 * the stored window has ended, so running this twice in one window changes
 * nothing the second time. setBucket judges "ended" by this machine's clock,
 * so `now` must be the current time. With no profile covering `now`, nothing
 * is set and { covered: false } is returned.
 *
 * Throws RangeError for an invalid date, StoreError("STORE_BAD_INPUT") for a
 * bucket the meter refuses, and StoreError("STORE_UNAVAILABLE") if the
 * database fails.
 */
export async function rollBuckets(db: Db, policy: BudgetPolicy, now: Date): Promise<RollOutcome> {
  const profile = profileFor(policy, now);
  if (profile === null) return { covered: false };

  const buckets = await db.transaction(async (tx) => {
    const rolled: BucketRoll[] = [];
    for (const bucket of profile.buckets) {
      const windowEndWanted = windowEndFor(bucket.window, now);
      const before = await usage(tx, bucket.key);
      await setBucket(tx, { key: bucket.key, cap: bucket.cap, windowEnd: windowEndWanted });
      const after = await usage(tx, bucket.key);

      const changed: BucketRoll["changed"] = [];
      if (before === null) changed.push("created");
      else if (after !== null) {
        if (before.cap !== after.cap) changed.push("cap");
        if (windowMoved(before, after)) changed.push("window");
      }
      rolled.push({ key: bucket.key, window: bucket.window, before, after, windowEndWanted, changed });
    }
    return rolled;
  });

  return { covered: true, profile: { from: profile.from, to: profile.to }, buckets };
}
