import { setTimeout as delay } from "node:timers/promises";
import type { ZodType } from "zod";
import { cacheGet, cachePut } from "../store/cache.js";
import type { Db } from "../store/db.js";
import { waitForQlooSlot } from "../store/meter.js";
import { QLOO_QUOTA_FLOOR, quotaAllows } from "../store/quota.js";
import { buildRawQlooRequest, RawQlooBody, type QlooCallOptions, type QlooClient, type RawQlooRequest } from "./client.js";
import { QlooError } from "./errors.js";
import { buildQlooRequest, type QlooOperation } from "./request.js";
import { NORMALISED_SCHEMAS } from "./schemas.js";

export type MeteredQloo = {
  call<T>(op: QlooOperation, options?: QlooCallOptions): Promise<{ data: T; fromCache: boolean }>;
  stats(): { calls: number; cacheHits: number };
};

/** The metered path for one raw request from Qloo's harness (see createMeteredQloo). */
export type MeteredRawQloo = {
  callRaw(request: RawQlooRequest, options?: QlooCallOptions): Promise<{ data: RawQlooBody; fromCache: boolean }>;
};

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;
// The pause before each retry, so a call makes at most 3 attempts (C5.2).
const RETRY_PAUSES_MS = [250, 750] as const;
// Only a refusal that may clear on its own is worth another slot. Auth, a
// forbidden type, bad input and a schema failure would fail the same way.
const isRetried = (error: unknown): boolean => error instanceof QlooError && (error.code === "QLOO_RATE_LIMIT" || error.code === "QLOO_UPSTREAM");
// A function, not a property read, so each check sees the signal as it is now.
const fired = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

/**
 * Wraps the Qloo client with the shared cache and the shared budget, so every
 * Qloo call in a run goes cache first, then meter, then network.
 *
 * For each call: the cache key comes from buildQlooRequest, the same builder
 * the client sends with (C7.1). A cached value is returned only if it still
 * passes the normalised schema for its operation (C6.5). On a miss, one slot
 * is reserved through `waitForSlot` (default waitForQlooSlot, which holds the
 * day, month and per-second caps across every process, C5.1 and C5.2), and
 * only then is the client called. The result is cached for `ttlMs` (default 7
 * days) only after the client returned parsed data; a failed call is never
 * cached (C7.2). `now` sets the clock for cache expiry and for the age of the
 * stored Qloo count. The meter keeps real time, because the per-second limit
 * is about real time.
 *
 * Qloo's own monthly count has the last word, because it also counts calls
 * this meter never sees. Before every slot a miss takes, retries included,
 * the stored count is checked with quotaAllows, the same rule the probe
 * uses. When there is one, it was seen less than 24 hours before `now`, and
 * its remaining is below `quotaFloor` (default QLOO_QUOTA_FLOOR, 1,500), the
 * call ends with QLOO_BUDGET, with no slot taken and no request.
 * No stored count, or one that fails its schema, means no check, as on a
 * fresh database. A cache hit is answered whatever the count. The count stays
 * current only when the caller wires the client's onQuota to recordQuota on
 * the same database, as every caller does:
 *
 *   const client = createQlooClient({ apiKey, baseUrl, maxRetries: 0, onQuota: (quota) => recordQuota(db, quota) });
 *   const qloo = createMeteredQloo({ client, db, baseUrl });
 *
 * A client call that fails with QLOO_RATE_LIMIT or QLOO_UPSTREAM is tried at
 * most 2 more times (C5.2): it sleeps 250 ms before the first retry and 750
 * ms before the second, then takes a fresh slot through `waitForSlot`, so
 * every attempt holds its own slot and counts in stats.calls. A refused slot
 * ends the call with QLOO_BUDGET and a slot wait the signal ends with
 * QLOO_TIMEOUT, either way with no further request. Any other code is never
 * retried, and the last failure is the one thrown. `sleep` replaces the wait
 * in tests.
 *
 * options.signal goes to `waitForSlot`, to the pause before a retry and to
 * the client. A cache hit is answered whether or not it has fired, since it
 * spends nothing. A miss after it has fired takes no slot and makes no
 * request, and a wait for a slot ends when it fires, also with no slot taken.
 * Once it has fired no retry starts: a pause it cuts short ends the call with
 * QLOO_TIMEOUT and no further slot. A call it cuts off keeps the slot it
 * took. A custom `waitForSlot` or `sleep` honours the signal only if it
 * passes it on.
 *
 * callRaw is the same path for one raw request from Qloo's harness: the key
 * comes from buildRawQlooRequest, the builder client.callRaw sends with, a
 * cached value must still be a JSON object, and on a miss one slot is
 * reserved before each attempt client.callRaw makes, retried as above. Its
 * calls and cache hits count in stats with the rest.
 *
 * Building throws QlooError("QLOO_BAD_INPUT") for a quotaFloor that is not
 * a whole number from 0. A call throws QlooError("QLOO_BAD_INPUT") for an
 * operation or raw request the builder refuses, before any slot is taken,
 * and again after one slot for a Qloo 4xx other than 401, 403, 404 and 429,
 * which is never retried, QlooError("QLOO_BUDGET") with no further request made when no slot is free
 * or Qloo's own count is under the floor,
 * QlooError("QLOO_TIMEOUT") for a miss or a retry once options.signal has
 * fired, any QlooError the client throws, and StoreError when the database
 * fails, so an outage is never mistaken for a miss, a free slot or no count.
 */
export function createMeteredQloo(opts: {
  client: QlooClient;
  db: Db;
  baseUrl: URL;
  ttlMs?: number;
  now?: () => Date;
  waitForSlot?: (db: Db, signal?: AbortSignal) => Promise<boolean>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  quotaFloor?: number;
}): MeteredQloo & MeteredRawQloo {
  const { client, db, baseUrl } = opts;
  const ttlMs = opts.ttlMs ?? SEVEN_DAYS_MS;
  const quotaFloor = opts.quotaFloor ?? QLOO_QUOTA_FLOOR;
  // NaN or a fraction would compare false against every count and let every call through.
  if (!Number.isSafeInteger(quotaFloor) || quotaFloor < 0) throw new QlooError("QLOO_BAD_INPUT");
  const clock = opts.now ?? (() => new Date());
  const waitForSlot =
    opts.waitForSlot ?? ((target: Db, signal?: AbortSignal) => waitForQlooSlot(target, signal === undefined ? {} : { signal }));
  const sleep = opts.sleep ?? ((ms: number, signal?: AbortSignal) => (signal === undefined ? delay(ms) : delay(ms, undefined, { signal })));
  let calls = 0;
  let cacheHits = 0;

  // Past the caller's deadline nothing is spent, not even a slot.
  async function takeSlot(signal: AbortSignal | undefined): Promise<void> {
    if (fired(signal)) throw new QlooError("QLOO_TIMEOUT");
    if (!(await quotaAllows(db, quotaFloor, clock()))) throw new QlooError("QLOO_BUDGET");
    if (!(await waitForSlot(db, signal))) throw new QlooError(fired(signal) ? "QLOO_TIMEOUT" : "QLOO_BUDGET");
  }

  // Every attempt holds its own slot, so the meter counts each request the
  // client makes, retries included (C5.1).
  async function sendWithRetries(signal: AbortSignal | undefined, send: () => Promise<unknown>): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      // Counted before the await: a call that fails upstream still spent its slot.
      calls += 1;
      try {
        return await send();
      } catch (error) {
        const pause = RETRY_PAUSES_MS[attempt];
        if (pause === undefined || !isRetried(error) || fired(signal)) throw error;
        try {
          await sleep(pause, signal);
        } catch (stopped) {
          if (fired(signal)) throw new QlooError("QLOO_TIMEOUT");
          throw stopped;
        }
      }
      await takeSlot(signal);
    }
  }

  // The one order both call shapes follow: cache, then meter, then network.
  async function spend(
    cacheKey: string,
    schema: ZodType<unknown>,
    options: QlooCallOptions,
    send: () => Promise<unknown>,
  ): Promise<{ data: unknown; fromCache: boolean }> {
    const cached = await cacheGet<unknown>(db, cacheKey, schema, clock());
    if (cached !== null) {
      cacheHits += 1;
      return { data: cached, fromCache: true };
    }

    await takeSlot(options.signal);
    const data = await sendWithRetries(options.signal, send);
    await cachePut(db, cacheKey, data, ttlMs, clock());
    return { data, fromCache: false };
  }

  return {
    async call<T>(op: QlooOperation, options: QlooCallOptions = {}): Promise<{ data: T; fromCache: boolean }> {
      const { cacheKey } = buildQlooRequest(baseUrl, op);
      const result = await spend(cacheKey, NORMALISED_SCHEMAS[op.op], options, async () => (await client.call<T>(op, options)).data);
      return result as { data: T; fromCache: boolean };
    },

    async callRaw(request: RawQlooRequest, options: QlooCallOptions = {}): Promise<{ data: RawQlooBody; fromCache: boolean }> {
      const { cacheKey } = buildRawQlooRequest(baseUrl, request);
      const result = await spend(cacheKey, RawQlooBody, options, async () => (await client.callRaw(request, options)).data);
      return result as { data: RawQlooBody; fromCache: boolean };
    },

    stats: () => ({ calls, cacheHits }),
  };
}
