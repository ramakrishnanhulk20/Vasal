import type { ZodType } from "zod";
import { cacheGet, cachePut } from "../store/cache.js";
import type { Db } from "../store/db.js";
import { waitForQlooSlot } from "../store/meter.js";
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
 * options.signal goes to `waitForSlot` and then to the client. A cache hit is
 * answered whether or not it has fired, since it spends nothing. A miss
 * after it has fired takes no slot and makes no request, and a wait for a
 * slot ends when it fires, also with no slot taken. A call it cuts off keeps
 * the one slot it took, and the client never retries it. A custom
 * `waitForSlot` honours the signal only if it passes it on.
 *
 * callRaw is the same path for one raw request from Qloo's harness: the key
 * comes from buildRawQlooRequest, the builder client.callRaw sends with, a
 * cached value must still be a JSON object, and on a miss one slot is
 * reserved before client.callRaw makes its single attempt. Its calls and
 * cache hits count in stats with the rest.
 *
 * Throws QlooError("QLOO_BAD_INPUT") for an operation or raw request the
 * builder refuses, before any slot is taken,
 * QlooError("QLOO_BUDGET") with no request made when no slot is free,
 * QlooError("QLOO_TIMEOUT") for a miss once options.signal has fired, any
 * QlooError the client throws, and StoreError when the database fails, so an
 * outage is never mistaken for a miss or a free slot.
 */
export function createMeteredQloo(opts: {
  client: QlooClient;
  db: Db;
  baseUrl: URL;
  ttlMs?: number;
  now?: () => Date;
  waitForSlot?: (db: Db, signal?: AbortSignal) => Promise<boolean>;
}): MeteredQloo & MeteredRawQloo {
  const { client, db, baseUrl } = opts;
  const ttlMs = opts.ttlMs ?? SEVEN_DAYS_MS;
  const clock = opts.now ?? (() => new Date());
  const waitForSlot =
    opts.waitForSlot ?? ((target: Db, signal?: AbortSignal) => waitForQlooSlot(target, signal === undefined ? {} : { signal }));
  let calls = 0;
  let cacheHits = 0;

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

    // Past the caller's deadline nothing is spent, not even a slot.
    const fired = () => options.signal?.aborted === true;
    if (fired()) throw new QlooError("QLOO_TIMEOUT");
    if (!(await waitForSlot(db, options.signal))) throw new QlooError(fired() ? "QLOO_TIMEOUT" : "QLOO_BUDGET");

    // Counted before the await: a call that fails upstream still spent its slot.
    calls += 1;
    const data = await send();
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
