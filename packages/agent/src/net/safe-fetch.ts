import dns from "node:dns";
import net from "node:net";
import { Agent, fetch } from "undici";
import { FeedError } from "../feeds/errors.js";
import { isPublicUnicast, type AddressCheck } from "./address-check.js";

export type SafeFetchOptions = {
  addressCheck?: AddressCheck;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  accept?: string;
};

export type SafeFetchResult = {
  finalUrl: URL;
  status: number;
  contentType: string | null;
  body: string;
};

const USER_AGENT = "VasalFeedReader/0.1";
const DEFAULT_ACCEPT =
  "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function assertFetchableUrl(url: URL): void {
  const schemeOk = url.protocol === "http:" || url.protocol === "https:";
  if (!schemeOk || url.port !== "" || url.username !== "" || url.password !== "") {
    throw new FeedError("FEED_BAD_SCHEME_OR_PORT");
  }
}

function literalAddress(url: URL): string | null {
  const host = url.hostname;
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return net.isIP(bare) === 0 ? null : bare;
}

// Runs inside the socket's own connect, so the addresses checked here are the
// exact addresses the socket dials. A second, later DNS answer never gets to
// skip the check, because there is no separate "check" lookup to race against.
function checkedLookup(addressCheck: AddressCheck): net.LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) {
        callback(err, "");
        return;
      }
      const first = addresses[0];
      if (first === undefined || !addresses.every((entry) => addressCheck(entry.address))) {
        callback(new FeedError("FEED_BLOCKED_ADDRESS"), "");
        return;
      }
      if (options.all) {
        callback(null, addresses);
      } else {
        callback(null, first.address, first.family);
      }
    });
  };
}

function nextHop(location: string, current: URL): URL {
  try {
    return new URL(location, current);
  } catch {
    throw new FeedError("FEED_BAD_SCHEME_OR_PORT");
  }
}

async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  controller: AbortController,
): Promise<string> {
  if (body === null) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const parts: string[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // undici has already undone any Content-Encoding by this point, so this
    // counts decoded bytes and a gzip bomb trips the cap as it inflates.
    received += value.byteLength;
    if (received > maxBytes) {
      const tooLarge = new FeedError("FEED_TOO_LARGE");
      controller.abort(tooLarge);
      throw tooLarge;
    }
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join("");
}

function toFeedError(err: unknown, signal: AbortSignal): FeedError {
  let current: unknown = err;
  for (let depth = 0; depth < 6 && current instanceof Error; depth++) {
    if (current instanceof FeedError) return current;
    if ((current as { code?: unknown }).code === "UND_ERR_CONNECT_TIMEOUT") {
      return new FeedError("FEED_TIMEOUT");
    }
    current = current.cause;
  }
  if (signal.aborted && signal.reason instanceof FeedError) return signal.reason;
  return new FeedError("FEED_NETWORK");
}

/**
 * Downloads one URL from the server's network position without letting the
 * URL, its DNS answers or its redirects reach anything but public internet
 * hosts.
 *
 * Preconditions: `url` is already parsed by the WHATWG parser. Only http and
 * https on their default ports, with no user info, are fetched, on every hop.
 * Sends only Accept and a fixed User-Agent; no cookies or credentials.
 *
 * Throws FeedError with FEED_BAD_SCHEME_OR_PORT, FEED_BLOCKED_ADDRESS,
 * FEED_TOO_MANY_REDIRECTS, FEED_TIMEOUT (connect or total), FEED_TOO_LARGE
 * (decoded bytes), FEED_HTTP_STATUS (non-2xx final status) or FEED_NETWORK
 * (DNS failure, refused connection, TLS error). The error never contains the
 * URL, an address or body text.
 */
export async function safeFetch(url: URL, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const addressCheck = opts.addressCheck ?? isPublicUnicast;
  const connectTimeoutMs = opts.connectTimeoutMs ?? 5_000;
  const totalTimeoutMs = opts.totalTimeoutMs ?? 15_000;
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  const maxRedirects = opts.maxRedirects ?? 3;
  const accept = opts.accept ?? DEFAULT_ACCEPT;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new FeedError("FEED_TIMEOUT")), totalTimeoutMs);
  // A fresh agent per call means no pooled socket from an earlier call can be
  // reused, so every call's connections pass through the lookup check.
  const agent = new Agent({
    connect: { lookup: checkedLookup(addressCheck), timeout: connectTimeoutMs },
    headersTimeout: totalTimeoutMs,
    bodyTimeout: totalTimeoutMs,
  });

  try {
    let current = new URL(url.href);
    for (let redirects = 0; ; redirects++) {
      assertFetchableUrl(current);
      // Node never calls a lookup hook for an IP literal, it dials it directly.
      // So literals are checked here, and hostnames inside checkedLookup.
      const literal = literalAddress(current);
      if (literal !== null && !addressCheck(literal)) {
        throw new FeedError("FEED_BLOCKED_ADDRESS");
      }

      // undici also adds accept-encoding (so it can decode gzip),
      // accept-language "*" and sec-fetch-mode. None of them carries authority.
      const response = await fetch(current, {
        dispatcher: agent,
        redirect: "manual",
        credentials: "omit",
        signal: controller.signal,
        headers: { accept, "user-agent": USER_AGENT },
      });

      if (REDIRECT_STATUSES.has(response.status) && response.headers.has("location")) {
        await response.body?.cancel();
        if (redirects >= maxRedirects) throw new FeedError("FEED_TOO_MANY_REDIRECTS");
        current = nextHop(response.headers.get("location") ?? "", current);
        continue;
      }

      if (response.status < 200 || response.status > 299) {
        await response.body?.cancel();
        throw new FeedError("FEED_HTTP_STATUS");
      }

      const body = await readCapped(response.body, maxBytes, controller);
      return {
        finalUrl: current,
        status: response.status,
        contentType: response.headers.get("content-type"),
        body,
      };
    }
  } catch (err) {
    throw toFeedError(err, controller.signal);
  } finally {
    clearTimeout(timer);
    await agent.destroy().catch(() => undefined);
  }
}
