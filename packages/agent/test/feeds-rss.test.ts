// Not covered here: downloading feeds (safe-fetch.test.ts), feeds in encodings
// other than UTF-8, RSS 1.0 beyond refusing it, and podcast tags other than
// itunes:duration. Every feed below is synthetic.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeedError } from "../src/feeds/errors.js";
import { parseFeed } from "../src/feeds/rss.js";

const MARKER = "VASAL-MARKER-7731";

function failure(run: () => unknown): FeedError {
  try {
    run();
  } catch (err) {
    if (err instanceof FeedError) return err;
    throw err;
  }
  throw new Error("expected parseFeed to throw");
}

function everythingIn(err: FeedError): string {
  return [err.message, err.stack ?? "", String(err), JSON.stringify(err), JSON.stringify(Object.entries(err))].join("\n");
}

function rss(items: string, channelTitle = "Show"): string {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>${channelTitle}</title>${items}</channel></rss>`;
}

function item(title: string, pubDate?: string, extra = ""): string {
  return `<item><title>${title}</title>${pubDate === undefined ? "" : `<pubDate>${pubDate}</pubDate>`}${extra}</item>`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reading RSS 2.0 and Atom", () => {
  it("reads an RSS 2.0 feed: titles, dates, guids and the three duration forms", () => {
    const feed = parseFeed(
      rss(
        [
          item("Hours", "Mon, 12 Oct 2026 07:01:00 +0000", "<guid isPermaLink=\"false\">g-1</guid><itunes:duration>01:02:03</itunes:duration>"),
          item("Minutes", "Mon, 05 Oct 2026 07:01:00 +0000", "<itunes:duration>45:12</itunes:duration>"),
          item("<![CDATA[Seconds & more]]>", "Mon, 28 Sep 2026 07:01:00 +0000", "<itunes:duration>3600</itunes:duration>"),
          item("Bad duration", "Mon, 21 Sep 2026 07:01:00 +0000", "<itunes:duration>12:75</itunes:duration>"),
          item("No date"),
        ].join(""),
        "The Show",
      ),
    );
    expect(feed.title).toBe("The Show");
    expect(feed.episodes).toEqual([
      { title: "Hours", publishedAt: "2026-10-12T07:01:00.000Z", guid: "g-1", durationSec: 3723 },
      { title: "Minutes", publishedAt: "2026-10-05T07:01:00.000Z", guid: null, durationSec: 2712 },
      { title: "Seconds & more", publishedAt: "2026-09-28T07:01:00.000Z", guid: null, durationSec: 3600 },
      { title: "Bad duration", publishedAt: "2026-09-21T07:01:00.000Z", guid: null, durationSec: null },
      { title: "No date", publishedAt: null, guid: null, durationSec: null },
    ]);
  });

  it("reads an Atom feed, using updated when published is missing", () => {
    const feed = parseFeed(
      `<feed xmlns="http://www.w3.org/2005/Atom"><title type="text">Atom Show</title>` +
        `<entry><title>Older</title><id>urn:e:1</id><published>2026-10-01T10:00:00Z</published></entry>` +
        `<entry><title>Newer</title><id>urn:e:2</id><updated>2026-10-05T10:00:00Z</updated></entry></feed>`,
    );
    expect(feed.title).toBe("Atom Show");
    expect(feed.episodes.map((ep) => [ep.title, ep.guid, ep.publishedAt])).toEqual([
      ["Newer", "urn:e:2", "2026-10-05T10:00:00.000Z"],
      ["Older", "urn:e:1", "2026-10-01T10:00:00.000Z"],
    ]);
  });

  it("keeps only the newest 2,000 episodes, newest first", () => {
    const start = Date.UTC(2010, 0, 1);
    const days = Array.from({ length: 2_100 }, (_, i) => i).sort((a, b) => ((a * 7919) % 2_100) - ((b * 7919) % 2_100));
    const items = days.map((day) => item(`Day ${day}`, new Date(start + day * 86_400_000).toUTCString())).join("");
    const feed = parseFeed(rss(items));
    expect(feed.episodes).toHaveLength(2_000);
    expect(feed.episodes[0]?.title).toBe("Day 2099");
    expect(feed.episodes[1_999]?.title).toBe("Day 100");
  });

  it("caps each title at 500 characters without splitting a character", () => {
    const feed = parseFeed(rss(item("\u{1F600}".repeat(600)), "x".repeat(800)));
    expect(Array.from(feed.episodes[0]?.title ?? "")).toHaveLength(500);
    expect(feed.episodes[0]?.title).toBe("\u{1F600}".repeat(500));
    expect(feed.title).toHaveLength(500);
  });

  it("decodes the escapes XML defines, once, and leaves anything else as written", () => {
    const feed = parseFeed(
      rss(
        [
          item("&quot;Jessica Biel&quot;", "Mon, 12 Oct 2026 07:01:00 +0000"),
          item("Tom &amp;amp; Jerry &#8217;s &#x1F600; &lt;b&gt;", "Mon, 05 Oct 2026 07:01:00 +0000"),
          item("&nbsp; &#0; &#xD800; &apos;", "Mon, 28 Sep 2026 07:01:00 +0000"),
        ].join(""),
      ),
    );
    expect(feed.episodes.map((ep) => ep.title)).toEqual([
      '"Jessica Biel"',
      "Tom &amp; Jerry ’s \u{1F600} <b>",
      "&nbsp; &#0; &#xD800; '",
    ]);
  });
});

describe("C1.6 bytes that are not a feed give only a fixed code", () => {
  it("refuses an HTML page and keeps none of its text", () => {
    const err = failure(() =>
      parseFeed(`<html><head><title>Admin</title></head><body><p>${MARKER}</p></body></html>`),
    );
    expect(err.code).toBe("FEED_NOT_A_FEED");
    expect(everythingIn(err)).not.toContain(MARKER);
    expect(err.cause).toBeUndefined();
  });

  it("drops the parser's own error text, which can quote the body", () => {
    const err = failure(() => parseFeed(`<__proto__><p>${MARKER}</p></__proto__>`));
    expect(err.code).toBe("FEED_NOT_A_FEED");
    expect(everythingIn(err)).not.toContain(MARKER);
    expect(everythingIn(err)).not.toContain("__proto__");
    expect(err.cause).toBeUndefined();
  });

  it("refuses other XML, RSS 1.0, JSON and empty input", () => {
    const notFeeds = [
      `<rdf:RDF><channel><title>${MARKER}</title></channel><item><title>x</title></item></rdf:RDF>`,
      `<rss version="2.0"><title>${MARKER}</title></rss>`,
      `<rss version="2.0"><channel></channel></rss>`,
      `{"title": "${MARKER}"}`,
      "",
    ];
    for (const body of notFeeds) {
      const err = failure(() => parseFeed(body));
      expect(err.code).toBe("FEED_NOT_A_FEED");
      expect(everythingIn(err)).not.toContain(MARKER);
    }
  });
});

describe("C1.7 no entity, file or URL is ever resolved", () => {
  function watchSideEffects() {
    return {
      parse: vi.spyOn(XMLParser.prototype, "parse"),
      reads: [
        vi.spyOn(fs, "readFileSync"),
        vi.spyOn(fs, "readFile"),
        vi.spyOn(fs, "openSync"),
        vi.spyOn(fs, "open"),
        vi.spyOn(fs, "createReadStream"),
        vi.spyOn(fs.promises, "readFile"),
      ],
      network: [vi.spyOn(net, "connect"), vi.spyOn(http, "request"), vi.spyOn(http, "get"), vi.spyOn(globalThis, "fetch")],
    };
  }

  it("refuses an XXE file read before the parser runs, and reads no file", () => {
    const secretFile = path.join(os.tmpdir(), `vasal-xxe-${process.pid}.txt`);
    fs.writeFileSync(secretFile, MARKER);
    try {
      const watch = watchSideEffects();
      const payload = `<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///${secretFile.replace(/\\/g, "/")}">]><rss><channel><title>&xxe;</title></channel></rss>`;
      const err = failure(() => parseFeed(payload));
      expect(err.code).toBe("FEED_DOCTYPE_REJECTED");
      expect(everythingIn(err)).not.toContain(MARKER);
      expect(watch.parse).not.toHaveBeenCalled();
      for (const spy of [...watch.reads, ...watch.network]) expect(spy).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(secretFile, { force: true });
    }
  });

  it("refuses an external-entity URL and the server it names gets no request", async () => {
    let requests = 0;
    const server = http.createServer((_req, res) => {
      requests++;
      res.end(MARKER);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as net.AddressInfo;
      const watch = watchSideEffects();
      const payload = `<?xml version="1.0"?><!doctype rss SYSTEM "http://127.0.0.1:${port}/dtd" [<!ENTITY ext SYSTEM "http://127.0.0.1:${port}/x">]><rss><channel><title>&ext;</title></channel></rss>`;
      const err = failure(() => parseFeed(payload));
      expect(err.code).toBe("FEED_DOCTYPE_REJECTED");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(requests).toBe(0);
      expect(watch.parse).not.toHaveBeenCalled();
      for (const spy of watch.network) expect(spy).not.toHaveBeenCalled();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("refuses a billion-laughs payload before any expansion", () => {
    const watch = watchSideEffects();
    const levels = ['<!ENTITY lol0 "lol">'];
    for (let i = 1; i <= 9; i++) levels.push(`<!ENTITY lol${i} "${`&lol${i - 1};`.repeat(10)}">`);
    const payload = `<?xml version="1.0"?><!DOCTYPE rss [${levels.join("")}]><rss><channel><title>&lol9;</title></channel></rss>`;
    const err = failure(() => parseFeed(payload));
    expect(err.code).toBe("FEED_DOCTYPE_REJECTED");
    expect(watch.parse).not.toHaveBeenCalled();
    for (const spy of [...watch.reads, ...watch.network]) expect(spy).not.toHaveBeenCalled();
  });
});

describe("structure limits", () => {
  it("accepts 32 levels of nesting and refuses 33", () => {
    const nested = (levels: number) =>
      `<rss><channel><title>Deep</title>${"<x>".repeat(levels - 2)}${"</x>".repeat(levels - 2)}</channel></rss>`;
    expect(parseFeed(nested(32)).title).toBe("Deep");
    expect(failure(() => parseFeed(nested(33))).code).toBe("FEED_TOO_DEEP");
  });

  it("accepts 300,000 elements and refuses 300,001", () => {
    const withElements = (total: number) => `<rss><channel>${"<x/>".repeat(total - 2)}</channel></rss>`;
    expect(parseFeed(withElements(300_000)).episodes).toEqual([]);
    expect(failure(() => parseFeed(withElements(300_001))).code).toBe("FEED_TOO_DEEP");
  });

  // 24 child tags is what a rich podcast item carries (enclosure, itunes
  // tags, content:encoded and the like), so 2,000 of them pass 50,000 elements.
  it("keeps 2,000 episodes of 24 child tags each, so the episode cap applies before the element cap (R2-8)", () => {
    const extra = Array.from({ length: 22 }, (_, n) => `<tag${n}>x</tag${n}>`).join("");
    const items = Array.from({ length: 2_000 }, (_, n) =>
      item(`Episode ${n}`, new Date(Date.UTC(2010, 0, 1) + n * 86_400_000).toUTCString(), extra),
    );
    // The item's own tag plus title, pubDate and the 22 extra.
    expect(items[0]!.match(/<(?!\/)[^>]+>/g)).toHaveLength(25);

    expect(parseFeed(rss(items.join(""))).episodes).toHaveLength(2_000);
  });
});
