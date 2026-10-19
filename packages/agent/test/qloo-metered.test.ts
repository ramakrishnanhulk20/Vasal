// Covers the cache-then-meter-then-network order of the metered Qloo wrapper
// on PGlite with a fake client. It does not cover the real HTTPS client (see
// qloo-client.test.ts), races between connections (PGlite has one), or real
// Qloo response shapes. Every body here is synthetic.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QlooCallResult, QlooClient } from "../src/qloo/client.js";
import { QlooError } from "../src/qloo/errors.js";
import { createMeteredQloo } from "../src/qloo/metered.js";
import { buildQlooRequest, type QlooOperation } from "../src/qloo/request.js";
import { cachePut } from "../src/store/cache.js";
import type { Db } from "../src/store/db.js";
import { setBucket, usage, waitForQlooSlot } from "../src/store/meter.js";
import { migratedPglite } from "./helpers/pglite.js";

const BASE = new URL("https://hackathon.api.qloo.com");
const NOW = new Date("2026-10-19T12:00:00.000Z");
const FAR_FUTURE = new Date("2099-01-01T00:00:00.000Z");
const SHOW_ID = "00000000-0000-4000-8000-000000000001";
const OP: QlooOperation = { op: "insights", filterType: "urn:entity:person", signalEntities: [SHOW_ID], take: 20 };
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
