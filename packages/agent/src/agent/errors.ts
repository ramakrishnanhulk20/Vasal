export type AgentErrorCode =
  | "MODEL_KEY_MISSING"
  | "MODEL_BUDGET"
  | "MODEL_RATE_LIMIT"
  | "MODEL_OVERLOADED"
  | "MODEL_AUTH"
  | "MODEL_BAD_REQUEST"
  | "MODEL_REFUSED"
  | "MODEL_TRUNCATED"
  | "MODEL_UPSTREAM"
  | "MODEL_TIMEOUT"
  | "AGENT_LIMIT"
  | "AGENT_NO_BOARD"
  | "AGENT_BOARD_TOO_SMALL"
  | "AGENT_BAD_PROSE"
  | "SHOW_NOT_FOUND"
  | "SHOW_NO_QLOO_MATCH"
  | "FEED_UNAVAILABLE";

// Fixed text per code. Nothing from a request, a response, the model or a key
// is ever put into one, so an error can be logged or shown safely (C3.6, C4.1).
const MESSAGES: Record<AgentErrorCode, string> = {
  MODEL_KEY_MISSING: "The Anthropic API key is not configured.",
  MODEL_BUDGET: "The daily model token budget is used up for now.",
  MODEL_RATE_LIMIT: "The model service rate limit was still hit after retries.",
  MODEL_OVERLOADED: "The model service is overloaded right now.",
  MODEL_AUTH: "The model service rejected the API key.",
  MODEL_BAD_REQUEST: "The model service refused the request.",
  MODEL_REFUSED: "The model declined to answer.",
  MODEL_TRUNCATED: "The model reply was cut off at its length limit.",
  MODEL_UPSTREAM: "The model request failed.",
  MODEL_TIMEOUT: "The model request timed out.",
  AGENT_LIMIT: "The run reached one of its limits.",
  AGENT_NO_BOARD: "The research step ended without a guest board.",
  AGENT_BOARD_TOO_SMALL: "Fewer than three guests were left on the board.",
  AGENT_BAD_PROSE: "The model's writing failed the app's checks twice.",
  SHOW_NOT_FOUND: "No podcast was found for that show.",
  SHOW_NO_QLOO_MATCH: "Qloo has no single match for that show.",
  FEED_UNAVAILABLE: "The show's feed could not be read.",
};

/**
 * The only error type the agent modules throw on purpose. Its message comes
 * from a fixed table by code, and it never carries a `cause`, because an
 * SDK or upstream cause can hold a request body, headers or a key.
 */
export class AgentError extends Error {
  override readonly name = "AgentError";
  readonly code: AgentErrorCode;

  constructor(code: AgentErrorCode) {
    super(MESSAGES[code]);
    this.code = code;
  }
}
