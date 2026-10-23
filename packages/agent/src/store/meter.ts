import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Db } from "./db.js";
import { StoreError } from "./errors.js";

export type Reservation = { key: string; amount: number };
export type BucketPolicy = { key: string; cap: number; windowEnd: Date };

const MAX_ITEMS = 8;
const MAX_AMOUNT = 1_000_000;
const MAX_KEY_LENGTH = 200;
const MAX_WAIT_LIMIT_MS = 60_000;

const QLOO_MONTH = "qloo:month";
const QLOO_DAY = "qloo:day";
const QLOO_SECOND_PREFIX = "qloo:second:";
// Qloo's own headers report 10 calls a second (key day, 21 Oct). Holding back
// two leaves room for clock differences between the hosts that share a second
// and for calls this meter never sees, such as the harness's own (C5.2).
/** How many Qloo calls the meter lets through in one UTC second, across every share. */
export const QLOO_PER_SECOND_CAP = 8;
const SECOND_BUCKET_LIFETIME_MS = 2_000;
// A surface's own month or day cap under the shared ones, such as
// qloo:month:mcp. The third word is required, so the shared qloo:month and
// qloo:day, and every per-second bucket, can never be named here.
const QLOO_EXTRA_KEY = /^qloo:(month|day):[a-z]+$/;
const MAX_EXTRA_KEYS = 2;

// pg returns bigint columns as digit strings and PGlite as numbers, so both
// shapes are accepted and checked the same way (C6.5).
const count = z
  .union([z.number(), z.string().regex(/^\d+$/), z.bigint()])
  .transform(Number)
  .pipe(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER));
const instant = z
  .union([z.date(), z.string()])
  .transform((value) => new Date(value))
  .pipe(z.date());
const bucketRow = z.object({ key: z.string(), cap: count, used: count, window_end: instant });
type BucketRow = z.output<typeof bucketRow>;

type Outcome = { ok: true } | { ok: false; refused: string[] };

const badInput = (): StoreError => new StoreError("STORE_BAD_INPUT");

function checkKey(key: unknown): string {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_LENGTH) throw badInput();
  return key;
}

function checkInstant(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw badInput();
  return value;
}

// Duplicate keys are summed so the single UPDATE below adds the full total;
// an UPDATE joined to repeated keys would apply only one of them.
function totalsOf(items: unknown): Map<string, number> {
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) throw badInput();
  const totals = new Map<string, number>();
  for (const item of items as unknown[]) {
    if (typeof item !== "object" || item === null) throw badInput();
    const { key, amount } = item as { key?: unknown; amount?: unknown };
    const checkedKey = checkKey(key);
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 1 || amount > MAX_AMOUNT) {
      throw badInput();
    }
    totals.set(checkedKey, (totals.get(checkedKey) ?? 0) + amount);
  }
  return totals;
}

// One SELECT ... ORDER BY ... FOR UPDATE takes the row locks in sorted order,
// because Postgres sorts before it locks. Every caller therefore queues on the
// same first row and two reservations can never wait on each other. COLLATE
// "C" makes the order plain byte order, whatever the database locale.
async function reserveWithin(tx: Db, totals: Map<string, number>, now: Date): Promise<Outcome> {
  const entries = [...totals];
  const keys = entries.map(([key]) => key);
  const { rows } = await tx.query(
    `SELECT key, cap, used, window_end FROM usage_buckets
     WHERE key = ANY($1::text[]) ORDER BY key COLLATE "C" FOR UPDATE`,
    [keys],
  );

  const buckets = new Map<string, BucketRow>();
  for (const row of rows) {
    const parsed = bucketRow.safeParse(row);
    if (parsed.success) buckets.set(parsed.data.key, parsed.data);
  }

  // Missing, unreadable and expired buckets all refuse (fail closed, C5.7).
  const refused = entries
    .filter(([key, amount]) => {
      const bucket = buckets.get(key);
      return !bucket || bucket.window_end.getTime() <= now.getTime() || bucket.used + amount > bucket.cap;
    })
    .map(([key]) => key);
  if (refused.length > 0) return { ok: false, refused };

  await tx.query(
    `UPDATE usage_buckets AS b SET used = b.used + v.amount
     FROM unnest($1::text[], $2::bigint[]) AS v(key, amount)
     WHERE b.key = v.key`,
    [keys, entries.map(([, amount]) => amount)],
  );
  return { ok: true };
}

/**
 * Operator use. Creates the bucket, or updates an existing one's cap. When the
 * stored window has already ended, or ends within `opts.graceMs` (default 0)
 * of now, it also resets used to 0 and moves window_end to policy.windowEnd;
 * otherwise used and window_end are left alone. Throws
 * StoreError("STORE_BAD_INPUT") for a key outside 1 to 200 characters, a cap
 * that is not a non-negative safe integer, an invalid date, or a graceMs
 * that is not a whole number from 0 to 86,400,000.
 */
export async function setBucket(db: Db, policy: BucketPolicy, opts: { graceMs?: number } = {}): Promise<void> {
  const key = checkKey(policy.key);
  if (!Number.isSafeInteger(policy.cap) || policy.cap < 0) throw badInput();
  const windowEnd = checkInstant(policy.windowEnd);
  const graceMs = opts.graceMs ?? 0;
  if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 24 * 60 * 60 * 1_000) throw badInput();

  await db.query(
    `INSERT INTO usage_buckets AS b (key, cap, used, window_end)
     VALUES ($1, $2, 0, $3::timestamptz)
     ON CONFLICT (key) DO UPDATE SET
       cap = excluded.cap,
       used = CASE WHEN b.window_end <= $4::timestamptz THEN 0 ELSE b.used END,
       window_end = CASE WHEN b.window_end <= $4::timestamptz THEN excluded.window_end ELSE b.window_end END`,
    [key, policy.cap, windowEnd.toISOString(), new Date(Date.now() + graceMs).toISOString()],
  );
}

/**
 * Reserves every amount or none (C5.1). In one transaction it locks the named
 * buckets in sorted key order, then checks that each exists, has a window_end
 * after `now`, and has room for used + amount <= cap. Only if every check
 * passes are the amounts added. Duplicate keys are summed. Returns false and
 * changes nothing on any failed check, including a missing bucket or an
 * expired window (fail closed, C5.7). Throws StoreError("STORE_BAD_INPUT")
 * unless there are 1 to 8 items, each with a key of 1 to 200 characters and
 * an integer amount from 1 to 1,000,000, and throws
 * StoreError("STORE_UNAVAILABLE") if the database fails. Callers make the
 * metered call only after this returns true.
 */
export async function reserve(db: Db, items: Reservation[], now: Date = new Date()): Promise<boolean> {
  const totals = totalsOf(items);
  checkInstant(now);
  return db.transaction(async (tx) => (await reserveWithin(tx, totals, now)).ok);
}

/**
 * Reads one bucket. Returns null when it is missing or its row fails the
 * bucket schema (C6.5). Throws StoreError("STORE_BAD_INPUT") for a bad key.
 */
export async function usage(
  db: Db,
  key: string,
): Promise<{ used: number; cap: number; windowEnd: Date } | null> {
  const checkedKey = checkKey(key);
  const { rows } = await db.query(
    "SELECT key, cap, used, window_end FROM usage_buckets WHERE key = $1",
    [checkedKey],
  );
  const parsed = bucketRow.safeParse(rows[0]);
  if (!parsed.success) return null;
  return { used: parsed.data.used, cap: parsed.data.cap, windowEnd: parsed.data.window_end };
}

function secondKeyOf(now: Date): string {
  return `${QLOO_SECOND_PREFIX}${Math.floor(now.getTime() / 1_000)}`;
}

// Only qloo:day or a share under it. Any other key could name the month or a
// per-second bucket, and the reservation map would then skip the day share.
function checkDayKey(dayKey: unknown): string {
  if (dayKey === undefined) return QLOO_DAY;
  const key = checkKey(dayKey);
  if (key !== QLOO_DAY && !key.startsWith(`${QLOO_DAY}:`)) throw badInput();
  return key;
}

// A repeated key, or one equal to the day key, would collapse into a single
// entry in the reservation map and be charged once while the caller believes
// it was charged twice, so both are refused.
function checkExtraKeys(extraKeys: unknown, dayKey: string): string[] {
  if (extraKeys === undefined) return [];
  if (!Array.isArray(extraKeys) || extraKeys.length > MAX_EXTRA_KEYS) throw badInput();
  const keys: string[] = [];
  for (const key of extraKeys as unknown[]) {
    if (typeof key !== "string" || !QLOO_EXTRA_KEY.test(key) || key === dayKey || keys.includes(key)) throw badInput();
    keys.push(key);
  }
  return keys;
}

async function tryQlooCall(db: Db, now: Date, dayKey: string, extraKeys: readonly string[]): Promise<Outcome> {
  checkInstant(now);
  const second = secondKeyOf(now);
  return db.transaction(async (tx) => {
    // The per-second row is created before any lock is taken. A second caller
    // creating the same row waits here holding nothing, and an uncommitted row
    // is invisible to every other caller's lock query, so the sorted locking
    // in reserveWithin still cannot form a cycle.
    await tx.query(
      `INSERT INTO usage_buckets (key, cap, used, window_end)
       VALUES ($1, $2, 0, $3::timestamptz) ON CONFLICT (key) DO NOTHING`,
      [second, QLOO_PER_SECOND_CAP, new Date(now.getTime() + SECOND_BUCKET_LIFETIME_MS).toISOString()],
    );
    return reserveWithin(
      tx,
      new Map([
        [QLOO_MONTH, 1],
        [dayKey, 1],
        [second, 1],
        ...extraKeys.map((key): [string, number] => [key, 1]),
      ]),
      now,
    );
  });
}

/**
 * Reserves one Qloo call from qloo:month, the day bucket and the bucket for
 * the current epoch second, all or nothing. The day bucket is qloo:day unless
 * `opts.dayKey` names a share under it, such as "qloo:day:offline" for the
 * offline scripts: that share has its own daily cap but still counts against
 * the one month bucket and the one per-second limit (C5.1). `opts.extraKeys`
 * adds at most 2 more buckets of the form qloo:month:<word> or
 * qloo:day:<word>, reserved in the same all-or-nothing transaction; MCP
 * passes ["qloo:month:mcp"] so its month stays under the shared ceiling
 * (D3.3). The per-second bucket is created on demand with cap 4 inside the
 * same transaction, so every process sharing the database shares one
 * per-second limit (C5.1, C5.2). Returns false if any bucket is full,
 * missing or expired, and then nothing is added anywhere. Throws
 * StoreError("STORE_BAD_INPUT") for an invalid `now`, a dayKey that is not
 * "qloo:day" or "qloo:day:" followed by more, or extraKeys that are not an
 * array of at most 2 distinct matching keys, each different from the day
 * key, and StoreError("STORE_UNAVAILABLE") if the database fails.
 */
export async function reserveQlooCall(
  db: Db,
  now: Date = new Date(),
  opts: { dayKey?: string; extraKeys?: string[] } = {},
): Promise<boolean> {
  const dayKey = checkDayKey(opts.dayKey);
  const extraKeys = checkExtraKeys(opts.extraKeys, dayKey);
  return (await tryQlooCall(db, now, dayKey, extraKeys)).ok;
}

/**
 * Keeps trying reserveQlooCall while only the per-second bucket is full,
 * sleeping until the next second each time. Returns true once a call is
 * reserved. Returns false at once if the day, month or an extra bucket
 * refuses, and false when waiting longer would pass maxWaitMs (default
 * 3000). `dayKey` and `extraKeys` pick the buckets exactly as in
 * reserveQlooCall. Time is measured as the larger of clock time and time
 * slept, so the loop ends even if an injected clock never moves. Throws
 * StoreError("STORE_BAD_INPUT") for a maxWaitMs outside 0 to 60000, a bad
 * dayKey or bad extraKeys, and StoreError("STORE_UNAVAILABLE") if the
 * database fails.
 */
export async function waitForQlooSlot(
  db: Db,
  opts: {
    maxWaitMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => Date;
    dayKey?: string;
    extraKeys?: string[];
  } = {},
): Promise<boolean> {
  const maxWaitMs = opts.maxWaitMs ?? 3_000;
  if (!Number.isFinite(maxWaitMs) || maxWaitMs < 0 || maxWaitMs > MAX_WAIT_LIMIT_MS) throw badInput();
  const dayKey = checkDayKey(opts.dayKey);
  const extraKeys = checkExtraKeys(opts.extraKeys, dayKey);
  const sleep = opts.sleep ?? ((ms: number) => delay(ms));
  const clock = opts.now ?? (() => new Date());

  const startedAt = checkInstant(clock()).getTime();
  let slept = 0;
  for (;;) {
    const now = checkInstant(clock());
    const outcome = await tryQlooCall(db, now, dayKey, extraKeys);
    if (outcome.ok) return true;
    if (!outcome.refused.every((key) => key.startsWith(QLOO_SECOND_PREFIX))) return false;

    const pause = 1_000 - (((now.getTime() % 1_000) + 1_000) % 1_000);
    const waited = Math.max(now.getTime() - startedAt, slept);
    if (waited + pause > maxWaitMs) return false;
    await sleep(pause);
    slept += pause;
  }
}

/**
 * Deletes per-second Qloo buckets whose window ended at or before `now` and
 * returns how many went. Needs DELETE, which the app role vasal_app does not
 * hold, so it runs from an operator script. Throws StoreError("STORE_BAD_INPUT")
 * for an invalid `now` and StoreError("STORE_UNAVAILABLE") if the database
 * fails.
 */
export async function pruneSecondBuckets(db: Db, now: Date = new Date()): Promise<number> {
  checkInstant(now);
  const { rows } = await db.query(
    `WITH gone AS (
       DELETE FROM usage_buckets
       WHERE starts_with(key, $1) AND window_end <= $2::timestamptz
       RETURNING 1
     )
     SELECT count(*)::int AS removed FROM gone`,
    [QLOO_SECOND_PREFIX, now.toISOString()],
  );
  const parsed = count.safeParse(rows[0]?.["removed"]);
  if (!parsed.success) throw new StoreError("STORE_UNAVAILABLE");
  return parsed.data;
}
