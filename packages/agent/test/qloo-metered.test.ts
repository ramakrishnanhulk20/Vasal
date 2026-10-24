// Covers the cache-then-meter-then-network order of the metered Qloo wrapper
// on PGlite with a fake client, and, with the real client over a fake fetch,
// what a call's signal spends when it fires. It does not cover the rest of
// the real HTTPS client (see qloo-client.test.ts), races between connections
// (PGlite has one), or real Qloo response shapes. Every body here is synthetic.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQlooClient, type QlooCallResult, type QlooClient } from "../src/qloo/client.js";
import { QlooError } from "../src/qloo/errors.js";
import { createMeteredQloo } from "../src/qloo/metered.js";
import { buildQlooRequest, type QlooOperation } from "../src/qloo/request.js";
import { cachePut } from "../src/store/cache.js";
import type { Db } from "../src/store/db.js";
import { QLOO_PER_SECOND_CAP, reserveQlooCall, setBucket, usage, waitForQlooSlot } from "../src/store/meter.js";
import { migratedPglite } from "./helpers/pglite.js";

const BASE = new URL("https://hackathon.api.qloo.com");
const NOW = new Date("2026-10-19T12:00:00.000Z");
const FAR_FUTURE = new Date("2099-01-01T00:00:00.000Z");
const SHOW_ID = "00000000-0000-4000-8000-000000000001";
const OP: QlooOperation = { op: "insights", filterType: "urn:entity:person", signalEntities: [SHOW_ID], take: 20 };
const CACHED_OP: QlooOperation = { op: "insights", filterType: "urn:entity:person", signalEntities: [SHOW_ID], take: 10 };
const SYNTH_PEOPLE = [
  { entity_id: "00000000-0000-4000-8000-000000000011", name: "Synthetic Person 1", popularity: 0.4, query: { affinity: 0.9 } },
  { entity_id: "00000000-0000-4000-8000-000000000012", name: "Synthetic Person 2", popularity: 0.6, query: { affinity: 0.8 } },
];

let db: Db;

beforeEach(async () => {
  db = await migratedPglite();
  await setBucket(db, { key: "qloo:day", cap: 100, windowEnd: FAR_FUTURE });
  await setBucket(db, { key: "qloo:month", cap: 1_000, windowEnd: FAR_FUTURE });
});

afterEach(async () => {
  await db.close();
});

function fakeClient(script: Array<() => unknown>) {
  const ops: QlooOperation[] = [];
  const client: QlooClient = {
    async call<T>(op: QlooOperation): Promise<QlooCallResult<T>> {
      ops.push(op);
      const step = script[Math.min(ops.length - 1, script.length - 1)];
      if (step === undefined) throw new Error("empty script");
      return { data: step() as T, request: { path: "/v2/insights", params: [] }, status: 200, durationMs: 1 };
    },
    // The raw path's cache and meter are covered in qloo-harness-adapter.test.ts.
    async callRaw() {
      throw new Error("callRaw is not used here");
    },
  };
  return { client, ops };
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

async function cacheRows(): Promise<number> {
  const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM qloo_cache");
  return rows[0]?.n ?? -1;
}

describe("createMeteredQloo", () => {
  it("serves a second identical op from the cache with no client call and no slot taken", async () => {
    const { client, ops } = fakeClient([() => SYNTH_PEOPLE]);
    let slots = 0;
    const qloo = createMeteredQloo({
      client,
      db,
      baseUrl: BASE,
      now: () => NOW,
      waitForSlot: async (target) => {
        slots += 1;
        return waitForQlooSlot(target);
      },
    });

    const first = await qloo.call(OP);
    const second = await qloo.call(OP);

    expect(first).toEqual({ data: SYNTH_PEOPLE, fromCache: false });
    expect(second).toEqual({ data: SYNTH_PEOPLE, fromCache: true });
    expect(ops).toHaveLength(1);
    expect(slots).toBe(1);
    expect((await usage(db, "qloo:day"))?.used).toBe(1);
    expect(qloo.stats()).toEqual({ calls: 1, cacheHits: 1 });
  });

  it("throws QLOO_BUDGET and never calls the client when the meter refuses (C5.1)", async () => {
    await setBucket(db, { key: "qloo:day", cap: 0, windowEnd: FAR_FUTURE });
    const { client, ops } = fakeClient([() => SYNTH_PEOPLE]);
    const qloo = createMeteredQloo({ client, db, baseUrl: BASE, now: () => NOW });

    const error = await errorOf(qloo.call(OP));

    expect(error).toBeInstanceOf(QlooError);
    expect((error as QlooError).code).toBe("QLOO_BUDGET");
    expect(ops).toHaveLength(0);
    expect(await cacheRows()).toBe(0);
    expect(qloo.stats()).toEqual({ calls: 0, cacheHits: 0 });
  });

  it("never caches a client error, so the next identical op calls again (C7.2)", async () => {
    const { client, ops } = fakeClient([
      () => {
        throw new QlooError("QLOO_UPSTREAM", 502);
      },
      () => SYNTH_PEOPLE,
    ]);
    const qloo = createMeteredQloo({ client, db, baseUrl: BASE, now: () => NOW });

    const error = await errorOf(qloo.call(OP));
    expect((error as QlooError).code).toBe("QLOO_UPSTREAM");
    expect(await cacheRows()).toBe(0);

    const retry = await qloo.call(OP);

    expect(retry).toEqual({ data: SYNTH_PEOPLE, fromCache: false });
    expect(ops).toHaveLength(2);
    expect(await cacheRows()).toBe(1);
    expect(qloo.stats()).toEqual({ calls: 2, cacheHits: 0 });
  });

  it("treats a cached row that fails its operation's schema as a miss (C6.5)", async () => {
    const { cacheKey } = buildQlooRequest(BASE, OP);
    await cachePut(db, cacheKey, [{ entity_id: 42, name: null }], 60_000, NOW);
    const { client, ops } = fakeClient([() => SYNTH_PEOPLE]);
    const qloo = createMeteredQloo({ client, db, baseUrl: BASE, now: () => NOW });

    const result = await qloo.call(OP);

    expect(result).toEqual({ data: SYNTH_PEOPLE, fromCache: false });
    expect(ops).toHaveLength(1);
    expect((await usage(db, "qloo:day"))?.used).toBe(1);
  });

  it("treats an expired entry as a miss once its ttl has passed", async () => {
    let now = NOW;
    const { client, ops } = fakeClient([() => SYNTH_PEOPLE]);
    const qloo = createMeteredQloo({ client, db, baseUrl: BASE, ttlMs: 60_000, now: () => now });

    await qloo.call(OP);
    now = new Date(NOW.getTime() + 60_000);
    const later = await qloo.call(OP);

    expect(later.fromCache).toBe(false);
    expect(ops).toHaveLength(2);
  });

  it("keeps the one slot a call cut off by its signal took, never retries it, and takes no slot once the signal has fired (C5.1, C5.2)", async () => {
    const hanging = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const client = createQlooClient({
      apiKey: "FAKE-KEY-metered",
      baseUrl: BASE,
      fetchImpl: hanging as unknown as typeof fetch,
      timeoutMs: 2_000,
      maxRetries: 2,
      sleep: async () => undefined,
    });
    const qloo = createMeteredQloo({ client, db, baseUrl: BASE, now: () => NOW });
    const deadline = new AbortController();
    setTimeout(() => deadline.abort(), 20);
    const started = Date.now();

    const cut = await errorOf(qloo.call(OP, { signal: deadline.signal }));

    expect((cut as QlooError).code).toBe("QLOO_TIMEOUT");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(hanging).toHaveBeenCalledTimes(1);
    expect((await usage(db, "qloo:day"))?.used).toBe(1);

    const after = await errorOf(qloo.call(OP, { signal: deadline.signal }));

    expect((after as QlooError).code).toBe("QLOO_TIMEOUT");
    expect(hanging).toHaveBeenCalledTimes(1);
    expect((await usage(db, "qloo:day"))?.used).toBe(1);
    expect(await cacheRows()).toBe(0);

    // A cache hit needs no slot and no request, so it is still answered.
    await cachePut(db, buildQlooRequest(BASE, CACHED_OP).cacheKey, SYNTH_PEOPLE, 60_000, NOW);
    expect(await qloo.call(CACHED_OP, { signal: deadline.signal })).toEqual({ data: SYNTH_PEOPLE, fromCache: true });
    expect((await usage(db, "qloo:day"))?.used).toBe(1);
    expect(qloo.stats()).toEqual({ calls: 1, cacheHits: 1 });
  });

  it("rejects with QLOO_TIMEOUT, takes no slot and sends nothing when the signal fires during the wait for a slot", async () => {
    // Four seconds in a row are full, so the real clock lands on a full one
    // however long the filling takes, and the default wait has to sleep.
    const second = Math.floor(Date.now() / 1_000) * 1_000;
    for (let s = 0; s < 4; s += 1) {
      for (let i = 0; i < QLOO_PER_SECOND_CAP; i += 1) expect(await reserveQlooCall(db, new Date(second + s * 1_000))).toBe(true);
    }
    const filled = (await usage(db, "qloo:day"))?.used;
    const { client, ops } = fakeClient([() => SYNTH_PEOPLE]);
    const qloo = createMeteredQloo({ client, db, baseUrl: BASE, now: () => NOW });
    const deadline = new AbortController();
    setTimeout(() => deadline.abort(), 20);
    const started = Date.now();

    const error = await errorOf(qloo.call(OP, { signal: deadline.signal }));

    expect((error as QlooError).code).toBe("QLOO_TIMEOUT");
    expect(Date.now() - started).toBeLessThan(500);
    expect(ops).toHaveLength(0);
    expect((await usage(db, "qloo:day"))?.used).toBe(filled);
    expect(qloo.stats()).toEqual({ calls: 0, cacheHits: 0 });
  });

  it("refuses an operation the request builder rejects before any slot or call", async () => {
    const { client, ops } = fakeClient([() => SYNTH_PEOPLE]);
    let slots = 0;
    const qloo = createMeteredQloo({
      client,
      db,
      baseUrl: BASE,
      waitForSlot: async () => {
        slots += 1;
        return true;
      },
    });

    const error = await errorOf(qloo.call({ op: "search", query: "x", types: ["urn:entity:person"], take: 500 }));

    expect((error as QlooError).code).toBe("QLOO_BAD_INPUT");
    expect(slots).toBe(0);
    expect(ops).toHaveLength(0);
  });
});
