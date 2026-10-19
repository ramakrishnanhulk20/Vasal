import ipaddr from "ipaddr.js";

// Matches the cap in visitorKey, which is the next consumer of the address.
const MAX_ADDRESS_LENGTH = 100;

function originOf(value: string): string | null {
  const url = URL.parse(value);
  // A URL with no tuple origin (file:, data:, an opaque scheme) reports the
  // origin "null", which must never match anything.
  if (url === null || url.origin === "null") return null;
  return url.origin;
}

/**
 * The cross-site check on every POST that can spend (C5.5). True only when
 * the Content-Type media type (the part before any ";", trimmed and lower
 * cased) is exactly application/json, AND the Origin header and `appOrigin`
 * both parse with the WHATWG URL parser and their `.origin` values are equal.
 * Both sides go through the same parser, so a trailing slash or letter case
 * in either cannot cause a mismatch or a bypass. A missing, empty,
 * unparseable or "null" Origin is refused. This stops other websites from
 * making their visitors' browsers start runs. It does not stop a script that
 * forges the header, which the per-visitor caps and the human check handle.
 * Never throws.
 */
export function isAllowedPost(
  headers: { origin?: string | null; contentType?: string | null },
  appOrigin: string,
): boolean {
  const { origin, contentType } = headers;
  if (typeof contentType !== "string") return false;
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") return false;

  if (typeof origin !== "string" || typeof appOrigin !== "string") return false;
  const requestOrigin = originOf(origin);
  const allowedOrigin = originOf(appOrigin);
  return requestOrigin !== null && allowedOrigin !== null && requestOrigin === allowedOrigin;
}

function singleAddress(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value === "" || value.length > MAX_ADDRESS_LENGTH) return null;
  // A comma means a forwarded chain, and the client may have written any part
  // of it. Whitespace has no place in one address. Both are refused outright.
  if (/[,\s]/.test(value)) return null;
  try {
    ipaddr.process(value);
  } catch {
    return null;
  }
  return value;
}

/**
 * Picks the one client address that per-visitor caps count on (C5.3). With
 * `clientIpHeader` set, only `headerValue` is used: it must be a single
 * address that ipaddr.process parses, with no commas and no whitespace, or
 * the result is null. The socket address is never used as a fallback then,
 * because behind an edge it is the edge's own address. With no header
 * configured (development only, config refuses this in production), the
 * socket address is used under the same rule. Returns the value as received;
 * visitorKey applies the one normaliser. Callers treat null as a refusal.
 * Never throws.
 */
export function clientAddressFrom(
  headerValue: string | null | undefined,
  socketAddress: string | null | undefined,
  clientIpHeader: string | null,
): string | null {
  return clientIpHeader !== null ? singleAddress(headerValue) : singleAddress(socketAddress);
}
