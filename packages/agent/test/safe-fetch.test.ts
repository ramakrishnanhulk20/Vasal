// Not covered here: https and real TLS hosts (the live feed demo exercises one),
// a connect timeout against a host that silently drops packets, DNS failure
// handling, and IPv6-only public hosts. Feed parsing (C1.6, C1.7) is in
// feeds-rss.test.ts. The test servers bind port 80 on loopback because the
// fetcher only speaks default ports; on Linux that needs root or a lowered
// net.ipv4.ip_unprivileged_port_start.
import dns from "node:dns";
import http from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import net from "node:net";
import zlib from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FeedError } from "../src/feeds/errors.js";
import { isPublicUnicast, type AddressCheck } from "../src/net/address-check.js";
import { safeFetch } from "../src/net/safe-fetch.js";

type CountingServer = { server: http.Server; connections: number };

const SMALL_FEED = "<rss><channel><title>Loopback</title></channel></rss>";
const BOMB_INFLATED_BYTES = 11 * 1024 * 1024;
const bomb = zlib.gzipSync(Buffer.alloc(BOMB_INFLATED_BYTES), { level: 9 });
const chunk = Buffer.alloc(64 * 1024, 120);

let lastHeaders: IncomingHttpHeaders = {};
let lastHeaderNames: string[] = [];

function route(req: http.IncomingMessage, res: http.ServerResponse): void {
  const path = req.url ?? "/";
  const redirectStep = /^\/r\/(\d)$/.exec(path);
  if (redirectStep) {
    const left = Number(redirectStep[1]);
    if (left === 0) {
      res.end("end of chain");
    } else {
      res.writeHead(302, { location: `/r/${left - 1}` }).end();
    }
    return;
  }
  switch (path) {
    case "/feed":
      res.writeHead(200, { "content-type": "application/rss+xml" }).end(SMALL_FEED);
      return;
    case "/gzip-feed": {
      const gz = zlib.gzipSync(SMALL_FEED);
      res.writeHead(200, { "content-type": "application/rss+xml", "content-encoding": "gzip" }).end(gz);
      return;
    }
    case "/headers":
      lastHeaders = req.headers;
      lastHeaderNames = req.rawHeaders.filter((_, i) => i % 2 === 0).map((name) => name.toLowerCase());
      res.end(SMALL_FEED);
      return;
    case "/to-loopback":
      res.writeHead(302, { location: "http://127.0.0.1/feed" }).end();
      return;
    case "/to-ftp":
      res.writeHead(302, { location: "ftp://127.0.0.1/feed" }).end();
      return;
    case "/to-odd-port":
      res.writeHead(301, { location: "http://127.0.0.1:8080/feed" }).end();
      return;
    case "/missing":
      res.writeHead(404).end("not here");
      return;
    case "/drip": {
      res.writeHead(200, { "content-type": "application/rss+xml" });
      const tick = setInterval(() => res.write("<"), 100);
      res.on("close", () => clearInterval(tick));
      return;
    }
    case "/hang":
      return;
    case "/endless": {
      res.writeHead(200, { "content-type": "application/rss+xml" });
      const pump = (): void => {
        let more = true;
        while (more && !res.destroyed) more = res.write(chunk);
        if (!res.destroyed) res.once("drain", pump);
      };
      pump();
      return;
    }
    case "/bomb":
      res
        .writeHead(200, {
          "content-type": "application/rss+xml",
          "content-encoding": "gzip",
          "content-length": String(bomb.length),
        })
        .end(bomb);
      return;
    default:
      res.writeHead(404).end();
  }
}

function startServer(host: string): Promise<CountingServer> {
  return new Promise((resolve, reject) => {
    const counting: CountingServer = { server: http.createServer(route), connections: 0 };
    counting.server.on("connection", () => {
      counting.connections++;
    });
    counting.server.once("error", reject);
    counting.server.listen({ port: 80, host, ipv6Only: host.includes(":") }, () => resolve(counting));
  });
}

function stopServer(counting: CountingServer): Promise<void> {
  return new Promise((resolve) => {
    counting.server.closeAllConnections();
    counting.server.close(() => resolve());
  });
}

async function failure(promise: Promise<unknown>): Promise<FeedError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof FeedError) return err;
    throw err;
  }
  throw new Error("expected the fetch to fail");
}

// Replaces DNS with fixed answers, one answer per lookup call, so a test can
// play a resolver that changes its mind between connections.
function stubDns(answers: string[][]): string[] {
  const asked: string[] = [];
  let call = 0;
  const fake = (hostname: string, _options: unknown, callback: (err: null, found: dns.LookupAddress[]) => void) => {
    asked.push(hostname);
    const answer = answers[Math.min(call, answers.length - 1)] ?? [];
    call++;
    process.nextTick(() => callback(null, answer.map((address) => ({ address, family: net.isIP(address) }))));
  };
  vi.spyOn(dns, "lookup").mockImplementation(fake as unknown as typeof dns.lookup);
  return asked;
}

// Treats one loopback address as if it were a public host, so a local server
// can play the "public" side of a scenario. Every other address still goes
// through the real predicate.
function standIn(publicStandIn: string): AddressCheck {
  return (address) => address === publicStandIn || isPublicUnicast(address);
}

// For the C1.4 bound tests only: lifts the address rule so a local server can
// serve hostile bodies. C1.1 is proven by its own tests above them.
const allowLoopback: AddressCheck = (address) => address === "127.0.0.1" || address === "::1";

let v4: CountingServer;
let v6: CountingServer;

beforeAll(async () => {
  v4 = await startServer("127.0.0.1");
  v6 = await startServer("::1");
});

afterAll(async () => {
  await stopServer(v4);
  await stopServer(v6);
});

afterEach(() => {
  vi.restoreAllMocks();
  v4.connections = 0;
  v6.connections = 0;
});

describe("C1.1 only public unicast addresses are ever dialled", () => {
  it("refuses private, loopback and metadata IP literals with no connection opened", async () => {
    const connectSpy = vi.spyOn(net, "connect");
    const literals = [
      "http://127.0.0.1/feed",
      "http://0x7f.1/feed",
      "http://2130706433/feed",
      "http://[::ffff:127.0.0.1]/feed",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.1/feed",
      "http://[fd00::1]/feed",
    ];
    for (const literal of literals) {
      const err = await failure(safeFetch(new URL(literal)));
      expect(err.code).toBe("FEED_BLOCKED_ADDRESS");
      expect(err.message).toBe(new FeedError("FEED_BLOCKED_ADDRESS").message);
      expect(err.message).not.toMatch(/\d/);
      expect(err.cause).toBeUndefined();
    }
    expect(connectSpy).not.toHaveBeenCalled();
    expect(v4.connections).toBe(0);
    expect(v6.connections).toBe(0);
  });

  it("refuses a hostname whose DNS answer is private, even though a server listens there", async () => {
    const asked = stubDns([["127.0.0.1"]]);
    const err = await failure(safeFetch(new URL("http://feeds.internal.test/feed")));
    expect(err.code).toBe("FEED_BLOCKED_ADDRESS");
    expect(asked).toEqual(["feeds.internal.test"]);
    expect(v4.connections).toBe(0);
  });

  it("refuses when any one address in a DNS answer is private", async () => {
    stubDns([["127.0.0.1", "10.0.0.1"]]);
    const err = await failure(
      safeFetch(new URL("http://mixed.test/feed"), { addressCheck: standIn("127.0.0.1") }),
    );
    expect(err.code).toBe("FEED_BLOCKED_ADDRESS");
    expect(v4.connections).toBe(0);
  });

  it("checks each connection's own lookup: public on the first, private on the second is refused", async () => {
    const connectSpy = vi.spyOn(net, "connect");
    const asked = stubDns([["127.0.0.1"], ["10.0.0.1"]]);
    const addressCheck = standIn("127.0.0.1");

    const first = await safeFetch(new URL("http://rebind.test/feed"), { addressCheck });
    expect(first.body).toBe(SMALL_FEED);
    expect(v4.connections).toBe(1);
    expect(connectSpy).toHaveBeenCalled();

    const err = await failure(safeFetch(new URL("http://rebind.test/feed"), { addressCheck }));
    expect(err.code).toBe("FEED_BLOCKED_ADDRESS");
    expect(asked).toEqual(["rebind.test", "rebind.test"]);
    expect(v4.connections).toBe(1);
  });

  it("refuses a public URL that redirects to 127.0.0.1", async () => {
    const err = await failure(
      safeFetch(new URL("http://[::1]/to-loopback"), { addressCheck: standIn("::1") }),
    );
    expect(err.code).toBe("FEED_BLOCKED_ADDRESS");
    expect(v6.connections).toBe(1);
    expect(v4.connections).toBe(0);
  });
});

describe("C1.3 scheme, port, user info and redirect limits", () => {
  it("refuses ftp, a non-default port and user info before connecting", async () => {
    for (const bad of ["ftp://127.0.0.1/feed", "http://127.0.0.1:8080/feed", "http://user:pass@127.0.0.1/feed"]) {
      const err = await failure(safeFetch(new URL(bad), { addressCheck: allowLoopback }));
      expect(err.code).toBe("FEED_BAD_SCHEME_OR_PORT");
    }
    expect(v4.connections).toBe(0);
  });

  it("applies the scheme and port rule again on every redirect hop", async () => {
    for (const path of ["/to-ftp", "/to-odd-port"]) {
      const err = await failure(safeFetch(new URL(`http://127.0.0.1${path}`), { addressCheck: allowLoopback }));
      expect(err.code).toBe("FEED_BAD_SCHEME_OR_PORT");
    }
  });

  it("follows a chain of 3 redirects and refuses a chain of 4", async () => {
    const three = await safeFetch(new URL("http://127.0.0.1/r/3"), { addressCheck: allowLoopback });
    expect(three.body).toBe("end of chain");
    expect(three.finalUrl.pathname).toBe("/r/0");

    const err = await failure(safeFetch(new URL("http://127.0.0.1/r/4"), { addressCheck: allowLoopback }));
    expect(err.code).toBe("FEED_TOO_MANY_REDIRECTS");
  });
});

describe("C1.2 the fetcher carries no authority", () => {
  it("sends the fixed User-Agent and Accept, and no cookie or credential header", async () => {
    await safeFetch(new URL("http://127.0.0.1/headers"), {
      addressCheck: allowLoopback,
      accept: "application/rss+xml",
    });
    expect(lastHeaders["user-agent"]).toBe("VasalFeedReader/0.1");
    expect(lastHeaders.accept).toBe("application/rss+xml");
    expect(lastHeaders.cookie).toBeUndefined();
    expect(lastHeaders.authorization).toBeUndefined();
    expect(lastHeaders["proxy-authorization"]).toBeUndefined();
    const allowed = [
      "host",
      "connection",
      "accept",
      "user-agent",
      "accept-encoding",
      "accept-language",
      "sec-fetch-mode",
    ];
    expect(lastHeaderNames.filter((name) => !allowed.includes(name))).toEqual([]);
  });
});

describe("C1.4 every fetch is bounded", () => {
  it("gives up on a slow drip at the total timeout", async () => {
    const started = Date.now();
    const err = await failure(
      safeFetch(new URL("http://127.0.0.1/drip"), { addressCheck: allowLoopback, totalTimeoutMs: 800 }),
    );
    const elapsed = Date.now() - started;
    expect(err.code).toBe("FEED_TIMEOUT");
    expect(elapsed).toBeGreaterThanOrEqual(700);
    expect(elapsed).toBeLessThan(3_000);
  });

  it("gives up on a server that accepts the connection and never answers", async () => {
    const started = Date.now();
    const err = await failure(
      safeFetch(new URL("http://127.0.0.1/hang"), { addressCheck: allowLoopback, totalTimeoutMs: 800 }),
    );
    expect(err.code).toBe("FEED_TIMEOUT");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("stops an endless body at the byte cap, well before the timeout", async () => {
    const started = Date.now();
    const err = await failure(
      safeFetch(new URL("http://127.0.0.1/endless"), {
        addressCheck: allowLoopback,
        maxBytes: 1024 * 1024,
        totalTimeoutMs: 10_000,
      }),
    );
    expect(err.code).toBe("FEED_TOO_LARGE");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("stops a 10 KB gzip body that inflates past the default 10 MB cap", async () => {
    expect(bomb.length).toBeGreaterThan(8 * 1024);
    expect(bomb.length).toBeLessThan(16 * 1024);
    expect(BOMB_INFLATED_BYTES).toBeGreaterThan(10 * 1024 * 1024);
    const err = await failure(safeFetch(new URL("http://127.0.0.1/bomb"), { addressCheck: allowLoopback }));
    expect(err.code).toBe("FEED_TOO_LARGE");
  });

  it("returns the decoded body, status, content type and final URL of a normal gzip feed", async () => {
    const result = await safeFetch(new URL("http://127.0.0.1/gzip-feed"), { addressCheck: allowLoopback });
    expect(result.body).toBe(SMALL_FEED);
    expect(result.status).toBe(200);
    expect(result.contentType).toBe("application/rss+xml");
    expect(result.finalUrl.href).toBe("http://127.0.0.1/gzip-feed");
  });

  it("turns a non-2xx final status into FEED_HTTP_STATUS", async () => {
    const err = await failure(safeFetch(new URL("http://127.0.0.1/missing"), { addressCheck: allowLoopback }));
    expect(err.code).toBe("FEED_HTTP_STATUS");
  });
});
