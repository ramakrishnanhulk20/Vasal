// Not covered here: Apple's live API (the feed demo script calls it), and
// what safeFetch itself enforces (safe-fetch.test.ts). Every response below
// is synthetic and the fetch is a stand-in, so no test reaches Apple.
import { describe, expect, it, vi } from "vitest";
import { FeedError } from "../src/feeds/errors.js";
import { createDirectoryLimiter, lookupShow, searchShows } from "../src/feeds/lookup.js";
import type { SafeFetchOptions, SafeFetchResult } from "../src/net/safe-fetch.js";

type Call = { url: URL; opts: SafeFetchOptions | undefined };

function fakeFetch(body: string | Error) {
  const calls: Call[] = [];
  const fetchImpl = async (url: URL, opts?: SafeFetchOptions): Promise<SafeFetchResult> => {
    calls.push({ url, opts });
    if (body instanceof Error) throw body;
    return { finalUrl: url, status: 200, contentType: "text/javascript; charset=utf-8", body };
  };
  return { calls, fetchImpl };
}

function podcast(id: number, name: string, extra: Record<string, unknown> = {}) {
  return {
    wrapperType: "track",
    kind: "podcast",
    collectionId: id,
    collectionName: name,
    artistName: `${name} Media`,
    feedUrl: `https://feeds.example.com/${id}.xml`,
    primaryGenreName: "Comedy",
    ...extra,
  };
}

async function failureCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return err instanceof FeedError ? err.code : "not a FeedError";
  }
  return "did not throw";
}

describe("searchShows", () => {
  it("C2.3: carries the whole show name as one encoded parameter", async () => {
    const { calls, fetchImpl } = fakeFetch(JSON.stringify({ resultCount: 0, results: [] }));
    await searchShows("x&take=500#y", { fetchImpl });
    const sent = calls[0]?.url;
    expect(sent?.origin).toBe("https://itunes.apple.com");
    expect(sent?.pathname).toBe("/search");
    expect(sent?.hash).toBe("");
    expect([...(sent?.searchParams ?? [])]).toEqual([
      ["media", "podcast"],
      ["entity", "podcast"],
      ["term", "x&take=500#y"],
      ["limit", "5"],
    ]);
    expect(calls[0]?.opts?.maxBytes).toBe(2 * 1024 * 1024);
  });

  it("returns validated candidates, drops malformed entries and nulls unsafe feed URLs", async () => {
    const { fetchImpl } = fakeFetch(
      JSON.stringify({
        resultCount: 5,
        results: [
          podcast(111111, "Good Show"),
          podcast(222222, "Script Feed", { feedUrl: "javascript:alert(1)" }),
          podcast(333333, "Ftp Feed", { feedUrl: "ftp://feeds.example.com/x.xml", primaryGenreName: undefined }),
          { kind: "podcast", collectionId: "444444", collectionName: "Id is a string" },
          podcast(555555, "Not a podcast", { kind: "song" }),
        ],
      }),
    );
    const candidates = await searchShows("show", { fetchImpl });
    expect(candidates).toEqual([
      {
        appleId: "111111",
        name: "Good Show",
        publisher: "Good Show Media",
        feedUrl: new URL("https://feeds.example.com/111111.xml"),
        genre: "Comedy",
      },
      { appleId: "222222", name: "Script Feed", publisher: "Script Feed Media", feedUrl: null, genre: "Comedy" },
      { appleId: "333333", name: "Ftp Feed", publisher: "Ftp Feed Media", feedUrl: null, genre: null },
    ]);
  });

  it("refuses an empty or over-long term without making a request", async () => {
    const { calls, fetchImpl } = fakeFetch("{}");
    expect(await failureCode(searchShows("   ", { fetchImpl }))).toBe("FEED_BAD_INPUT");
    expect(await failureCode(searchShows("a".repeat(301), { fetchImpl }))).toBe("FEED_BAD_INPUT");
    expect(calls).toHaveLength(0);
  });

  it("turns fetch, JSON and schema failures into LOOKUP_FAILED with no upstream text", async () => {
    const leaky = new Error("connect ECONNREFUSED 10.1.2.3:443 key=secret");
    for (const body of [leaky, "<html>VASAL-MARKER-7731</html>", JSON.stringify({ results: "nope" })]) {
      const { fetchImpl } = fakeFetch(body);
      const err = await searchShows("show", { fetchImpl }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FeedError);
      expect((err as FeedError).code).toBe("LOOKUP_FAILED");
      expect((err as FeedError).message).not.toMatch(/ECONNREFUSED|10\.1|secret|VASAL/);
      expect((err as FeedError).cause).toBeUndefined();
    }
  });
});

describe("lookupShow", () => {
  it("looks a show up by id and entity, and returns the matching podcast", async () => {
    const { calls, fetchImpl } = fakeFetch(JSON.stringify({ resultCount: 1, results: [podcast(1521578868, "Found")] }));
    const show = await lookupShow("1521578868", { fetchImpl });
    expect([...(calls[0]?.url.searchParams ?? [])]).toEqual([
      ["id", "1521578868"],
      ["entity", "podcast"],
    ]);
    expect(calls[0]?.url.origin + (calls[0]?.url.pathname ?? "")).toBe("https://itunes.apple.com/lookup");
    expect(show?.appleId).toBe("1521578868");
    expect(show?.feedUrl?.href).toBe("https://feeds.example.com/1521578868.xml");
  });

  it("returns null when Apple has no podcast with exactly that id", async () => {
    const empty = fakeFetch(JSON.stringify({ resultCount: 0, results: [] }));
    expect(await lookupShow("123456", { fetchImpl: empty.fetchImpl })).toBeNull();
    const other = fakeFetch(JSON.stringify({ resultCount: 1, results: [podcast(999999, "Other")] }));
    expect(await lookupShow("123456", { fetchImpl: other.fetchImpl })).toBeNull();
  });

  it("refuses an id that is not 3 to 12 digits without making a request", async () => {
    const { calls, fetchImpl } = fakeFetch("{}");
    for (const bad of ["12", "1234567890123", "12a456", "123&id=9"]) {
      expect(await failureCode(lookupShow(bad, { fetchImpl }))).toBe("FEED_BAD_INPUT");
    }
    expect(calls).toHaveLength(0);
  });
});

describe("the Apple directory limiter (D3.7)", () => {
  const EMPTY = JSON.stringify({ resultCount: 0, results: [] });

  function fakeTime(start: number) {
    let at = start;
    const sleeps: number[] = [];
    return {
      now: () => new Date(at),
      sleep: async (ms: number) => {
        sleeps.push(ms);
        at += ms;
      },
      sleeps,
      set: (ms: number) => {
        at = ms;
      },
    };
  }

  it("lets 20 searches and lookups through a minute, holds the 21st up to 5 seconds, fails one that would wait longer, and passes the next minute's", async () => {
    const start = Date.parse("2026-10-24T12:00:00.000Z");
    const time = fakeTime(start);
    const { calls, fetchImpl } = fakeFetch(EMPTY);
    const opts = { fetchImpl, limiter: createDirectoryLimiter({ now: time.now, sleep: time.sleep }) };

    await searchShows("show", opts);
    time.set(start + 30_000);
    for (let i = 0; i < 19; i += 1) await (i % 2 === 0 ? lookupShow("123456", opts) : searchShows("show", opts));
    expect(calls).toHaveLength(20);
    expect(time.sleeps).toEqual([]);

    // The first request turns a minute old 4 seconds from here.
    time.set(start + 56_000);
    await lookupShow("123456", opts);
    expect(time.sleeps).toEqual([4_000]);
    expect(calls).toHaveLength(21);

    // The next place frees when the 19 sent at 30 seconds turn a minute old,
    // 30 seconds away, so this fails at once with the lookup failure code.
    expect(await failureCode(searchShows("show", opts))).toBe("LOOKUP_FAILED");
    expect(time.sleeps).toEqual([4_000]);
    expect(calls).toHaveLength(21);

    time.set(start + 90_000);
    await searchShows("show", opts);
    expect(calls).toHaveLength(22);
    expect(time.sleeps).toEqual([4_000]);
  });

  it("gives up once 5 seconds of waiting would pass, even with a clock that stops moving", async () => {
    const start = Date.parse("2026-10-24T12:00:00.000Z");
    let at = start;
    const sleeps: number[] = [];
    const { calls, fetchImpl } = fakeFetch(EMPTY);
    const limiter = createDirectoryLimiter({
      now: () => new Date(at),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    for (let i = 0; i < 20; i += 1) await searchShows("show", { fetchImpl, limiter });
    at = start + 58_000;

    expect(await failureCode(searchShows("show", { fetchImpl, limiter }))).toBe("LOOKUP_FAILED");
    expect(sleeps).toEqual([2_000, 2_000]);
    expect(calls).toHaveLength(20);
  });

  it("is one limiter for the whole process by default, shared by searchShows and lookupShow", async () => {
    vi.resetModules();
    const fresh = await import("../src/feeds/lookup.js");
    const { calls, fetchImpl } = fakeFetch(EMPTY);

    for (let i = 0; i < 20; i += 1) await (i % 2 === 0 ? fresh.lookupShow("123456", { fetchImpl }) : fresh.searchShows("show", { fetchImpl }));
    const refused = await fresh.searchShows("show", { fetchImpl }).catch((error: unknown) => error);

    // A fresh module brings its own FeedError class, so the code is read directly.
    expect((refused as { code?: unknown }).code).toBe("LOOKUP_FAILED");
    expect(calls).toHaveLength(20);
  });
});
