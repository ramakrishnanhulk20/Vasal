// Covers the cache-then-meter-then-network order of the metered Qloo wrapper
// on PGlite with a fake client, its retry of a 429 or 5xx on a fresh slot,
// its refusal under Qloo's own stored monthly count, and, with the real
// client over a fake fetch, what a call's signal spends when it fires and how
// a reply's count stops the next attempt. It does not cover Retry-After,
// which the retry does not read, the rest of the real HTTPS client (see
// qloo-client.test.ts), races between connections (PGlite has one), two
// processes on separate databases, or real Qloo response shapes and headers.
// Every body here is synthetic.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQlooClient, type QlooCallResult, type QlooClient } from "../src/qloo/client.js";
import { QlooError } from "../src/qloo/errors.js";
import { createMeteredQloo } from "../src/qloo/metered.js";
import { buildQlooRequest, type QlooOperation } from "../src/qloo/request.js";
import { cachePut } from "../src/store/cache.js";
import type { Db } from "../src/store/db.js";
import { QLOO_PER_SECOND_CAP, reserveQlooCall, setBucket, usage, waitForQlooSlot } from "../src/store/meter.js";
import { recordQuota } from "../src/store/quota.js";
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
        throw new QlooError("QLOO_SCHEMA");
      },
      () => SYNTH_PEOPLE,
    ]);
    const qloo = createMeteredQloo({ client, db, baseUrl: BASE, now: () => NOW });

    const error = await errorOf(qloo.call(OP));
    expect((error as QlooError).code).toBe("QLOO_SCHEMA");
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

  describe("retries (C5.2)", () => {
    const failWith = (code: "QLOO_RATE_LIMIT" | "QLOO_UPSTREAM" | "QLOO_AUTH", status: number) => () => {
      throw new QlooError(code, status);
    };

    function counted(script: Array<() => unknown>) {
      const { client, ops } = fakeClient(script);
      const sleeps: number[] = [];
      const slots = { taken: 0 };
      const qloo = createMeteredQloo({
        client,
        db,
        baseUrl: BASE,
        now: () => NOW,
        waitForSlot: async (target, signal) => {
          slots.taken += 1;
          return waitForQlooSlot(target, signal === undefined ? {} : { signal });
        },
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      });
      return { qloo, ops, sleeps, slots };
    }

    it("gives the data after a 429, with a fresh slot for the second attempt", async () => {
      const { qloo, ops, sleeps, slots } = counted([failWith("QLOO_RATE_LIMIT", 429), () => SYNTH_PEOPLE]);

      expect(await qloo.call(OP)).toEqual({ data: SYNTH_PEOPLE, fromCache: false });

      expect([ops.length, slots.taken, sleeps]).toEqual([2, 2, [250]]);
      expect((await usage(db, "qloo:day"))?.used).toBe(2);
      expect(qloo.stats()).toEqual({ calls: 2, cacheHits: 0 });
      expect(await cacheRows()).toBe(1);
    });

    it("gives QLOO_UPSTREAM after three 5xx, with 3 slots taken and nothing cached", async () => {
      const { qloo, ops, sleeps, slots } = counted([failWith("QLOO_UPSTREAM", 503)]);

      expect(((await errorOf(qloo.call(OP))) as QlooError).code).toBe("QLOO_UPSTREAM");

      expect([ops.length, slots.taken, sleeps]).toEqual([3, 3, [250, 750]]);
      expect(qloo.stats()).toEqual({ calls: 3, cacheHits: 0 });
      expect(await cacheRows()).toBe(0);
    });

    it("never retries QLOO_AUTH", async () => {
      const { qloo, ops, sleeps, slots } = counted([failWith("QLOO_AUTH", 401), () => SYNTH_PEOPLE]);

      expect(((await errorOf(qloo.call(OP))) as QlooError).code).toBe("QLOO_AUTH");

      expect([ops.length, slots.taken, sleeps]).toEqual([1, 1, []]);
    });

    it("spends exactly one slot and one request on a Qloo 400, through the real client (audit R2)", async () => {
      let sent = 0;
      const fetchImpl = (async () => {
        sent += 1;
        return new Response(JSON.stringify({ error: "synthetic bad request" }), { status: 400 });
      }) as unknown as typeof fetch;
      const client = createQlooClient({ apiKey: "FAKE-KEY-400", baseUrl: BASE, fetchImpl, maxRetries: 0 });
      let slots = 0;
      const qloo = createMeteredQloo({
        client,
        db,
        baseUrl: BASE,
        now: () => NOW,
        waitForSlot: async (target, signal) => {
          slots += 1;
          return waitForQlooSlot(target, signal === undefined ? {} : { signal });
        },
        sleep: async () => undefined,
      });

      const error = await errorOf(qloo.call(OP));

      expect(error).toMatchObject({ code: "QLOO_BAD_INPUT", status: 400 });
      expect([sent, slots]).toEqual([1, 1]);
      expect((await usage(db, "qloo:day"))?.used).toBe(1);
      expect(await cacheRows()).toBe(0);
    });

    it("ends the call when a retry finds no slot, with no further request", async () => {
      await setBucket(db, { key: "qloo:day", cap: 1, windowEnd: FAR_FUTURE });
      const { qloo, ops, slots } = counted([failWith("QLOO_RATE_LIMIT", 429), () => SYNTH_PEOPLE]);

      expect(((await errorOf(qloo.call(OP))) as QlooError).code).toBe("QLOO_BUDGET");

      expect([ops.length, slots.taken]).toEqual([1, 2]);
      expect((await usage(db, "qloo:day"))?.used).toBe(1);
    });

    it("stops with QLOO_TIMEOUT and takes no further slot when the signal fires during the pause", async () => {
      const { client, ops } = fakeClient([failWith("QLOO_RATE_LIMIT", 429), () => SYNTH_PEOPLE]);
      let slots = 0;
      const qloo = createMeteredQloo({
        client,
        db,
        baseUrl: BASE,
        now: () => NOW,
        waitForSlot: async (target, signal) => {
          slots += 1;
          return waitForQlooSlot(target, signal === undefined ? {} : { signal });
        },
      });
      const deadline = new AbortController();
      setTimeout(() => deadline.abort(), 20);
      const started = Date.now();

      const error = await errorOf(qloo.call(OP, { signal: deadline.signal }));

      expect((error as QlooError).code).toBe("QLOO_TIMEOUT");
      expect(Date.now() - started).toBeLessThan(250);
      expect([ops.length, slots]).toEqual([1, 1]);
      expect((await usage(db, "qloo:day"))?.used).toBe(1);
      expect(qloo.stats()).toEqual({ calls: 1, cacheHits: 0 });
    });
  });

  describe("Qloo's own monthly count", () => {
    const HOUR_MS = 60 * 60 * 1_000;
    // recordQuota stamps the database's own time, which is after NOW, so the
    // reading is fresh to this meter's clock until stampedAt moves it.
    const seen = (remaining: number) => recordQuota(db, { remaining, limit: 50_000, seenAt: NOW });
    const stampedAt = (at: Date) => db.query("UPDATE qloo_quota SET seen_at = $1::timestamptz", [at.toISOString()]);

    function watched(opts: { quotaFloor?: number } = {}) {
      const { client, ops } = fakeClient([() => SYNTH_PEOPLE]);
      const slots = { taken: 0 };
      const qloo = createMeteredQloo({
        client,
        db,
        baseUrl: BASE,
        now: () => NOW,
        waitForSlot: async (target, signal) => {
          slots.taken += 1;
          return waitForQlooSlot(target, signal === undefined ? {} : { signal });
        },
        ...opts,
      });
      return { qloo, ops, slots };
    }

    it("refuses a miss with QLOO_BUDGET when 1,499 remain, with no slot taken and no request", async () => {
      await seen(1_499);
      const { qloo, ops, slots } = watched();

      expect(((await errorOf(qloo.call(OP))) as QlooError).code).toBe("QLOO_BUDGET");

      expect([ops.length, slots.taken]).toEqual([0, 0]);
      expect((await usage(db, "qloo:day"))?.used).toBe(0);
      expect(qloo.stats()).toEqual({ calls: 0, cacheHits: 0 });
    });

    it("lets a miss through when exactly 1,500 remain", async () => {
      await seen(1_500);
      const { qloo, ops, slots } = watched();

      expect(await qloo.call(OP)).toEqual({ data: SYNTH_PEOPLE, fromCache: false });
      expect([ops.length, slots.taken]).toEqual([1, 1]);
    });

    it("ignores a count under the floor seen 25 hours ago, as after Qloo's reset, while one seen 23 hours ago still refuses", async () => {
      await seen(0);
      await stampedAt(new Date(NOW.getTime() - 25 * HOUR_MS));
      const { qloo, ops } = watched();
      expect(await qloo.call(OP)).toEqual({ data: SYNTH_PEOPLE, fromCache: false });
      expect(ops).toHaveLength(1);

      await stampedAt(new Date(NOW.getTime() - 23 * HOUR_MS));
      expect(((await errorOf(qloo.call(CACHED_OP))) as QlooError).code).toBe("QLOO_BUDGET");
      expect(ops).toHaveLength(1);
    });

    it("lets a miss through when no count has been stored, as on a fresh database", async () => {
      const { qloo, ops, slots } = watched();

      expect(await qloo.call(OP)).toEqual({ data: SYNTH_PEOPLE, fromCache: false });
      expect([ops.length, slots.taken]).toEqual([1, 1]);
    });

    it("answers a cache hit even when the count is under the floor", async () => {
      await cachePut(db, buildQlooRequest(BASE, CACHED_OP).cacheKey, SYNTH_PEOPLE, 60_000, NOW);
      await seen(0);
      const { qloo, ops, slots } = watched();

      expect(await qloo.call(CACHED_OP)).toEqual({ data: SYNTH_PEOPLE, fromCache: true });
      expect([ops.length, slots.taken]).toEqual([0, 0]);
      expect(qloo.stats()).toEqual({ calls: 0, cacheHits: 1 });
    });

    it("takes its floor from quotaFloor, and refuses a floor that is not a whole number from 0", async () => {
      await seen(99);
      expect(((await errorOf(watched({ quotaFloor: 100 }).qloo.call(OP))) as QlooError).code).toBe("QLOO_BUDGET");
      expect(await watched({ quotaFloor: 99 }).qloo.call(OP)).toEqual({ data: SYNTH_PEOPLE, fromCache: false });

      for (const quotaFloor of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => watched({ quotaFloor })).toThrow(expect.objectContaining({ code: "QLOO_BAD_INPUT" }));
      }
    });

    it("stops the retry when the 429 before it reported 1,499 left, through the client's onQuota wired to recordQuota", async () => {
      const replies = [
        () => new Response("{}", { status: 429, headers: { "X-Month-RateLimit-Remaining": "1499", "X-Month-RateLimit-Limit": "50000" } }),
        () => new Response(JSON.stringify({ results: { entities: SYNTH_PEOPLE } }), { status: 200 }),
      ];
      let sent = 0;
      const fetchImpl = (async () => replies[sent++]!()) as unknown as typeof fetch;
      const client = createQlooClient({ apiKey: "FAKE-KEY-quota", baseUrl: BASE, fetchImpl, maxRetries: 0, onQuota: (quota) => recordQuota(db, quota) });
      // The client stamps each count with real time, so the meter keeps real time here too.
      const qloo = createMeteredQloo({ client, db, baseUrl: BASE, sleep: async () => undefined });

      expect(((await errorOf(qloo.call(OP))) as QlooError).code).toBe("QLOO_BUDGET");

      expect(sent).toBe(1);
      expect((await usage(db, "qloo:day"))?.used).toBe(1);
      expect(await cacheRows()).toBe(0);
    });
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
