// Covers show resolution with a fake directory and a fake metered Qloo
// holding synthetic data: how each kind of input is looked up, the one
// Qloo search per candidate, dropping ambiguous or missing matches, and the
// two not-found codes. It does not cover the real iTunes or Qloo responses,
// classifyInput's own rules (feeds-classify) or pickPodcastMatch's tiers
// (backtest-eligibility).
import { describe, expect, it, vi } from "vitest";
import { AgentError } from "../src/agent/errors.js";
import { resolveShow } from "../src/agent/resolve.js";
import type { ShowCandidate } from "../src/feeds/lookup.js";
import { QlooError } from "../src/qloo/errors.js";
import type { MeteredQloo } from "../src/qloo/metered.js";
import type { QlooOperation } from "../src/qloo/request.js";

const podcastId = (n: number) => `00000000-0000-4000-8000-0000000005${String(n).padStart(2, "0")}`;

const show = (n: number, over: Partial<ShowCandidate> = {}): ShowCandidate => ({
  appleId: String(1000 + n),
  name: `Synthetic Show ${n}`,
  publisher: `Synthetic Publisher ${n}`,
  feedUrl: new URL(`https://feeds.example/show-${n}.xml`),
  genre: null,
  ...over,
});

function fakeQloo(respond: (op: QlooOperation) => unknown) {
  const ops: QlooOperation[] = [];
  const qloo: MeteredQloo = {
    async call<T>(op: QlooOperation): Promise<{ data: T; fromCache: boolean }> {
      ops.push(op);
      return { data: respond(op) as T, fromCache: false };
    },
    stats: () => ({ calls: ops.length, cacheHits: 0 }),
  };
  return { qloo, ops };
}

// Qloo answers each search with one podcast of exactly the searched name.
const exactMatch = (op: QlooOperation) =>
  op.op === "search" ? [{ entity_id: podcastId(Number(op.query.replace(/\D/g, "") || 0)), name: op.query }] : [];

function deps(directory: { search?: ShowCandidate[]; lookup?: ShowCandidate | null }, respond = exactMatch) {
  const searchShows = vi.fn(async (_term: string) => directory.search ?? []);
  const lookupShow = vi.fn(async (_id: string) => directory.lookup ?? null);
  const { qloo, ops } = fakeQloo(respond);
  return { deps: { searchShows, lookupShow, qloo }, searchShows, lookupShow, ops };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof AgentError || error instanceof QlooError ? error.code : String(error);
  }
  return "resolved";
}

describe("resolveShow", () => {
  it("gives at most 5 candidates for a name, each with a single Qloo podcast", async () => {
    const setup = deps({ search: [1, 2, 3, 4, 5, 6, 7].map((n) => show(n)) });

    const found = await resolveShow({ show: "  Synthetic Show  ", exclude: ["Someone"] }, setup.deps);

    expect(setup.searchShows).toHaveBeenCalledWith("Synthetic Show");
    expect(setup.lookupShow).not.toHaveBeenCalled();
    expect(found).toHaveLength(5);
    expect(found[0]).toEqual({
      appleId: "1001",
      name: "Synthetic Show 1",
      publisher: "Synthetic Publisher 1",
      feedHandleSource: "directory",
      feedUrl: "https://feeds.example/show-1.xml",
      qlooId: podcastId(1),
      qlooName: "Synthetic Show 1",
    });
    expect(setup.ops).toEqual(
      [1, 2, 3, 4, 5].map((n) => ({ op: "search", query: `Synthetic Show ${n}`, types: ["urn:entity:podcast"], take: 5 })),
    );
  });

  it("drops a candidate whose Qloo match is ambiguous or missing", async () => {
    const setup = deps({ search: [show(1), show(2), show(3)] }, (op) => {
      if (op.op !== "search") return [];
      if (op.query.endsWith("1")) return [{ entity_id: podcastId(1), name: op.query }];
      if (op.query.endsWith("2")) {
        return [
          { entity_id: podcastId(21), name: op.query },
          { entity_id: podcastId(22), name: op.query.toUpperCase() },
        ];
      }
      return [{ entity_id: podcastId(3), name: "A Different Podcast" }];
    });

    const found = await resolveShow({ show: "Synthetic", exclude: [] }, setup.deps);

    expect(found.map((candidate) => candidate.qlooId)).toEqual([podcastId(1)]);
  });

  it("looks an Apple Podcasts link up by its id and never searches by name", async () => {
    const setup = deps({ lookup: show(9, { appleId: "123456789" }) });

    const found = await resolveShow({ show: "https://podcasts.apple.com/us/podcast/x/id123456789", exclude: [] }, setup.deps);

    expect(setup.lookupShow).toHaveBeenCalledWith("123456789");
    expect(setup.searchShows).not.toHaveBeenCalled();
    expect(found.map((candidate) => [candidate.appleId, candidate.qlooId])).toEqual([["123456789", podcastId(9)]]);
  });

  it("names a pasted feed after its host and keeps the URL for a later handle", async () => {
    const setup = deps({}, (op) => (op.op === "search" ? [{ entity_id: podcastId(40), name: op.query }] : []));

    const found = await resolveShow({ show: "https://feeds.example/private.xml", exclude: [] }, setup.deps);

    expect(setup.searchShows).not.toHaveBeenCalled();
    expect(found).toEqual([
      {
        appleId: null,
        name: "feeds.example",
        publisher: "",
        feedHandleSource: "visitor",
        feedUrl: "https://feeds.example/private.xml",
        qlooId: podcastId(40),
        qlooName: "feeds.example",
      },
    ]);
  });

  it("gives SHOW_NOT_FOUND with no Qloo call when the directory has nothing", async () => {
    const empty = deps({ search: [] });
    expect(await codeOf(resolveShow({ show: "Nothing", exclude: [] }, empty.deps))).toBe("SHOW_NOT_FOUND");
    expect(empty.ops).toHaveLength(0);

    const missing = deps({ lookup: null });
    expect(await codeOf(resolveShow({ show: "https://podcasts.apple.com/us/podcast/id1234", exclude: [] }, missing.deps))).toBe(
      "SHOW_NOT_FOUND",
    );
    expect(missing.ops).toHaveLength(0);
  });

  it("gives SHOW_NO_QLOO_MATCH when every candidate is dropped, and passes a Qloo failure through", async () => {
    const unmatched = deps({ search: [show(1), show(2)] }, () => []);
    expect(await codeOf(resolveShow({ show: "Synthetic", exclude: [] }, unmatched.deps))).toBe("SHOW_NO_QLOO_MATCH");
    expect(unmatched.ops).toHaveLength(2);

    const broke = deps({ search: [show(1)] }, () => {
      throw new QlooError("QLOO_BUDGET");
    });
    expect(await codeOf(resolveShow({ show: "Synthetic", exclude: [] }, broke.deps))).toBe("QLOO_BUDGET");
  });

  it("strips direction controls from directory names before showing or searching them", async () => {
    const setup = deps({ search: [show(1, { name: "Synthetic‮ Show 1", publisher: "Pub⁦lisher" })] });

    const [found] = await resolveShow({ show: "Synthetic", exclude: [] }, setup.deps);

    expect(found?.name).toBe("Synthetic Show 1");
    expect(found?.publisher).toBe("Publisher");
    expect(setup.ops[0]).toMatchObject({ query: "Synthetic Show 1" });
  });
});
