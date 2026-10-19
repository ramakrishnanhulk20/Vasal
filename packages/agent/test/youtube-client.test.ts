// Covers the YouTube client against a fake fetch fed hand-written synthetic
// JSON, plus two local HTTP servers for the redirect check. It does not cover
// the real Google host, real response shapes or real unit costs (only a live
// run with a key can), the database meter behind reserveUnits, or the demo.
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createYouTubeClient, type YouTubeClientOptions } from "../src/youtube/client.js";
import { YouTubeError } from "../src/youtube/errors.js";

// Shaped so secret scanners do not mistake it for a real Google key.
const FAKE_KEY = "FAKE-youtube-key-must-never-leak-5c2e";
const CHANNEL = "UCsyntheticChannel000001";
const UPLOADS = "UUsyntheticChannel000001";
const PUBLISHED = "2025-01-02T03:04:05Z";
const ALLOWED_PATHS = new Set(["/youtube/v3/channels", "/youtube/v3/playlistItems", "/youtube/v3/videos"]);

const videoId = (n: number) => `vid${String(n).padStart(8, "0")}`;

// Every URL the client asked for anywhere in this file, checked by the last test.
const everyUrl: URL[] = [];

type Captured = { url: URL; init: RequestInit };
type Handler = (url: URL) => Response | Promise<Response>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const channelBody = (id = CHANNEL) => ({
  kind: "youtube#channelListResponse",
  items: [{ id, snippet: { title: "Synthetic Channel" }, contentDetails: { relatedPlaylists: { uploads: UPLOADS, likes: "" } } }],
});

const playlistPage = (from: number, count: number, nextPageToken?: string) => ({
  items: Array.from({ length: count }, (_, i) => ({
    snippet: { title: `Synthetic Episode ${from + i}` },
    contentDetails: { videoId: videoId(from + i), videoPublishedAt: PUBLISHED },
  })),
  ...(nextPageToken === undefined ? {} : { nextPageToken }),
});

const videoItem = (id: string, viewCount: string | null = "1234", duration = "PT1H2M3S") => ({
  id,
  snippet: { title: `Synthetic Video ${id}`, publishedAt: PUBLISHED, channelId: CHANNEL },
  statistics: viewCount === null ? { likeCount: "5" } : { viewCount, likeCount: "5" },
  contentDetails: { duration },
});

const echoVideos: Handler = (url) =>
  json(200, { items: (url.searchParams.get("id") ?? "").split(",").map((id) => videoItem(id)) });

const happyRouter: Handler = (url) => {
  if (url.pathname === "/youtube/v3/channels") return json(200, channelBody());
  if (url.pathname === "/youtube/v3/playlistItems") {
    return json(200, url.searchParams.has("pageToken") ? playlistPage(51, 10) : playlistPage(1, 50, "page2"));
  }
  if (url.pathname === "/youtube/v3/videos") return echoVideos(url);
  return json(404, {});
};

function fakeFetch(handler: Handler, log?: string[]) {
  const captured: Captured[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    captured.push({ url, init: init ?? {} });
    everyUrl.push(url);
    log?.push("fetch");
    return handler(url);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, captured };
}

function inOrder(...responses: Array<() => Response>): Handler {
  let index = 0;
  return () => {
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next === undefined) throw new Error("empty script");
    return next();
  };
}

function meter(allow = Number.POSITIVE_INFINITY, log?: string[]) {
  let granted = 0;
  return vi.fn(async (units: number) => {
    log?.push(`reserve ${units}`);
    if (granted + units > allow) return false;
    granted += units;
    return true;
  });
}

function client(fetchImpl: typeof fetch, extra: Partial<YouTubeClientOptions> = {}) {
  return createYouTubeClient({ apiKey: FAKE_KEY, reserveUnits: meter(), fetchImpl, sleep: async () => undefined, ...extra });
}

async function failureOf(promise: Promise<unknown>): Promise<YouTubeError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof YouTubeError) return error;
    throw new Error(`expected a YouTubeError, got ${String(error)}`);
  }
  throw new Error("expected the call to fail");
}

function expectNoKey(value: unknown) {
  const text =
    value instanceof Error
      ? [
          value.message,
          String(value),
          value.stack ?? "",
          JSON.stringify(value),
          ...Object.getOwnPropertyNames(value).map((name) => String((value as unknown as Record<string, unknown>)[name])),
        ].join("\n")
      : JSON.stringify(value);
  expect(text).not.toContain(FAKE_KEY);
  expect(text).not.toContain("never-leak-5c2e");
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; origin: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${port}` };
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("createYouTubeClient", () => {
  it("sends the key only in the X-goog-api-key header and never in a URL, result or error (C4.1, C4.3)", async () => {
    const { fetchImpl, captured } = fakeFetch(happyRouter);
    const yt = client(fetchImpl);

    const channel = await yt.channelUploads(CHANNEL);
    const refs = await yt.listUploads(channel.uploadsPlaylistId, { maxItems: 60 });
    const stats = await yt.videoStats(refs.map((ref) => ref.videoId));

    expect(captured).toHaveLength(5);
    for (const { url, init } of captured) {
      const headers = new Headers(init.headers);
      expect(init.method).toBe("GET");
      expect(init.redirect).toBe("error");
      expect(init.body).toBeUndefined();
      expect(headers.get("x-goog-api-key")).toBe(FAKE_KEY);
      expect([...headers.keys()].sort()).toEqual(["accept", "x-goog-api-key"]);
      expect(url.href).not.toContain(FAKE_KEY);
      expect(url.searchParams.has("key")).toBe(false);
    }
    expectNoKey({ channel, refs, stats });

    const failures: Handler[] = [
      () => json(400, { error: { message: `bad ${FAKE_KEY}`, errors: [{ reason: "keyInvalid", message: FAKE_KEY }] } }),
      () => json(403, { error: { message: FAKE_KEY, errors: [{ reason: "quotaExceeded" }] } }),
      () => json(401, { echoed: FAKE_KEY }),
      () => json(404, { echoed: FAKE_KEY }),
      () => json(500, { echoed: FAKE_KEY }),
      () => new Response(`not json ${FAKE_KEY}`, { status: 200 }),
      (url) => {
        throw new TypeError(`fetch failed for ${url.href} with X-goog-api-key: ${FAKE_KEY}`);
      },
    ];
    for (const handler of failures) {
      const error = await failureOf(client(fakeFetch(handler).fetchImpl).channelUploads(CHANNEL));
      expectNoKey(error);
      expect(Object.hasOwn(error, "cause")).toBe(false);
    }
  });

  it("reserves 1 unit before every request, counting each page and each retry (C5.1)", async () => {
    const log: string[] = [];
    const reserveUnits = meter(Number.POSITIVE_INFINITY, log);
    let videoCalls = 0;
    const { fetchImpl, captured } = fakeFetch((url) => {
      if (url.pathname.endsWith("/channels")) return json(200, channelBody());
      if (url.pathname.endsWith("/playlistItems")) {
        const token = url.searchParams.get("pageToken");
        if (token === null) return json(200, playlistPage(1, 50, "p2"));
        return json(200, token === "p2" ? playlistPage(51, 50, "p3") : playlistPage(101, 20));
      }
      videoCalls += 1;
      return videoCalls === 1 ? json(503, {}) : echoVideos(url);
    }, log);
    const yt = client(fetchImpl, { reserveUnits });

    await yt.channelUploads(CHANNEL);
    const refs = await yt.listUploads(UPLOADS);
    await yt.videoStats(refs.slice(0, 50).map((ref) => ref.videoId));

    expect(refs).toHaveLength(120);
    expect(captured).toHaveLength(6);
    expect(reserveUnits).toHaveBeenCalledTimes(6);
    expect(reserveUnits.mock.calls.every(([units]) => units === 1)).toBe(true);
    expect(log).toEqual(Array.from({ length: 6 }, () => ["reserve 1", "fetch"]).flat());
  });

  it("throws YT_BUDGET_REFUSED and sends nothing more once reserveUnits refuses (C5.1)", async () => {
    const never = fakeFetch(happyRouter);
    const refused = await failureOf(client(never.fetchImpl, { reserveUnits: meter(0) }).channelUploads(CHANNEL));
    expect(refused.code).toBe("YT_BUDGET_REFUSED");
    expect(never.captured).toHaveLength(0);

    const endless = fakeFetch((url) => json(200, playlistPage(1, 50, `${url.searchParams.get("pageToken") ?? ""}n`)));
    const midPaging = await failureOf(client(endless.fetchImpl, { reserveUnits: meter(1) }).listUploads(UPLOADS));
    expect(midPaging.code).toBe("YT_BUDGET_REFUSED");
    expect(endless.captured).toHaveLength(1);

    const flaky = fakeFetch(inOrder(() => json(503, {}), () => json(200, channelBody())));
    const beforeRetry = await failureOf(client(flaky.fetchImpl, { reserveUnits: meter(1) }).channelUploads(CHANNEL));
    expect(beforeRetry.code).toBe("YT_BUDGET_REFUSED");
    expect(flaky.captured).toHaveLength(1);

    const odd = fakeFetch(happyRouter);
    const throwing = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    const notTrue = vi.fn(async () => 1 as unknown as boolean);
    for (const reserveUnits of [throwing, notTrue]) {
      const error = await failureOf(client(odd.fetchImpl, { reserveUnits }).channelUploads(CHANNEL));
      expect(error.code).toBe("YT_BUDGET_REFUSED");
    }
    expect(odd.captured).toHaveLength(0);
  });

  it("never sends a request to the search endpoint from any method (C8.5)", async () => {
    const { fetchImpl, captured } = fakeFetch(happyRouter);
    const yt = client(fetchImpl);

    const channel = await yt.channelUploads(CHANNEL);
    const refs = await yt.listUploads(channel.uploadsPlaylistId);
    await yt.videoStats(refs.map((ref) => ref.videoId));

    expect(captured.map(({ url }) => url.pathname)).toEqual([
      "/youtube/v3/channels",
      "/youtube/v3/playlistItems",
      "/youtube/v3/playlistItems",
      "/youtube/v3/videos",
      "/youtube/v3/videos",
    ]);
    for (const { url } of captured) {
      expect(url.protocol).toBe("https:");
      expect(url.host).toBe("www.googleapis.com");
      expect(url.pathname).not.toMatch(/search/i);
    }
  });

  it("refuses bad channel, playlist and video ids before any reservation or request", async () => {
    const { fetchImpl, captured } = fakeFetch(happyRouter);
    const reserveUnits = meter();
    const yt = client(fetchImpl, { reserveUnits });

    const badChannels = [
      "",
      "UC123",
      "UCsyntheticChannel00000",
      "UCsyntheticChannel0000012",
      "UUsyntheticChannel000001",
      "UCsyntheticChannel00000&",
      "UCsyntheticChannel00000#",
      "UCsyntheticChannel00/../",
      " UCsyntheticChannel00000",
      "UCsyntheticChannel00000é",
      [CHANNEL] as unknown as string,
    ];
    for (const id of badChannels) {
      expect((await failureOf(yt.channelUploads(id))).code, JSON.stringify(id)).toBe("YT_BAD_INPUT");
    }

    const badPlaylists = ["", "short", "a".repeat(65), "PLsynthetic/../search", "PLsynthetic&key=x", "PLsynthetic list"];
    for (const id of badPlaylists) {
      expect((await failureOf(yt.listUploads(id))).code, JSON.stringify(id)).toBe("YT_BAD_INPUT");
    }
    for (const maxItems of [0, 2001, 1.5, Number.NaN, -1]) {
      expect((await failureOf(yt.listUploads(UPLOADS, { maxItems }))).code, String(maxItems)).toBe("YT_BAD_INPUT");
    }

    const badVideos = ["vid0000001", "vid000000012", "vid0000000#", "vid0000000&", "vid000000 1", "vid0000000."];
    for (const id of badVideos) {
      expect((await failureOf(yt.videoStats([videoId(1), id]))).code, JSON.stringify(id)).toBe("YT_BAD_INPUT");
    }
    const tooMany = Array.from({ length: 2001 }, (_, i) => videoId(i));
    expect((await failureOf(yt.videoStats(tooMany))).code).toBe("YT_BAD_INPUT");
    expect((await failureOf(yt.videoStats(new Array<string>(3)))).code).toBe("YT_BAD_INPUT");

    expect(captured).toHaveLength(0);
    expect(reserveUnits).not.toHaveBeenCalled();
  });

  it("builds each query with URLSearchParams, so an upstream page token cannot add parameters (C2.3)", async () => {
    const hostile = "tok&key=evil#frag";
    const { fetchImpl, captured } = fakeFetch((url) =>
      json(200, url.searchParams.has("pageToken") ? playlistPage(51, 5) : playlistPage(1, 50, hostile)),
    );

    await client(fetchImpl).listUploads(UPLOADS);

    expect(captured).toHaveLength(2);
    const [first, second] = captured.map(({ url }) => url);
    expect([...(first?.searchParams ?? [])]).toEqual([
      ["part", "snippet,contentDetails"],
      ["playlistId", UPLOADS],
      ["maxResults", "50"],
    ]);
    expect(second?.searchParams.get("pageToken")).toBe(hostile);
    expect([...(second?.searchParams.keys() ?? [])]).toEqual(["part", "playlistId", "maxResults", "pageToken"]);
    expect(second?.hash).toBe("");
  });

  it("follows nextPageToken, stops at maxItems, and stops after 40 pages", async () => {
    const chained = fakeFetch((url) => {
      const token = url.searchParams.get("pageToken");
      if (token === null) return json(200, playlistPage(1, 50, "p2"));
      return json(200, token === "p2" ? playlistPage(51, 50, "p3") : playlistPage(101, 20));
    });
    const all = await client(chained.fetchImpl).listUploads(UPLOADS);
    expect(all).toHaveLength(120);
    expect(chained.captured.map(({ url }) => url.searchParams.get("pageToken"))).toEqual([null, "p2", "p3"]);
    expect(all[0]).toEqual({ videoId: videoId(1), title: "Synthetic Episode 1", publishedAt: PUBLISHED });
    expect(all.at(-1)?.videoId).toBe(videoId(120));

    const endlessPages = (size: number) =>
      fakeFetch((url) => {
        const page = Number(url.searchParams.get("pageToken") ?? "0");
        return json(200, playlistPage(page * size + 1, size, String(page + 1)));
      });

    const capped = endlessPages(50);
    expect(await client(capped.fetchImpl).listUploads(UPLOADS, { maxItems: 120 })).toHaveLength(120);
    expect(capped.captured).toHaveLength(3);

    const byDefault = endlessPages(50);
    expect(await client(byDefault.fetchImpl).listUploads(UPLOADS)).toHaveLength(500);
    expect(byDefault.captured).toHaveLength(10);

    const shortPages = endlessPages(10);
    expect(await client(shortPages.fetchImpl).listUploads(UPLOADS, { maxItems: 2000 })).toHaveLength(400);
    expect(shortPages.captured).toHaveLength(40);

    const stuck = fakeFetch(() => json(200, playlistPage(1, 5, "same")));
    await client(stuck.fetchImpl).listUploads(UPLOADS);
    expect(stuck.captured).toHaveLength(2);
  });

  it("asks for 120 video ids in 3 requests of at most 50, and asks for a duplicate once", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => videoId(i + 1));
    const { fetchImpl, captured } = fakeFetch(echoVideos);

    const stats = await client(fetchImpl).videoStats([...ids, videoId(1), videoId(77)]);

    const batches = captured.map(({ url }) => (url.searchParams.get("id") ?? "").split(","));
    expect(batches.map((batch) => batch.length)).toEqual([50, 50, 20]);
    expect(batches.flat()).toEqual(ids);
    for (const { url } of captured) {
      expect([...url.searchParams.keys()]).toEqual(["part", "id"]);
      expect(url.searchParams.get("part")).toBe("snippet,statistics,contentDetails");
    }
    expect(stats.map((row) => row.videoId)).toEqual(ids);
    expect(stats[0]).toEqual({
      videoId: videoId(1),
      channelId: CHANNEL,
      title: `Synthetic Video ${videoId(1)}`,
      publishedAt: PUBLISHED,
      viewCount: 1234,
      durationSec: 3723,
    });

    const empty = fakeFetch(echoVideos);
    expect(await client(empty.fetchImpl).videoStats([])).toEqual([]);
    expect(empty.captured).toHaveLength(0);
  });

  it("maps YouTube error reasons to fixed codes and retries only 5xx", async () => {
    const reason = (status: number, value: string) =>
      json(status, { error: { code: status, message: "synthetic upstream text", errors: [{ reason: value, message: "synthetic upstream text" }] } });
    const cases: Array<[string, () => Response, string, number]> = [
      ["403 quotaExceeded", () => reason(403, "quotaExceeded"), "YT_QUOTA", 1],
      ["403 dailyLimitExceeded", () => reason(403, "dailyLimitExceeded"), "YT_QUOTA", 1],
      ["400 keyInvalid, as documented", () => reason(400, "keyInvalid"), "YT_AUTH", 1],
      [
        "400 badRequest with ErrorInfo API_KEY_INVALID, as Google answered a bad key on 19 Oct 2026",
        () =>
          json(400, {
            error: {
              code: 400,
              message: "synthetic upstream text",
              errors: [{ message: "synthetic upstream text", domain: "global", reason: "badRequest" }],
              status: "INVALID_ARGUMENT",
              details: [
                { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID", domain: "googleapis.com" },
                { "@type": "type.googleapis.com/google.rpc.LocalizedMessage", locale: "en-US", message: "synthetic upstream text" },
              ],
            },
          }),
        "YT_AUTH",
        1,
      ],
      ["400 badRequest alone", () => reason(400, "badRequest"), "YT_UPSTREAM", 1],
      ["401", () => json(401, {}), "YT_AUTH", 1],
      ["403 forbidden", () => reason(403, "forbidden"), "YT_AUTH", 1],
      ["403 with no body", () => new Response(null, { status: 403 }), "YT_AUTH", 1],
      ["404 playlistNotFound", () => reason(404, "playlistNotFound"), "YT_NOT_FOUND", 1],
      ["429", () => reason(429, "rateLimitExceeded"), "YT_UPSTREAM", 1],
      ["302 handed back by a fetch stand-in", () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }), "YT_UPSTREAM", 1],
      ["500 every time", () => reason(500, "backendError"), "YT_UPSTREAM", 3],
    ];
    for (const [label, response, code, attempts] of cases) {
      const { fetchImpl, captured } = fakeFetch(inOrder(response));
      const error = await failureOf(client(fetchImpl).channelUploads(CHANNEL));
      expect(error.code, label).toBe(code);
      expect(error.message, label).not.toContain("synthetic upstream text");
      expect(captured, label).toHaveLength(attempts);
    }
  });

  it("succeeds when 503 comes twice and then 200, waiting 500 ms then 1500 ms", async () => {
    const { fetchImpl, captured } = fakeFetch(inOrder(() => json(503, {}), () => json(503, {}), () => json(200, channelBody())));
    const sleep = vi.fn(async (_ms: number) => undefined);
    const reserveUnits = meter();

    const result = await client(fetchImpl, { sleep, reserveUnits }).channelUploads(CHANNEL);

    expect(result).toEqual({ channelTitle: "Synthetic Channel", uploadsPlaylistId: UPLOADS });
    expect(captured).toHaveLength(3);
    expect(reserveUnits).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 1500]);
  });

  it("fails with YT_UPSTREAM when 503 comes three times", async () => {
    const { fetchImpl, captured } = fakeFetch(inOrder(() => json(503, {})));
    const sleep = vi.fn(async (_ms: number) => undefined);

    const error = await failureOf(client(fetchImpl, { sleep }).channelUploads(CHANNEL));

    expect(error.code).toBe("YT_UPSTREAM");
    expect(captured).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("refuses a 3 MiB body with YT_UPSTREAM without retrying, and stops reading a longer one", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    const streamOf = (chunks: number, onPull: () => void, onCancel: () => void) =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (chunks === 0) {
              controller.close();
              return;
            }
            chunks -= 1;
            onPull();
            controller.enqueue(chunk);
          },
          cancel: onCancel,
        }),
        { status: 200 },
      );

    const threeMiB = fakeFetch(() => streamOf(3, () => undefined, () => undefined));
    const error = await failureOf(client(threeMiB.fetchImpl).channelUploads(CHANNEL));
    expect(error.code).toBe("YT_UPSTREAM");
    expect(threeMiB.captured).toHaveLength(1);

    let pulled = 0;
    let cancelled = false;
    const long = fakeFetch(() =>
      streamOf(
        64,
        () => (pulled += 1),
        () => {
          cancelled = true;
        },
      ),
    );
    expect((await failureOf(client(long.fetchImpl).channelUploads(CHANNEL))).code).toBe("YT_UPSTREAM");
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(4);
    expect(long.captured).toHaveLength(1);
  });

  it("refuses redirects, so the key never reaches a redirect target", async () => {
    const reached: IncomingHttpHeaders[] = [];
    const attacker = await listen((req, res) => {
      reached.push(req.headers);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(channelBody()));
    });
    const upstream = await listen((_req, res) => {
      res.writeHead(302, { location: `${attacker.origin}/collect` }).end();
    });
    try {
      // Control: a fetch that follows redirects does carry the header to the other host.
      await fetch(`${upstream.origin}/youtube/v3/channels`, { headers: { "X-goog-api-key": FAKE_KEY }, redirect: "follow" });
      expect(reached).toHaveLength(1);
      expect(reached[0]?.["x-goog-api-key"]).toBe(FAKE_KEY);
      reached.length = 0;

      const viaLocal = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const sent = new URL(String(input));
        everyUrl.push(sent);
        return fetch(`${upstream.origin}${sent.pathname}${sent.search}`, init);
      });
      const error = await failureOf(client(viaLocal as unknown as typeof fetch).channelUploads(CHANNEL));

      expect(error.code).toBe("YT_UPSTREAM");
      expectNoKey(error);
      expect(viaLocal).toHaveBeenCalledTimes(1);
      expect(reached).toHaveLength(0);
    } finally {
      await closeServer(upstream.server);
      await closeServer(attacker.server);
    }
  });

  it("turns a timed-out attempt into YT_TIMEOUT without retrying", async () => {
    const hanging = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );

    const error = await failureOf(client(hanging as unknown as typeof fetch, { timeoutMs: 20 }).channelUploads(CHANNEL));

    expect(error.code).toBe("YT_TIMEOUT");
    expect(hanging).toHaveBeenCalledTimes(1);
  });

  it("reports YT_SCHEMA for a body that is not JSON or does not have the expected shape", async () => {
    const channelBodies: Array<() => Response> = [
      () => new Response("<html>not json</html>", { status: 200 }),
      () => json(200, null),
      () => json(200, { items: "nope" }),
      () => json(200, { items: [{ ...channelBody().items[0], id: "not-a-channel" }] }),
    ];
    for (const body of channelBodies) {
      const error = await failureOf(client(fakeFetch(body).fetchImpl).channelUploads(CHANNEL));
      expect(error.code).toBe("YT_SCHEMA");
      expect(error.message).not.toContain("html");
    }

    const page = playlistPage(1, 1);
    const playlistBodies: unknown[] = [
      { items: [{ ...page.items[0], contentDetails: { videoId: "short" } }] },
      { items: [{ ...page.items[0], contentDetails: { videoId: videoId(1), videoPublishedAt: "yesterday" } }] },
      { items: [], nextPageToken: "has space" },
      { items: [], nextPageToken: "x".repeat(257) },
    ];
    for (const body of playlistBodies) {
      const error = await failureOf(client(fakeFetch(() => json(200, body)).fetchImpl).listUploads(UPLOADS));
      expect(error.code, JSON.stringify(body).slice(0, 80)).toBe("YT_SCHEMA");
    }

    const asked = videoId(1);
    const videoBodies: unknown[] = [
      { items: [videoItem(asked, "12a")] },
      { items: [videoItem(asked, "99999999999999999")] },
      { items: [videoItem(asked, "-1")] },
      { items: [videoItem(asked, "1.5")] },
      { items: [videoItem(videoId(2))] },
      { items: [videoItem(asked), videoItem(asked)] },
      { items: [{ ...videoItem(asked), snippet: { title: "t", publishedAt: "yesterday", channelId: CHANNEL } }] },
      { items: [{ ...videoItem(asked), snippet: { title: "t", publishedAt: PUBLISHED, channelId: "bad" } }] },
      { items: [{ id: asked, snippet: videoItem(asked).snippet, statistics: { viewCount: "1" } }] },
    ];
    for (const body of videoBodies) {
      const error = await failureOf(client(fakeFetch(() => json(200, body)).fetchImpl).videoStats([asked]));
      expect(error.code, JSON.stringify(body).slice(0, 80)).toBe("YT_SCHEMA");
    }
  });

  it("drops a video whose view count is hidden instead of reading it as 0", async () => {
    const [visibleZero, hidden, noStatistics, oddDuration] = [1, 2, 3, 4].map(videoId) as [string, string, string, string];
    const { fetchImpl } = fakeFetch(() =>
      json(200, {
        items: [
          videoItem(visibleZero, "0"),
          videoItem(hidden, null),
          { ...videoItem(noStatistics), statistics: undefined },
          videoItem(oddDuration, "42", "P1W"),
        ],
      }),
    );

    const stats = await client(fetchImpl).videoStats([visibleZero, hidden, noStatistics, oddDuration]);

    expect(stats.map((row) => row.videoId)).toEqual([visibleZero, oddDuration]);
    expect(stats[0]?.viewCount).toBe(0);
    expect(stats[1]).toMatchObject({ viewCount: 42, durationSec: null });
  });

  it("reads a channel's title and uploads playlist, and reports YT_NOT_FOUND when that channel does not come back", async () => {
    const { fetchImpl, captured } = fakeFetch(() => json(200, channelBody()));
    expect(await client(fetchImpl).channelUploads(CHANNEL)).toEqual({
      channelTitle: "Synthetic Channel",
      uploadsPlaylistId: UPLOADS,
    });
    expect([...(captured[0]?.url.searchParams ?? [])]).toEqual([
      ["part", "snippet,contentDetails"],
      ["id", CHANNEL],
    ]);

    for (const body of [{ kind: "youtube#channelListResponse", pageInfo: { totalResults: 0 } }, channelBody("UCsyntheticChannel000002")]) {
      const error = await failureOf(client(fakeFetch(() => json(200, body)).fetchImpl).channelUploads(CHANNEL));
      expect(error.code).toBe("YT_NOT_FOUND");
    }
  });

  it("refuses a blank key with YT_KEY_MISSING and a key with spaces with YT_BAD_INPUT, without echoing it", () => {
    const { fetchImpl } = fakeFetch(happyRouter);
    const reserveUnits = meter();
    for (const apiKey of ["", "   "]) {
      expect(() => createYouTubeClient({ apiKey, reserveUnits, fetchImpl })).toThrow(expect.objectContaining({ code: "YT_KEY_MISSING" }));
    }
    try {
      createYouTubeClient({ apiKey: `has space ${FAKE_KEY}`, reserveUnits, fetchImpl });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toMatchObject({ code: "YT_BAD_INPUT" });
      expectNoKey(error);
    }
    expect(reserveUnits).not.toHaveBeenCalled();
  });

  it("sent every request in this file to channels, playlistItems or videos on www.googleapis.com, never search (C8.5)", () => {
    expect(everyUrl.length).toBeGreaterThan(100);
    for (const url of everyUrl) {
      expect(url.origin).toBe("https://www.googleapis.com");
      expect(ALLOWED_PATHS.has(url.pathname), url.pathname).toBe(true);
    }
  });
});
