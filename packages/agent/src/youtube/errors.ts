export type YouTubeErrorCode =
  | "YT_KEY_MISSING"
  | "YT_BAD_INPUT"
  | "YT_QUOTA"
  | "YT_BUDGET_REFUSED"
  | "YT_AUTH"
  | "YT_NOT_FOUND"
  | "YT_UPSTREAM"
  | "YT_TIMEOUT"
  | "YT_SCHEMA";

// Fixed text per code. No URL, header, key, id or response text is ever put
// into a message, so logging or showing an error cannot leak them (C3.6, C4.1).
const MESSAGES: Record<YouTubeErrorCode, string> = {
  YT_KEY_MISSING: "YouTube API key is not configured.",
  YT_BAD_INPUT: "YouTube request input was rejected.",
  YT_QUOTA: "YouTube daily quota is used up.",
  YT_BUDGET_REFUSED: "The YouTube unit budget refused this request.",
  YT_AUTH: "YouTube rejected the API key or its permissions.",
  YT_NOT_FOUND: "YouTube has no such channel, playlist or video.",
  YT_UPSTREAM: "YouTube request failed.",
  YT_TIMEOUT: "YouTube request timed out.",
  YT_SCHEMA: "YouTube response did not match the expected shape.",
};

/**
 * The only error type the YouTube layer throws. It deliberately carries no
 * `cause`, because an upstream cause can hold the URL, the key header or a body.
 */
export class YouTubeError extends Error {
  override readonly name = "YouTubeError";
  readonly code: YouTubeErrorCode;

  constructor(code: YouTubeErrorCode) {
    super(MESSAGES[code]);
    this.code = code;
  }
}
