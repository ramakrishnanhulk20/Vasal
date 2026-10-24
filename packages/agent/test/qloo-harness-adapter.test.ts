// Covers find_person on Qloo's own harness in this process, end to end
// through our metered path: the harness's real describe workflow and name
// resolver, createMeteredHarnessClient, the real cache and meter on PGlite,
// and the real HTTPS client over a fake fetch. It shows each harness request
// takes exactly one meter slot, a refused budget sends nothing, a 429 is one
// request and never retried, a redirect is refused, a query key or value
// outside the rule never leaves the process, a repeat lookup sends nothing
// new, and the harness gets an observer that writes no file. It does not
// cover the real Qloo host or its real answers (only a live run can), the
// harness's other eight workflows, or the stdio `qloo mcp` route
// (qloo-harness.test.ts). Every body here is synthetic.
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDirectQlooWorkflowExecutor } from "@qloo/qloo-harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRunContext, type RunContext } from "../src/agent/context.js";
import { attachHarness, runTool } from "../src/agent/tools.js";
import { createQlooClient } from "../src/qloo/client.js";
import { QlooError } from "../src/qloo/errors.js";
import { createMeteredHarnessClient, NO_OP_OBSERVER } from "../src/qloo/harness-adapter.js";
import { createMeteredQloo } from "../src/qloo/metered.js";
import type { Db } from "../src/store/db.js";
import { setBucket, usage, waitForQlooSlot } from "../src/store/meter.js";
import { migratedPglite } from "./helpers/pglite.js";

// The real harness, with the executor factory wrapped so a test can see the
// observer find_person hands it.
vi.mock("@qloo/qloo-harness", async (importOriginal) => {
  const real = await importOriginal<typeof import("@qloo/qloo-harness")>();
  return { ...real, createDirectQlooWorkflowExecutor: vi.fn(real.createDirectQlooWorkflowExecutor) };
});

const FAKE_KEY = "FAKE-KEY-must-never-leak-4b2e";
const BASE = new URL("https://hackathon.api.qloo.com");
const MARKER = "MARKER-h1a7";
const TODAY = new Date("2026-10-24T09:00:00.000Z");
const FAR_FUTURE = new Date("2099-01-01T00:00:00.000Z");
const SHOW = { qlooId: "00000000-0000-4000-8000-000000000001", name: "Synthetic Show" };
const PERSON = "00000000-0000-4000-8000-000000000211";
const OTHER = "00000000-0000-4000-8000-000000000212";
// Matches one search hit exactly, and would add a second `take` if it ever
// reached the query unencoded (C2.3).
const NAME = "Synthetic&take=500#Person";

type Sent = { url: URL; init: RequestInit };

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const synthPerson = (id: string, name: string) => ({
  entity_id: id,
  name,
  types: ["urn:entity:person"],
  popularity: 0.4,
  properties: { short_description: `Synthetic description ${MARKER}` },
});

// Answers as Qloo's host does: /search lists people, /entities the ids asked for.
function hostAnswer(url: URL): Response {
  if (url.pathname === "/search") return json(200, { results: [synthPerson(PERSON, NAME), synthPerson(OTHER, `${NAME} Junior`)] });
  if (url.pathname === "/entities") {
    const ids = (url.searchParams.get("entity_ids") ?? "").split(",");
    return json(200, { results: { entities: ids.map((id) => synthPerson(id, id === PERSON ? NAME : `${NAME} Junior`)) } });
  }
  return json(404, {});
}

function qlooHost(answer: (url: URL) => Response = hostAnswer) {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    sent.push({ url, init: init ?? {} });
    return answer(url);
  }) as typeof fetch;
  return { fetchImpl, sent };
}

let db: Db;

beforeEach(async () => {
  db = await migratedPglite();
  await setBucket(db, { key: "qloo:day", cap: 100, windowEnd: FAR_FUTURE });
  await setBucket(db, { key: "qloo:month", cap: 1_000, windowEnd: FAR_FUTURE });
  vi.mocked(createDirectQlooWorkflowExecutor).mockClear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await db.close();
});

// Built the way main.ts builds a surface's Qloo: no retries in the client,
// the shared cache, and the real meter behind a counter.
function metered(fetchImpl: typeof fetch, maxRetries = 0) {
  const reservations = { count: 0 };
  const client = createQlooClient({ apiKey: FAKE_KEY, baseUrl: BASE, fetchImpl, maxRetries });
  const qloo = createMeteredQloo({
    client,
    db,
    baseUrl: BASE,
    waitForSlot: async (target, signal) => {
      reservations.count += 1;
      return waitForQlooSlot(target, signal === undefined ? {} : { signal });
    },
  });
  return { qloo, reservations };
}

function newRun(qloo: ReturnType<typeof metered>["qloo"]): RunContext {
  const ctx = createRunContext({ show: SHOW, episodeTitles: [], exclusions: [] });
  attachHarness(ctx, { qloo });
  return ctx;
}

const findPerson = (ctx: RunContext, qloo: ReturnType<typeof metered>["qloo"], name = NAME) =>
  runTool(ctx, qloo, "find_person", { name }, TODAY, { trends: true });

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof QlooError) return error.code;
    throw error;
  }
  throw new Error("expected the call to fail");
}

describe("find_person through Qloo's harness and our meter", () => {
  it("looks a name up with exactly 2 requests, search then entities, each taking one meter slot", async () => {
    const host = qlooHost();
    const { qloo, reservations } = metered(host.fetchImpl);
    const ctx = newRun(qloo);

    const outcome = await findPerson(ctx, qloo);

    expect(outcome).toEqual({ content: JSON.stringify({ people: [{ personId: PERSON, name: NAME }] }), isError: false });
    expect(host.sent.map(({ url }) => url.pathname)).toEqual(["/search", "/entities"]);
    expect([...host.sent[0]!.url.searchParams]).toEqual([
      ["query", NAME],
      ["take", "5"],
      ["types", "urn:entity:person"],
    ]);
    expect([...host.sent[1]!.url.searchParams]).toEqual([["entity_ids", PERSON]]);
    expect(reservations.count).toBe(2);
    expect((await usage(db, "qloo:day"))?.used).toBe(2);
    expect(ctx.people.get(PERSON)).toEqual({ name: NAME, affinity: null, popularity: 0.4 });
    expect(ctx.steps).toEqual([{ tool: "find_person", ok: true, summary: "found 1 matching people" }]);
  });

  it("with the budget refused sends nothing and gives the refusal the tool gives today (C5.1)", async () => {
    await setBucket(db, { key: "qloo:day", cap: 0, windowEnd: FAR_FUTURE });
    const host = qlooHost();
    const { qloo, reservations } = metered(host.fetchImpl);
    const ctx = newRun(qloo);

    const outcome = await findPerson(ctx, qloo);

    expect(outcome).toEqual({ content: JSON.stringify({ error: "QLOO_BUDGET" }), isError: true });
    expect(host.sent).toEqual([]);
    expect(reservations.count).toBe(1);
    expect(ctx.people.size).toBe(0);
    expect(ctx.steps).toEqual([{ tool: "find_person", ok: false, summary: "failed: QLOO_BUDGET" }]);
  });

  it("sends one request on a 429 and never retries, even over a client that would, and shows only the code (C5.2, C3.6)", async () => {
    for (const maxRetries of [0, 2]) {
      const host = qlooHost(() => json(429, { message: `slow down ${MARKER}` }, { "retry-after": "0" }));
      const { qloo, reservations } = metered(host.fetchImpl, maxRetries);
      const ctx = newRun(qloo);

      const outcome = await findPerson(ctx, qloo);

      expect(outcome, String(maxRetries)).toEqual({ content: JSON.stringify({ error: "QLOO_RATE_LIMIT" }), isError: true });
      expect(host.sent, String(maxRetries)).toHaveLength(1);
      expect(reservations.count, String(maxRetries)).toBe(1);
      expect(ctx.steps).toEqual([{ tool: "find_person", ok: false, summary: "failed: QLOO_RATE_LIMIT" }]);
      expect(JSON.stringify([outcome, ctx.steps])).not.toContain(MARKER);
    }
  });

  it("refuses a redirect instead of following it, so the key never goes to another host (C1)", async () => {
    const sent: Sent[] = [];
    // Behaves as fetch does: with redirect "error" a 3xx is a network error,
    // and with any other setting the redirect is followed.
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      sent.push({ url, init: init ?? {} });
      if (url.host !== BASE.host) return json(200, { results: [synthPerson(PERSON, NAME)] });
      if (init?.redirect === "error") throw new TypeError("fetch failed");
      return fetchImpl(new URL(`https://elsewhere.example/search?from=${MARKER}`), init);
    }) as typeof fetch;
    const { qloo, reservations } = metered(fetchImpl);
    const ctx = newRun(qloo);

    const outcome = await findPerson(ctx, qloo);

    expect(outcome).toEqual({ content: JSON.stringify({ error: "QLOO_UPSTREAM" }), isError: true });
    expect(sent.map(({ url }) => url.host)).toEqual([BASE.host]);
    expect(sent[0]?.init.redirect).toBe("error");
    expect(sent[0]?.init.headers).toEqual({ Accept: "application/json", "X-Api-Key": FAKE_KEY });
    expect(reservations.count).toBe(1);
    expect(ctx.people.size).toBe(0);
  });

  it("refuses a query key or value outside the rule before any slot or request", async () => {
    const host = qlooHost();
    const { qloo, reservations } = metered(host.fetchImpl);
    const client = createMeteredHarnessClient({ qloo });
    const refused: unknown[] = [
      { "Bad-Key": "x" },
      { query: "x", "../v2/insights": "x" },
      { [`k${"x".repeat(64)}`]: "x" },
      { query: { nested: MARKER } },
      { query: null },
      { take: Number.NaN },
      { query: "" },
      { query: "lone \uD800 surrogate" },
      { "signal.interests.entities": [] },
      { "signal.interests.entities": Array.from({ length: 26 }, () => PERSON) },
      { "signal.interests.entities": [PERSON, "a,b"] },
      { "signal.interests.entities": [[PERSON]] },
    ];

    for (const query of refused) {
      expect(await codeOf(client.searchEntities(query as never)), JSON.stringify(query)).toBe("QLOO_BAD_INPUT");
    }
    expect(await codeOf(client.entities([PERSON, "a,b"]))).toBe("QLOO_BAD_INPUT");
    expect(await codeOf(client.insights({ "filter.type": "urn:entity:person", "Signal.Interests": PERSON }))).toBe("QLOO_BAD_INPUT");
    expect(host.sent).toEqual([]);
    expect(reservations.count).toBe(0);
  });

  it("serves a second identical lookup in the same run with no new request or slot, and a later run from our cache", async () => {
    const host = qlooHost();
    const { qloo, reservations } = metered(host.fetchImpl);
    const ctx = newRun(qloo);

    const first = await findPerson(ctx, qloo);
    const second = await findPerson(ctx, qloo);

    expect(second).toEqual(first);
    expect(host.sent).toHaveLength(2);
    expect(reservations.count).toBe(2);
    // The search came from the harness's own resolver cache, the entities from ours.
    expect(qloo.stats()).toEqual({ calls: 2, cacheHits: 1 });

    const later = await findPerson(newRun(qloo), qloo);

    expect(later).toEqual(first);
    expect(host.sent).toHaveLength(2);
    expect(reservations.count).toBe(2);
    expect(qloo.stats()).toEqual({ calls: 2, cacheHits: 3 });
    expect(createDirectQlooWorkflowExecutor).toHaveBeenCalledTimes(2);
  });

  it("writes no file: the executor gets the no-op observer, which returns nothing", async () => {
    const home = await mkdtemp(join(tmpdir(), "vasal-qloo-home-"));
    // Where the harness's own file observer would write its workflow log.
    vi.stubEnv("QLOO_HOME", home);
    try {
      const observed = vi.spyOn(NO_OP_OBSERVER, "onExecution");
      const host = qlooHost();
      const { qloo } = metered(host.fetchImpl);
      const ctx = newRun(qloo);

      const outcome = await findPerson(ctx, qloo);

      expect(outcome.isError).toBe(false);
      expect(vi.mocked(createDirectQlooWorkflowExecutor).mock.calls).toHaveLength(1);
      expect(vi.mocked(createDirectQlooWorkflowExecutor).mock.calls[0]?.[1]).toBe(NO_OP_OBSERVER);
      expect(observed).toHaveBeenCalledTimes(1);
      expect(observed.mock.results[0]?.value).toBeUndefined();
      expect(await readdir(home)).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
