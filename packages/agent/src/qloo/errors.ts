export type QlooErrorCode =
  | "QLOO_KEY_MISSING"
  | "QLOO_AUTH"
  | "QLOO_FORBIDDEN_TYPE"
  | "QLOO_NOT_FOUND"
  | "QLOO_RATE_LIMIT"
  | "QLOO_UPSTREAM"
  | "QLOO_TIMEOUT"
  | "QLOO_SCHEMA"
  | "QLOO_BAD_INPUT"
  | "QLOO_BUDGET";

// Fixed text per code. Nothing from a request, a response or the key is ever
// interpolated, so logging or showing an error cannot leak them (C3.6, C4.1).
const MESSAGES: Record<QlooErrorCode, string> = {
  QLOO_KEY_MISSING: "Qloo API key is not configured.",
  QLOO_AUTH: "Qloo rejected the API key.",
  QLOO_FORBIDDEN_TYPE: "Qloo refused this request type for this key.",
  QLOO_NOT_FOUND: "Qloo has no resource at this path.",
  QLOO_RATE_LIMIT: "Qloo rate limit still hit after retries.",
  QLOO_UPSTREAM: "Qloo request failed.",
  QLOO_TIMEOUT: "Qloo request timed out.",
  QLOO_SCHEMA: "Qloo response did not match the expected shape.",
  QLOO_BAD_INPUT: "Qloo operation input was rejected.",
  QLOO_BUDGET: "The Qloo call budget is used up for now.",
};

/**
 * The only error type the Qloo layer throws. It deliberately carries no
 * `cause`, because an upstream cause can hold a URL, headers or a body.
 */
export class QlooError extends Error {
  override readonly name = "QlooError";
  readonly code: QlooErrorCode;
  readonly status?: number;

  constructor(code: QlooErrorCode, status?: number) {
    super(MESSAGES[code]);
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}
