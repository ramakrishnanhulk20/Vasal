const BUDGET =
  "Today's budget for live runs is used up. Open one of the boards on the home page, or come back tomorrow.";

const REASONS: Record<string, string> = {
  AGENT_LIMIT: "The agent hit its time or step limit before it finished.",
  SHOW_NOT_FOUND: "Vasal couldn't find that show.",
  SHOW_NO_QLOO_MATCH: "Qloo doesn't know this show yet, so there's no taste data to work from.",
  FEED_UNAVAILABLE: "The show's feed couldn't be read.",
  AGENT_BOARD_TOO_SMALL: "Qloo found too few guests to make a board.",
  MODEL_BUDGET: BUDGET,
  QLOO_BUDGET: BUDGET,
  CONFIRM_EXPIRED: "This run waited too long to be confirmed. Start again from the home page.",
  SERVER_RESTART: "The server restarted during this run. Start it again.",
  AGENT_NOT_READY:
    "The agent isn't switched on for this server. Running it yourself? Add the Qloo and Anthropic keys to .env and restart the agent server.",
};

const DEFAULT_REASON = "This run stopped before it finished.";

// The plain-English reason for the code a run stopped with. Both the live page
// and a stopped run opened from its link read from here.
export function failureReason(code: string | null | undefined): string {
  return (code ? REASONS[code] : undefined) ?? DEFAULT_REASON;
}
