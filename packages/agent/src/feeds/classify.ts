import { FeedError } from "./errors.js";

export type ClassifiedInput =
  | { kind: "apple"; appleId: string }
  | { kind: "feed"; url: URL }
  | { kind: "name"; text: string };

const MAX_INPUT_CHARS = 300;
const APPLE_ID_SEGMENT = /^id(\d{3,12})$/;

function parseHttpUrl(text: string): URL | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url : null;
}

/**
 * Decides what a visitor typed, using only the WHATWG URL parser (C8.2).
 *
 * An Apple Podcasts link is recognised only when the parsed hostname is
 * exactly `podcasts.apple.com` and a path segment is `id` plus 3 to 12 digits;
 * its id is returned so the caller looks the show up instead of fetching the
 * page. Any other http or https URL is a feed. Everything else, including
 * `javascript:` and other schemes, is a show name.
 *
 * Throws FeedError FEED_BAD_INPUT when the text is empty after NFC
 * normalisation and trimming, longer than 300 characters, or an Apple
 * Podcasts link with no id segment.
 */
export function classifyInput(raw: string): ClassifiedInput {
  const text = raw.normalize("NFC").trim();
  if (text.length === 0 || [...text].length > MAX_INPUT_CHARS) {
    throw new FeedError("FEED_BAD_INPUT");
  }

  const url = parseHttpUrl(text);
  if (url === null) return { kind: "name", text };

  if (url.hostname === "podcasts.apple.com") {
    for (const segment of url.pathname.split("/")) {
      const match = APPLE_ID_SEGMENT.exec(segment);
      if (match?.[1] !== undefined) return { kind: "apple", appleId: match[1] };
    }
    // An Apple page is never fetched as a feed (C8.2): without an id there is
    // nothing to look up, so the input is refused.
    throw new FeedError("FEED_BAD_INPUT");
  }
  return { kind: "feed", url };
}
