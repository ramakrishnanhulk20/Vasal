// Covers the live backtest wiring with fakes: the exact Qloo operations each
// dependency sends through the metered client, how answers are read, the fit
// batch size through buildDataset, and the precision sample and its CSV. It
// does not cover the real Qloo, YouTube or model clients (their own tests do),
// the metered client's cache and meter (qloo-metered.test.ts), or
// scripts/backtest.ts, which never runs in tests. Every id, name and score
// here is invented; no Qloo data is used.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLivePipelineDeps, precisionSample, precisionSampleCsv } from "../src/backtest/live.js";
import { buildDataset } from "../src/backtest/pipeline.js";
import type { DatasetRow, ShowConfig } from "../src/backtest/types.js";
import { QlooError } from "../src/qloo/errors.js";
import type { MeteredQloo } from "../src/qloo/metered.js";
import { buildQlooRequest, type QlooOperation } from "../src/qloo/request.js";
import type { Db } from "../src/store/db.js";
import type { YouTubeClient } from "../src/youtube/client.js";

const BASE = new URL("https://hackathon.api.qloo.com");
const NOW = new Date("2026-10-19T00:00:00.000Z");
const PODCAST_ID = "00000000-0000-4000-8000-00000000a001";
const CHANNEL = `UC${"s".repeat(22)}`;
const personId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const guestName = (n: number) => `Synthetic Guest ${n}`;

// Any direct database use by the live deps fails the test: Qloo budget and
// cache must only be reached through the metered client.
const untouchableDb: Db = {
  query: async () => {
    throw new Error("the live deps queried the database directly");
  },
  transaction: async () => {
    throw new Error("the live deps opened a transaction directly");
  },
  close: async () => {},
};

const noYouTube: YouTubeClient = {
  channelUploads: async () => {
    throw new Error("unexpected YouTube call");
  },
  listUploads: async () => {
    throw new Error("unexpected YouTube call");
  },
  videoStats: async () => {
    throw new Error("unexpected YouTube call");
  },
};

const fetchSpy = vi.fn(async () => {
  throw new Error("no network in tests");
});

beforeEach(() => {
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// The fake runs each operation through the real request builder first, so an
// operation the live client would refuse fails here too.
function fakeQloo(answer: (op: QlooOperation) => unknown) {
  const ops: QlooOperation[] = [];
  const qloo: MeteredQloo = {
    async call<T>(op: QlooOperation) {
      buildQlooRequest(BASE, op);
      ops.push(op);
      const data = answer(op);
      if (data instanceof Error) throw data;
      return { data: data as T, fromCache: false };
    },
    stats: () => ({ calls: ops.length, cacheHits: 0 }),
  };
  return { qloo, ops };
}

function depsWith(qloo: MeteredQloo, youtube: YouTubeClient = noYouTube) {
  return createLivePipelineDeps({ db: untouchableDb, qloo, youtube, extractGuest: async () => ({ kind: "none" }), now: () => NOW });
}

describe("findPodcasts", () => {
  it("sends one podcast search with take 5 and reads id and name", async () => {
    const { qloo, ops } = fakeQloo(() => [
      { entity_id: PODCAST_ID, name: "Synthetic Show", popularity: 0.9 },
      { entity_id: personId(9), name: "Synthetic Show Extra" },
    ]);

    const found = await depsWith(qloo).findPodcasts("Synthetic Show");

    expect(ops).toEqual([{ op: "search", query: "Synthetic Show", types: ["urn:entity:podcast"], take: 5 }]);
    expect(found).toEqual([
      { id: PODCAST_ID, name: "Synthetic Show" },
      { id: personId(9), name: "Synthetic Show Extra" },
    ]);
  });
});

describe("resolvePerson", () => {
  it("sends one person search with take 1 and returns the top result", async () => {
    const { qloo, ops } = fakeQloo(() => [{ entity_id: personId(1), name: guestName(1), popularity: 0.42 }]);

    expect(await depsWith(qloo).resolvePerson(guestName(1))).toEqual({ id: personId(1), name: guestName(1), popularity: 0.42 });
    expect(ops).toEqual([{ op: "search", query: guestName(1), types: ["urn:entity:person"], take: 1 }]);
  });

  it("returns null for no result, keeps a person with no popularity, and passes other failures on", async () => {
    const empty = fakeQloo(() => []);
    expect(await depsWith(empty.qloo).resolvePerson(guestName(1))).toBeNull();

    const noPopularity = fakeQloo(() => [{ entity_id: personId(1), name: guestName(1), popularity: null }]);
    const person = await depsWith(noPopularity.qloo).resolvePerson(guestName(1));
    expect(person?.id).toBe(personId(1));
    expect(Number.isNaN(person?.popularity)).toBe(true);

    const spent = fakeQloo(() => new QlooError("QLOO_BUDGET"));
    await expect(depsWith(spent.qloo).resolvePerson(guestName(1))).rejects.toMatchObject({ code: "QLOO_BUDGET" });
  });

  it("returns null without a call for a name the request builder refuses", async () => {
    const { qloo, ops } = fakeQloo(() => []);

    expect(await depsWith(qloo).resolvePerson("Bad \uD800 Name")).toBeNull();
    expect(ops).toEqual([]);
  });
});

describe("fitScores", () => {
  it("sends one insights call with the podcast as signal and the batch as results", async () => {
    const { qloo, ops } = fakeQloo(() => [
      { entity_id: personId(1), name: guestName(1), popularity: 0.3, query: { affinity: 0.8 } },
      { entity_id: personId(2), name: guestName(2), properties: { affinity: 0.6 } },
      { entity_id: personId(3), name: guestName(3), popularity: 0.5 },
      { entity_id: personId(7), name: "Not Asked For", popularity: 0.5, query: { affinity: 0.99 } },
      { entity_id: personId(1), name: guestName(1), popularity: 0.1, query: { affinity: 0.1 } },
    ]);

    const scores = await depsWith(qloo).fitScores(PODCAST_ID, [personId(1), personId(2), personId(3)]);

    expect(ops).toEqual([
      {
        op: "insights",
        filterType: "urn:entity:person",
        signalEntities: [PODCAST_ID],
        resultEntities: [personId(1), personId(2), personId(3)],
        take: 3,
      },
    ]);
    expect([...scores]).toEqual([
      [personId(1), { affinity: 0.8, popularity: 0.3 }],
      [personId(2), { affinity: 0.6, popularity: null }],
    ]);
  });

  it("refuses more than 25 ids and makes no call for none", async () => {
    const { qloo, ops } = fakeQloo(() => []);
    const deps = depsWith(qloo);

    await expect(deps.fitScores(PODCAST_ID, Array.from({ length: 26 }, (_, i) => personId(i + 1)))).rejects.toThrow(RangeError);
    expect(await deps.fitScores(PODCAST_ID, [])).toEqual(new Map());
    expect(ops).toEqual([]);
  });
});

describe("live deps through buildDataset", () => {
  const GUESTS = 60;
  const show: ShowConfig = {
    name: "Synthetic Show",
    youtubeChannelId: CHANNEL,
    youtubeHandle: "@syntheticshow",
    evidenceUrl: "https://example.com/synthetic",
    checkedOn: "2026-10-19",
  };
  const videoId = (n: number) => `v${String(n).padStart(10, "0")}`;

  const youtube: YouTubeClient = {
    channelUploads: async () => ({ channelTitle: "Synthetic Show", uploadsPlaylistId: `UU${"s".repeat(22)}` }),
    listUploads: async () =>
      Array.from({ length: GUESTS }, (_, i) => ({ videoId: videoId(i + 1), title: `${guestName(i + 1)}: a long talk`, publishedAt: "2025-06-01T12:00:00Z" })),
    videoStats: async (ids) =>
      ids.map((id, i) => ({
        videoId: id,
        channelId: CHANNEL,
        title: `${guestName(i + 1)}: a long talk`,
        publishedAt: "2025-06-01T12:00:00Z",
        viewCount: 1_000 * (i + 1),
        durationSec: 3_600,
      })),
  };

  it("sends only the documented operations, asks for fit in batches of at most 25, and never touches the network", async () => {
    const { qloo, ops } = fakeQloo((op) => {
      if (op.op === "search" && op.types[0] === "urn:entity:podcast") return [{ entity_id: PODCAST_ID, name: "Synthetic Show" }];
      if (op.op === "search") {
        const n = Number(op.query.replace("Synthetic Guest ", ""));
        return [{ entity_id: personId(n), name: op.query, popularity: 0.5 }];
      }
      if (op.op === "insights") {
        return (op.resultEntities ?? []).map((id, i) => ({ entity_id: id, name: "x", popularity: 0.2 + i / 100, query: { affinity: 0.1 + i / 100 } }));
      }
      return new Error(`unexpected operation ${op.op}`);
    });
    const deps = createLivePipelineDeps({
      db: untouchableDb,
      qloo,
      youtube,
      extractGuest: async (title) => ({ kind: "one", name: title.split(":")[0] ?? "" }),
      now: () => NOW,
    });

    const dataset = await buildDataset([show], deps);

    const insights = ops.filter((op) => op.op === "insights");
    expect(insights.map((op) => op.resultEntities?.length)).toEqual([25, 25, 10]);
    for (const op of insights) expect(op).toMatchObject({ filterType: "urn:entity:person", signalEntities: [PODCAST_ID] });
    expect(ops.filter((op) => op.op === "search")).toHaveLength(1 + GUESTS);
    expect(ops).toHaveLength(1 + GUESTS + 3);
    expect(dataset.rows).toHaveLength(GUESTS);
    expect(dataset.shows[0]?.status).toBe("kept");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("precision sample", () => {
  const row = (n: number, title = `Synthetic Guest ${n} talks`): DatasetRow => ({
    showName: "Synthetic Show",
    videoId: `v${String(n).padStart(10, "0")}`,
    title,
    publishedAt: "2025-06-01T12:00:00Z",
    ageDays: 500,
    views: 1_000,
    guestName: guestName(n),
    personId: `QLOOMARKER-${n}`,
    fit: 0.123456789,
    fame: 0.987654321,
  });
  const rows = Array.from({ length: 80 }, (_, i) => row(i + 1));

  it("draws 50 distinct rows, the same ones every time, in dataset order", () => {
    const first = precisionSample(rows);
    const again = precisionSample(rows);

    expect(first).toHaveLength(50);
    expect(new Set(first.map((r) => r.videoId)).size).toBe(50);
    expect(again).toEqual(first);
    const positions = first.map((r) => rows.indexOf(r));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(precisionSample(rows, 50, 1).map((r) => r.videoId)).not.toEqual(first.map((r) => r.videoId));
  });

  it("returns every row when there are 50 or fewer, and refuses a bad size", () => {
    expect(precisionSample(rows.slice(0, 12))).toEqual(rows.slice(0, 12));
    expect(() => precisionSample(rows, 0)).toThrow(RangeError);
  });

  it("writes only video id, title and extracted name, quoted, with formulas defused", () => {
    const csv = precisionSampleCsv([row(1, 'He said "hi", twice'), row(2, "=HYPERLINK(1)"), row(3, "-5 ways")]);

    expect(csv).toBe(
      [
        '"video_id","title","extracted_name"',
        '"v0000000001","He said ""hi"", twice","Synthetic Guest 1"',
        `"v0000000002","'=HYPERLINK(1)","Synthetic Guest 2"`,
        `"v0000000003","'-5 ways","Synthetic Guest 3"`,
        "",
      ].join("\r\n"),
    );
    expect(csv).not.toContain("QLOOMARKER");
    expect(csv).not.toContain("0.123456789");
    expect(csv).not.toContain("0.987654321");
  });
});
