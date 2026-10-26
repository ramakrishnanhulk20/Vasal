// Synthetic stand-ins for what the agent runner reaches outside the database:
// the directory and feed fetcher, a metered Qloo and a scripted model. Shared
// by the runner and seed tests, so both drive the same agent. Every name and
// id here is made up, so no test holds Qloo data (C7.3).
import type Anthropic from "@anthropic-ai/sdk";
import { expect } from "vitest";
import type { ZodType } from "zod";
import { AgentError } from "../../src/agent/errors.js";
import type { ModelClient } from "../../src/agent/model.js";
import type { AgentFeeds } from "../../src/agent/runner.js";
import type { ShowCandidate } from "../../src/feeds/lookup.js";
import { parseFeed } from "../../src/feeds/rss.js";
import type { RawQlooRequest } from "../../src/qloo/client.js";
import type { QlooError } from "../../src/qloo/errors.js";
import type { MeteredQloo, MeteredRawQloo } from "../../src/qloo/metered.js";
import type { EntityType, QlooOperation } from "../../src/qloo/request.js";
import { claimRunStatus, listCandidates } from "../../src/server/runs.js";
import type { Db } from "../../src/store/db.js";

export const NOW = new Date("2026-10-19T12:00:00.000Z");
export const MARKER = "MARKER-ru11";
export const PODCAST_ID = "00000000-0000-4000-8000-000000000500";
export const personId = (n: number) => `00000000-0000-4000-8000-0000000002${String(n).padStart(2, "0")}`;
export const PICKS = [1, 2, 3, 4];
const RSS = `<?xml version="1.0"?><rss><channel><title>Synthetic Show</title>
<item><title>Episode one with a past guest</title><pubDate>Mon, 12 Oct 2026 08:00:00 GMT</pubDate></item>
<item><title>Episode two</title><pubDate>Mon, 05 Oct 2026 08:00:00 GMT</pubDate></item>
</channel></rss>`;

export const show = (n: number): ShowCandidate => ({
  appleId: String(1000 + n),
  name: `Synthetic Show ${n}`,
  publisher: `Synthetic Publisher ${n}`,
  feedUrl: new URL(`https://feeds.example/show-${n}.xml?token=${MARKER}`),
  genre: null,
});

export function fakeFeeds(opts: { shows?: ShowCandidate[]; feed?: string | Error } = {}) {
  const fetched: URL[] = [];
  const feeds: AgentFeeds = {
    searchShows: async () => opts.shows ?? [1, 2, 3, 4, 5].map(show),
    lookupShow: async () => null,
    safeFetch: async (url) => {
      fetched.push(url);
      if (opts.feed instanceof Error) throw opts.feed;
      return { body: opts.feed ?? RSS };
    },
    parseFeed,
  };
  return { feeds, fetched };
}

const fitScores: Record<string, number> = { [personId(1)]: 0.41, [personId(2)]: 0.77, [personId(3)]: 0.55 };

export function synthResponse(op: QlooOperation): unknown {
  switch (op.op) {
    case "search":
      return [{ entity_id: PODCAST_ID, name: op.query }];
    case "insights":
      if (op.resultEntities !== undefined) {
        return op.resultEntities.filter((id) => id in fitScores).map((id) => ({ entity_id: id, name: "ignored", query: { affinity: fitScores[id] } }));
      }
      return PICKS.map((n) => ({ entity_id: personId(n), name: `Synthetic Person ${n}`, popularity: 0.5, query: { affinity: 0.9 } }));
    case "demographics":
      return [{ entity_id: op.signalEntities[0], query: { age: { "25_to_29": op.signalEntities[0] === PODCAST_ID ? -0.2 : 0.4 }, gender: {} } }];
    case "trending":
      return Array.from({ length: 12 }, (_, week) => ({
        date: new Date(Date.UTC(2026, 9, 11) - week * 7 * 86_400_000).toISOString().slice(0, 10),
        population_percentile: week < 4 ? 70 : 60,
      }));
    case "compare":
      return { tags: [{ tag_id: "urn:tag:genre:media:synthetic", name: "synthetic taste", query: { score: 0.5 } }], a: [], b: [] };
    default:
      return [];
  }
}

export function fakeQloo(fail?: (op: QlooOperation) => QlooError | null) {
  const ops: QlooOperation[] = [];
  const qloo: MeteredQloo = {
    async call<T>(op: QlooOperation): Promise<{ data: T; fromCache: boolean }> {
      ops.push(op);
      const error = fail?.(op) ?? null;
      if (error !== null) throw error;
      return { data: synthResponse(op) as T, fromCache: false };
    },
    stats: () => ({ calls: ops.length, cacheHits: 0 }),
  };
  return { qloo, ops };
}

const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input, caller: { type: "direct" } });
const reply = (content: unknown[]) =>
  ({
    id: "msg_synthetic",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content,
    stop_reason: "tool_use",
    stop_sequence: null,
    stop_details: null,
    container: null,
    diagnostics: null,
    usage: { input_tokens: 100, output_tokens: 50 },
  }) as unknown as Anthropic.Message;

export function fakeModel(briefDraft?: unknown) {
  const turns: Array<Parameters<ModelClient["turn"]>[0]> = [];
  const model: ModelClient = {
    async turn(params) {
      turns.push(structuredClone(params));
      if (turns.length === 1) return reply([toolUse("p", "people_for_show", { reach: "any" }), toolUse("t", "recent_episode_titles", {})]);
      return reply([
        toolUse("f", "finish_board", { picks: PICKS.map((n) => ({ personId: personId(n), angle: "Their fans already love this kind of talk." })) }),
      ]);
    },
    async structured<T>(params: { system: string; user: string; schema: ZodType<T>; maxTokens: number }): Promise<T> {
      const parsed = params.schema.safeParse(briefDraft);
      if (!parsed.success) throw new AgentError("AGENT_BAD_PROSE");
      return parsed.data;
    },
  };
  return { model, turns };
}

// find_person reaches Qloo through the harness, which asks the metered raw
// path for /search and then, for a name it can pick, /entities. Both are
// answered from a fake metered Qloo's own search answers, so one fake scripts
// every tool and its ops list records the search the harness made. The real
// path is covered in qloo-harness-adapter.test.ts.
export function harnessFrom(qloo: MeteredQloo) {
  const requests: RawQlooRequest[] = [];
  const seen = new Map<string, unknown>();
  const harness: MeteredRawQloo = {
    async callRaw(request, options) {
      requests.push(request);
      const params = new Map(request.params);
      if (request.path === "/search") {
        const op: QlooOperation = {
          op: "search",
          query: params.get("query") ?? "",
          types: [params.get("types") as EntityType],
          take: Number(params.get("take")),
        };
        const { data } = await qloo.call<unknown[]>(op, options);
        for (const entity of data) seen.set((entity as { entity_id: string }).entity_id, entity);
        return { data: { results: data }, fromCache: false };
      }
      if (request.path === "/entities") {
        const ids = (params.get("entity_ids") ?? "").split(",");
        return { data: { results: { entities: ids.filter((id) => seen.has(id)).map((id) => seen.get(id)) } }, fromCache: false };
      }
      throw new Error(`no fake answer for ${request.path}`);
    },
  };
  return { harness, requests };
}

// Most tests here are about the run, not its surface, so both surfaces get
// the same fakes.
export const sameForBoth = (model: ModelClient, qloo: MeteredQloo) => ({
  modelFor: () => model,
  qlooFor: () => qloo,
  harnessFor: () => harnessFrom(qloo).harness,
});

// Records which transaction each statement ran in, so a test can show two
// writes were committed together.
export function trackingDb(inner: Db) {
  const log: Array<{ tx: number | null; text: string; params: unknown[] }> = [];
  let opened = 0;
  const wrap = (target: Db, tx: number | null): Db => ({
    query: <R = Record<string, unknown>>(text: string, params?: unknown[]) => {
      log.push({ tx, text, params: params ?? [] });
      return target.query<R>(text, params);
    },
    transaction: <T>(fn: (handle: Db) => Promise<T>) => target.transaction((handle) => fn(wrap(handle, tx ?? (opened += 1)))),
    close: () => target.close(),
  });
  return { db: wrap(inner, null), log };
}

// What the confirm route does before it calls continueRun.
export async function confirmFirst(db: Db, runId: string): Promise<string> {
  const [first] = await listCandidates(db, runId);
  expect(await claimRunStatus(db, runId, "awaiting_confirm", "running", NOW)).toBe(true);
  return first!.id;
}
