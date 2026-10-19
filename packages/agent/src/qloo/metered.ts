import { cacheGet, cachePut } from "../store/cache.js";
import type { Db } from "../store/db.js";
import { waitForQlooSlot } from "../store/meter.js";
import type { QlooClient } from "./client.js";
import { QlooError } from "./errors.js";
import { buildQlooRequest, type QlooOperation } from "./request.js";
import { NORMALISED_SCHEMAS } from "./schemas.js";

export type MeteredQloo = {
  call<T>(op: QlooOperation): Promise<{ data: T; fromCache: boolean }>;
  stats(): { calls: number; cacheHits: number };
};

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;

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
 * cached (C7.2). `now` sets the clock for cache expiry only. The meter keeps
 * real time, because the per-second limit is about real time.
 *
 * Throws QlooError("QLOO_BAD_INPUT") for an operation the builder refuses,
 * QlooError("QLOO_BUDGET") with no request made when no slot is free, any
 * QlooError the client throws, and StoreError when the database fails, so an
 * outage is never mistaken for a miss or a free slot.
 */
export function createMeteredQloo(opts: {
  client: QlooClient;
  db: Db;
  baseUrl: URL;
  ttlMs?: number;
  now?: () => Date;
  waitForSlot?: (db: Db) => Promise<boolean>;
}): MeteredQloo {
  const { client, db, baseUrl } = opts;
  const ttlMs = opts.ttlMs ?? SEVEN_DAYS_MS;
  const clock = opts.now ?? (() => new Date());
  const waitForSlot = opts.waitForSlot ?? ((target: Db) => waitForQlooSlot(target));
  let calls = 0;
  let cacheHits = 0;

  return {
    async call<T>(op: QlooOperation): Promise<{ data: T; fromCache: boolean }> {
      const { cacheKey } = buildQlooRequest(baseUrl, op);

      const cached = await cacheGet<unknown>(db, cacheKey, NORMALISED_SCHEMAS[op.op], clock());
      if (cached !== null) {
        cacheHits += 1;
        return { data: cached as T, fromCache: true };
      }

      if (!(await waitForSlot(db))) throw new QlooError("QLOO_BUDGET");

      // Counted before the await: a call that fails upstream still spent its slot.
      calls += 1;
      const result = await client.call<T>(op);
      await cachePut(db, cacheKey, result.data, ttlMs, clock());
      return { data: result.data, fromCache: false };
    },

    stats: () => ({ calls, cacheHits }),
  };
}
