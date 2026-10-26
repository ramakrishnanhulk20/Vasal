// Covers the HTTPS client against a fake fetch, its reading of Qloo's monthly
// quota headers, the response schemas against hand-written synthetic bodies,
// and config loading from a plain object. It does not cover the real Qloo
// host, real response shapes or real quota headers (only the live probe can),
// storing the quota (store-quota.test.ts), the repo-root .env file, or rate
// limiting across processes.
import { describe, expect, it, vi } from "vitest";
import { loadQlooConfig } from "../src/config.js";
import { createQlooClient } from "../src/qloo/client.js";
import { QlooError } from "../src/qloo/errors.js";
import type { QlooOperation } from "../src/qloo/request.js";
import { parseQlooResponse } from "../src/qloo/schemas.js";

const FAKE_KEY = "FAKE-KEY-must-never-leak-7f3a9c";
const BASE = new URL("https://hackathon.api.qloo.com");
const SYNTH_ID = "00000000-0000-4000-8000-000000000001";
const SEARCH: QlooOperation = { op: "search", query: "Synthetic Show", types: ["urn:entity:podcast"], take: 5 };

const synthEntity = (n: number) => ({
  entity_id: `00000000-0000-4000-8000-00000000000${n}`,
  name: `Synthetic Entity ${n}`,
  popularity: 0.5,
  query: { affinity: 0.9 },
});

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

type Captured = { url: URL; init: RequestInit };

function scriptedFetch(script: Array<() => Response | Promise<Response>>) {
  const captured: Captured[] = [];
  let index = 0;
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: new URL(String(input)), init: init ?? {} });
    const next = script[Math.min(index, script.length - 1)];
    index += 1;
    if (next === undefined) throw new Error("empty script");
    return next();
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls: fetchImpl, captured };
}

async function failureOf(promise: Promise<unknown>): Promise<QlooError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof QlooError) return error;
    throw new Error(`expected a QlooError, got ${String(error)}`);
  }
  throw new Error("expected the call to fail");
}

function expectNoKey(value: unknown) {
  const text = value instanceof Error ? `${value.message}\n${String(value)}\n${value.stack ?? ""}\n${JSON.stringify(value)}` : JSON.stringify(value);
  expect(text).not.toContain(FAKE_KEY);
}

describe("createQlooClient", () => {
  it("succeeds after exactly 2 retries when 429 with Retry-After: 1 comes twice, then 200", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      () => json(429, {}, { "retry-after": "1" }),
      () => json(429, {}, { "retry-after": "1" }),
      () => json(200, { results: [synthEntity(1)] }),
    ]);
    const sleep = vi.fn(async (_ms: number) => undefined);
    const client = createQlooClient({ apiKey: FAKE_KEY, baseUrl: BASE, fetchImpl, sleep });

    const result = await client.call(SEARCH);

    expect(calls).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 1000]);
    expect(result.status).toBe(200);
    expect(result.data).toEqual([synthEntity(1)]);
  });

  it("ends in QLOO_RATE_LIMIT after 429 three times", async () => {
    const { fetchImpl, calls } = scriptedFetch([() => json(429, {}, { "retry-after": "1" })]);
    const sleep = vi.fn(async (_ms: number) => undefined);
    const client = createQlooClient({ apiKey: FAKE_KEY, baseUrl: BASE, fetchImpl, sleep });

    const error = await failureOf(client.call(SEARCH));

    expect(error.code).toBe("QLOO_RATE_LIMIT");
    expect(error.status).toBe(429);
    expect(calls).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("backs off 500 ms then 1500 ms on 5xx without Retry-After, and caps Retry-After at 10 s", async () => {
    const backoff = scriptedFetch([() => json(503, {}), () => json(502, {}), () => json(200, { results: [] })]);
    const backoffSleep = vi.fn(async (_ms: number) => undefined);
    await createQlooClient({ apiKey: FAKE_KEY, baseUrl: BASE, fetchImpl: backoff.fetchImpl, sleep: backoffSleep }).call(SEARCH);
    expect(backoffSleep.mock.calls.map(([ms]) => ms)).toEqual([500, 1500]);

    const capped = scriptedFetch([() => json(429, {}, { "retry-after": "120" }), () => json(200, { results: [] })]);
    const cappedSleep = vi.fn(async (_ms: number) => undefined);
    await createQlooClient({ apiKey: FAKE_KEY, baseUrl: BASE, fetchImpl: capped.fetchImpl, sleep: cappedSleep }).call(SEARCH);
    expect(cappedSleep.mock.calls.map(([ms]) => ms)).toEqual([10_000]);
  });

  it("maps 401, 403, 404, other 4xx, 408 and exhausted 5xx to fixed codes, retrying only 408 and the 5xx", async () => {
    const cases: Array<[number, string, number]> = [
      [401, "QLOO_AUTH", 1],
      [403, "QLOO_FORBIDDEN_TYPE", 1],
      [404, "QLOO_NOT_FOUND", 1],
      [400, "QLOO_BAD_INPUT", 1],
      [409, "QLOO_BAD_INPUT", 1],
      [422, "QLOO_BAD_INPUT", 1],
      [408, "QLOO_UPSTREAM", 3],
      [500, "QLOO_UPSTREAM", 3],
    ];
    for (const [status, code, attempts] of cases) {
      const { fetchImpl, calls } = scriptedFetch([() => json(status, { error: { message: "synthetic upstream text" } })]);
      const client = createQlooClient({ apiKey: FAKE_KEY, baseUrl: BASE, fetchImpl, sleep: async () => undefined });
      const error = await failureOf(client.call(SEARCH));
      expect(error.code).toBe(code);
      expect(error.status).toBe(status);
      expect(error.message).not.toContain("synthetic upstream text");
      expect(calls).toHaveBeenCalledTimes(attempts);
    }
  });

  it("turns an aborted request into QLOO_TIMEOUT and a network failure into QLOO_UPSTREAM, without retrying", async () => {
    const hanging = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const slow = createQlooClient({ apiKey: FAKE_KEY, baseUrl: BASE, fetchImpl: hanging as unknown as typeof fetch, timeoutMs: 20 });
    expect((await failureOf(slow.call(SEARCH))).code).toBe("QLOO_TIMEOUT");
    expect(hanging).toHaveBeenCalledTimes(1);

    const broken = scriptedFetch([
      () => {
        throw new TypeError(`fetch failed with header X-Api-Key: ${FAKE_KEY}`);
      },
    ]);
    const offline = createQlooClient({ apiKey: FAKE_KEY, baseUrl: BASE, fetchImpl: broken.fetchImpl });
    const error = await failureOf(offline.call(SEARCH));
    expect(error.code).toBe("QLOO_UPSTREAM");
    expectNoKey(error);
    expect(broken.calls).toHaveBeenCalledTimes(1);
  });

  it("cuts off an attempt in flight when the caller's signal fires, with QLOO_TIMEOUT and no retry", async () => {
    const sent: AbortSignal[] = [];
    const hanging = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          if (init?.signal) sent.push(init.signal);
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const client = createQlooClient({ apiKey: FAKE_KEY, baseUrl: BASE, fetchImpl: hanging as unknown as typeof fetch, timeoutMs: 2_000, sleep: async () => undefined });
    const deadline = new AbortController();
    setTimeout(() => deadline.abort(), 20);
    const started = Date.now();

    const error = await failureOf(client.call(SEARCH, { signal: deadline.signal }));

    expect(error.code).toBe("QLOO_TIMEOUT");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(hanging).toHaveBeenCalledTimes(1);
    expect(sent[0]?.aborted).toBe(true);
  });

  it("starts no attempt once the caller's signal has fired: not the first, and not a retry after a 429", async () => {
    const ready = scriptedFetch([() => json(200, { results: [] })]);
    const early = createQlooClient({ apiKey: FAKE_KEY, baseUrl: BASE, fetchImpl: ready.fetchImpl });
    expect((await failureOf(early.call(SEARCH, { signal: AbortSignal.abort() }))).code).toBe("QLOO_TIMEOUT");
    expect(ready.calls).not.toHaveBeenCalled();

    // An injected wait that ignores the signal still gets no second attempt.
    const limited = scriptedFetch([() => json(429, {}, { "retry-after": "1" }), () => json(200, { results: [] })]);
    const deadline = new AbortController();
    const sleep = vi.fn(async (_ms: number) => deadline.abort());
    const waiting = createQlooClient({ apiKey: FAKE_KEY, baseUrl: BASE, fetchImpl: limited.fetchImpl, sleep });
    expect((await failureOf(waiting.call(SEARCH, { signal: deadline.signal }))).code).toBe("QLOO_TIMEOUT");
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(limited.calls).toHaveBeenCalledTimes(1);

    // The default wait ends when the signal fires, not after the Retry-After second.
    const slow = scriptedFetch([() => json(429, {}, { "retry-after": "1" }), () => json(200, { results: [] })]);
    const cut = new AbortController();
    setTimeout(() => cut.abort(), 20);
    const started = Date.now();
    const real = createQlooClient({ apiKey: FAKE_KEY, baseUrl: BASE, fetchImpl: slow.fetchImpl });
    expect((await failureOf(real.call(SEARCH, { signal: cut.signal }))).code).toBe("QLOO_TIMEOUT");
    expect(Date.now() - started).toBeLessThan(500);
    expect(slow.calls).toHaveBeenCalledTimes(1);
  });

  it("sends GET with X-Api-Key as the only auth, refuses redirects, and never exposes the key (C4.1, C4.3)", async () => {
    const { fetchImpl, captured } = scriptedFetch([() => json(200, { results: { entities: [synthEntity(1)] } })]);
    const client = createQlooClient({ apiKey: FAKE_KEY, baseUrl: BASE, fetchImpl });

    const result = await client.call(SEARCH);

    expect(captured).toHaveLength(1);
    const sent = captured[0]!;
    const headers = new Headers(sent.init.headers);
    expect(sent.init.method).toBe("GET");
    expect(sent.init.redirect).toBe("error");
    expect(sent.init.body).toBeUndefined();
    expect(headers.get("x-api-key")).toBe(FAKE_KEY);
    expect([...headers.keys()].sort()).toEqual(["accept", "x-api-key"]);
    expect(sent.url.href).not.toContain(FAKE_KEY);

    expect(result.request).toEqual({
      path: "/search",
      params: [
        ["query", "Synthetic Show"],
        ["take", "5"],
        ["types", "urn:entity:podcast"],
      ],
    });
    expectNoKey(result.request);
    expect(JSON.stringify(result.request)).not.toContain("hackathon.api.qloo.com");

    for (const status of [401, 403, 429, 500]) {
      const failing = scriptedFetch([() => json(status, { echoed: FAKE_KEY })]);
      const failingClient = createQlooClient({ apiKey: FAKE_KEY, baseUrl: BASE, fetchImpl: failing.fetchImpl, sleep: async () => undefined });
      expectNoKey(await failureOf(failingClient.call(SEARCH)));
    }
  });

  it("rejects a bad operation with QLOO_BAD_INPUT before any request, and refuses an empty key or a non-https base", async () => {
    const { fetchImpl, calls } = scriptedFetch([() => json(200, { results: [] })]);
    const client = createQlooClient({ apiKey: FAKE_KEY, baseUrl: BASE, fetchImpl });

    const error = await failureOf(client.call({ op: "tags", query: "q", take: 51 }));
    expect(error.code).toBe("QLOO_BAD_INPUT");
    expect(calls).not.toHaveBeenCalled();

    expect(() => createQlooClient({ apiKey: "  ", baseUrl: BASE, fetchImpl })).toThrow(
      expect.objectContaining({ code: "QLOO_KEY_MISSING" }),
    );
    expect(() => createQlooClient({ apiKey: FAKE_KEY, baseUrl: new URL("http://hackathon.api.qloo.com"), fetchImpl })).toThrow(
      expect.objectContaining({ code: "QLOO_BAD_INPUT" }),
    );
  });

  it("reports QLOO_SCHEMA for a body that is not JSON or does not match the shape", async () => {
    for (const body of [() => new Response("<html>not json</html>", { status: 200 }), () => json(200, { results: "nope" })]) {
      const { fetchImpl } = scriptedFetch([body]);
      const error = await failureOf(createQlooClient({ apiKey: FAKE_KEY, baseUrl: BASE, fetchImpl }).call(SEARCH));
      expect(error.code).toBe("QLOO_SCHEMA");
      expect(error.message).not.toContain("html");
    }
  });

  it("refuses a body past 5 MiB instead of buffering it, without retrying", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    const oversized = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (let i = 0; i < 6; i++) controller.enqueue(chunk);
            controller.close();
          },
        }),
        { status: 200 },
      );
    const { fetchImpl, calls } = scriptedFetch([oversized]);
    const error = await failureOf(createQlooClient({ apiKey: FAKE_KEY, baseUrl: BASE, fetchImpl }).call(SEARCH));
    expect(error.code).toBe("QLOO_UPSTREAM");
    expect(calls).toHaveBeenCalledTimes(1);
  });
});

describe("createQlooClient onQuota", () => {
  const quotaHeaders = (remaining: string, limit: string) => ({ "X-Month-RateLimit-Remaining": remaining, "X-Month-RateLimit-Limit": limit });

  it("reports both counts once, with the time the reply arrived, after a 200 and after a 429", async () => {
    for (const status of [200, 429]) {
      const { fetchImpl } = scriptedFetch([() => json(status, { results: [] }, quotaHeaders("48210", "50000"))]);
      const onQuota = vi.fn();
      const before = Date.now();
      const client = createQlooClient({ apiKey: FAKE_KEY, baseUrl: BASE, fetchImpl, maxRetries: 0, onQuota });

      const outcome = await client.call(SEARCH).then(
        (result) => result.status,
        (error: QlooError) => error.code,
      );

      expect(outcome).toBe(status === 200 ? 200 : "QLOO_RATE_LIMIT");
      expect(onQuota).toHaveBeenCalledTimes(1);
      expect(onQuota).toHaveBeenCalledWith({ remaining: 48210, limit: 50000, seenAt: expect.any(Date) });
      expect((onQuota.mock.calls[0]?.[0] as { seenAt: Date }).seenAt.getTime()).toBeGreaterThanOrEqual(before);
    }
  });

  it("reads the header names in any case", async () => {
    const { fetchImpl } = scriptedFetch([
      () => json(200, { results: [] }, { "x-MONTH-ratelimit-remaining": "0", "X-month-RATELIMIT-limit": "50000" }),
    ]);
    const onQuota = vi.fn();
    await createQlooClient({ apiKey: FAKE_KEY, baseUrl: BASE, fetchImpl, onQuota }).call(SEARCH);

    expect(onQuota).toHaveBeenCalledWith({ remaining: 0, limit: 50000, seenAt: expect.any(Date) });
  });

  it("calls nothing when either header is missing, negative, fractional or not a number", async () => {
    const cases: Array<Record<string, string>> = [
      {},
      { "X-Month-RateLimit-Remaining": "1499" },
      { "X-Month-RateLimit-Limit": "50000" },
      quotaHeaders("-5", "50000"),
      quotaHeaders("1499", "-50000"),
      quotaHeaders("1499.5", "50000"),
      quotaHeaders("1499", "50000.0"),
      quotaHeaders("lots", "50000"),
      quotaHeaders("1e3", "50000"),
      quotaHeaders("1,499", "50000"),
      quotaHeaders("", "50000"),
    ];
    for (const headers of cases) {
      const { fetchImpl } = scriptedFetch([() => json(200, { results: [] }, headers)]);
      const onQuota = vi.fn();
      await createQlooClient({ apiKey: FAKE_KEY, baseUrl: BASE, fetchImpl, onQuota }).call(SEARCH);
      expect(onQuota, JSON.stringify(headers)).not.toHaveBeenCalled();
    }
  });

  it("waits for onQuota before answering, and an onQuota that fails does not fail the call", async () => {
    const order: string[] = [];
    const slow = scriptedFetch([() => json(200, { results: [] }, quotaHeaders("1500", "50000"))]);
    const recording = createQlooClient({
      apiKey: FAKE_KEY,
      baseUrl: BASE,
      fetchImpl: slow.fetchImpl,
      onQuota: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("recorded");
      },
    });
    await recording.call(SEARCH).then(() => order.push("answered"));
    expect(order).toEqual(["recorded", "answered"]);

    const broken = scriptedFetch([() => json(200, { results: [synthEntity(1)] }, quotaHeaders("1500", "50000"))]);
    const failing = createQlooClient({
      apiKey: FAKE_KEY,
      baseUrl: BASE,
      fetchImpl: broken.fetchImpl,
      onQuota: async () => {
        throw new Error("database down");
      },
    });
    expect((await failing.call(SEARCH)).data).toEqual([synthEntity(1)]);
  });
});

describe("parseQlooResponse (synthetic fixtures only)", () => {
  const PERSON: QlooOperation = { op: "insights", filterType: "urn:entity:person", signalEntities: [SYNTH_ID] };

  it("normalises both search shapes to one entity list", () => {
    const flat = parseQlooResponse(SEARCH, { results: [synthEntity(1), synthEntity(2)] });
    const nested = parseQlooResponse(SEARCH, { success: true, results: { entities: [synthEntity(1), synthEntity(2)] } });

    expect(flat).toEqual(nested);
    expect(flat.map((entity) => entity.name)).toEqual(["Synthetic Entity 1", "Synthetic Entity 2"]);
  });

  it("reads insights entities with affinity under query or under properties, keeping unknown fields", () => {
    const entities = parseQlooResponse(PERSON, {
      success: true,
      duration: 12,
      results: {
        entities: [
          { ...synthEntity(1), tags: [{ id: "urn:tag:synthetic", name: "Synthetic" }], extra_field: "kept" },
          { entity_id: SYNTH_ID, name: "Synthetic Entity 9", properties: { affinity: 0.4 }, popularity: null, query: null },
        ],
      },
    });

    expect(entities[0]?.query?.affinity).toBe(0.9);
    expect(entities[0]?.["extra_field"]).toBe("kept");
    expect(entities[1]?.properties?.affinity).toBe(0.4);
  });

  it("reads demographics, trending, compare and tag results", () => {
    const demographics = parseQlooResponse(
      { op: "demographics", signalEntities: [SYNTH_ID] },
      { results: { demographics: [{ entity_id: SYNTH_ID, query: { age: { "25_to_29": 0.4, "55_and_older": -0.2 }, gender: { male: 0.1, female: -0.1 } } }] } },
    );
    expect(demographics[0]?.query.age["25_to_29"]).toBe(0.4);

    const trending = parseQlooResponse(
      { op: "trending", filterType: "urn:entity:person", entity: SYNTH_ID, startDate: "2026-07-27", endDate: "2026-10-18" },
      { results: { trending: [{ date: "2026-10-12", population_percentile: 0.7, population_rank_velocity: null }, { date: "2026-10-05" }] } },
    );
    expect(trending.map((row) => row.date)).toEqual(["2026-10-12", "2026-10-05"]);

    const compare = parseQlooResponse(
      { op: "compare", a: [SYNTH_ID], b: [SYNTH_ID] },
      {
        duration: 0.4,
        results: {
          tags: [{ tag_id: "urn:tag:synthetic:one", name: "Synthetic One", query: { score: 0.7 } }],
          a: [{ tag_id: "urn:tag:synthetic:two", name: "Synthetic Two", query: { count: "1" } }],
        },
      },
    );
    expect(compare.tags[0]?.query?.score).toBe(0.7);
    expect(compare.a.map((tag) => tag.name)).toEqual(["Synthetic Two"]);
    expect(compare.b).toEqual([]);

    const tags = parseQlooResponse(
      { op: "tags", query: "synthetic" },
      { results: { tags: [{ id: "urn:tag:synthetic:a", name: "A" }, { tag_id: "urn:tag:synthetic:b", name: "B" }] } },
    );
    expect(tags).toHaveLength(2);
  });

  it("throws QLOO_SCHEMA when a field Vasal reads is missing or the wrong type", () => {
    const mismatches: Array<[QlooOperation, unknown]> = [
      [SEARCH, { results: [{ name: "No id" }] }],
      [SEARCH, { results: { entities: "not a list" } }],
      [PERSON, { results: [] }],
      [PERSON, { results: { entities: [{ ...synthEntity(1), popularity: "high" }] } }],
      [{ op: "demographics", signalEntities: [SYNTH_ID] }, { results: { demographics: [{ entity_id: SYNTH_ID, query: { age: { x: "y" }, gender: {} } }] } }],
      [{ op: "trending", filterType: "urn:entity:person", entity: SYNTH_ID, startDate: "2026-07-27", endDate: "2026-10-18" }, { results: { trending: [{ population_rank: 3 }] } }],
      [{ op: "compare", a: [SYNTH_ID], b: [SYNTH_ID] }, { results: { entities: [] } }],
      [{ op: "compare", a: [SYNTH_ID], b: [SYNTH_ID] }, { results: { tags: [], b: [{ tag_id: "urn:tag:synthetic:nameless" }] } }],
      [{ op: "tags", query: "q" }, { results: { tags: [{ name: "No id at all" }] } }],
      [SEARCH, null],
    ];
    for (const [op, body] of mismatches) {
      expect(() => parseQlooResponse(op, body)).toThrow(expect.objectContaining({ code: "QLOO_SCHEMA" }));
    }
  });
});

describe("loadQlooConfig", () => {
  it("defaults to the hackathon host and treats a blank key as missing", () => {
    expect(loadQlooConfig({})).toEqual({ apiKey: undefined, baseUrl: new URL("https://hackathon.api.qloo.com") });
    expect(loadQlooConfig({ QLOO_API_KEY: "   ", QLOO_BASE_URL: "" }).apiKey).toBeUndefined();
    expect(loadQlooConfig({ QLOO_API_KEY: ` ${FAKE_KEY} ` }).apiKey).toBe(FAKE_KEY);
  });

  it("refuses production, staging, non-https and non-origin base URLs without echoing values", () => {
    const refused = [
      "https://api.qloo.com",
      "https://API.QLOO.COM/",
      "https://api.qloo.com.",
      "https://staging.api.qloo.com:443",
      "http://hackathon.api.qloo.com",
      "https://hackathon.api.qloo.com/v2",
      "https://hackathon.api.qloo.com/?take=50",
      "https://user:secret-pw@hackathon.api.qloo.com",
      "not a url",
    ];
    for (const value of refused) {
      expect(() => loadQlooConfig({ QLOO_BASE_URL: value })).toThrow(/QLOO_BASE_URL/);
    }
    try {
      loadQlooConfig({ QLOO_API_KEY: `has space ${FAKE_KEY}` });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(String(error)).toMatch(/QLOO_API_KEY/);
      expectNoKey(error);
    }
  });
});
