import { z } from "zod";
import type { ModelClient } from "./model.js";
import { EXTRACT_SYSTEM } from "./prompts.js";

export type ExtractedGuest = { kind: "one"; name: string } | { kind: "none" } | { kind: "several" };

const MAX_NAME_CHARS = 100;
// Haiku 5.5 thinks by default, and thinking counts against this allowance. In
// the pre-flight a 200 allowance was used up before the answer on titles that
// name no one.
const MAX_TOKENS = 1_024;

const ExtractSchema = z
  .object({ kind: z.enum(["one", "none", "several"]), name: z.string().max(MAX_NAME_CHARS).nullable() })
  .strict();

/**
 * Builds the backtest's guest extractor. Each call sends one episode title,
 * as the user text with EXTRACT_SYSTEM and at most 1,024 output tokens, and
 * reads back { kind, name }. "one" with a name returns that name trimmed;
 * "one" with a null or blank name returns { kind: "none" }. "none" and
 * "several" pass through and any name sent with them is ignored. The caller
 * still checks that the name is in the title (C9.1), because the model's
 * word is never enough.
 *
 * Each call throws whatever model.structured throws: AgentError
 * AGENT_BAD_PROSE for a reply that fails the schema, such as an unknown kind
 * or a name over 100 characters, and the client's other AgentError codes.
 */
export function createGuestExtractor(model: ModelClient): (title: string) => Promise<ExtractedGuest> {
  return async (title) => {
    const answer = await model.structured({ system: EXTRACT_SYSTEM, user: title, schema: ExtractSchema, maxTokens: MAX_TOKENS });
    if (answer.kind !== "one") return { kind: answer.kind };
    const name = (answer.name ?? "").trim();
    // No name means nothing to keep, and the name-in-title rule would drop it anyway.
    return name === "" ? { kind: "none" } : { kind: "one", name };
  };
}
