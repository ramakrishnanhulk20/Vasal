export type FeedErrorCode =
  | "FEED_BAD_INPUT"
  | "FEED_BLOCKED_ADDRESS"
  | "FEED_BAD_SCHEME_OR_PORT"
  | "FEED_TOO_MANY_REDIRECTS"
  | "FEED_TIMEOUT"
  | "FEED_TOO_LARGE"
  | "FEED_HTTP_STATUS"
  | "FEED_NETWORK"
  | "FEED_NOT_A_FEED"
  | "FEED_DOCTYPE_REJECTED"
  | "FEED_TOO_DEEP"
  | "FEED_UNKNOWN_HANDLE"
  | "LOOKUP_FAILED";

// Messages are fixed text on purpose: an error built from a URL, a header, an
// address or body bytes would hand an attacker a readable channel (C1.6, C3.6).
const MESSAGES: Record<FeedErrorCode, string> = {
  FEED_BAD_INPUT: "The show name or link could not be used.",
  FEED_BLOCKED_ADDRESS: "The feed address is not on the public internet.",
  FEED_BAD_SCHEME_OR_PORT: "Only http and https links on their standard ports are accepted.",
  FEED_TOO_MANY_REDIRECTS: "The feed link redirected too many times.",
  FEED_TIMEOUT: "The feed took too long to download.",
  FEED_TOO_LARGE: "The feed is larger than the size limit.",
  FEED_HTTP_STATUS: "The feed server did not return a usable response.",
  FEED_NETWORK: "The feed server could not be reached.",
  FEED_NOT_A_FEED: "The link did not return an RSS or Atom feed.",
  FEED_DOCTYPE_REJECTED: "Feeds with a document type declaration are not accepted.",
  FEED_TOO_DEEP: "The feed is nested too deeply or has too many elements.",
  FEED_UNKNOWN_HANDLE: "That feed reference was not issued for this run.",
  LOOKUP_FAILED: "The podcast directory lookup failed.",
};

/**
 * The only error type the feed code throws. It never carries a cause, so no
 * upstream error text can ride along with it.
 */
export class FeedError extends Error {
  override name = "FeedError";
  readonly code: FeedErrorCode;

  constructor(code: FeedErrorCode) {
    super(MESSAGES[code]);
    this.code = code;
  }
}
