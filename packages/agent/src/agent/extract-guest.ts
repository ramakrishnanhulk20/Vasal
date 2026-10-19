import { z } from "zod";
import type { ModelClient } from "./model.js";
import { EXTRACT_SYSTEM } from "./prompts.js";

export type ExtractedGuest = { kind: "one"; name: string } | { kind: "none" } | { kind: "several" };

const MAX_NAME_CHARS = 100;
const MAX_TOKENS = 200;

const ExtractSchema = z
  .object({ kind: z.enum(["one", "none", "several"]), name: z.string().max(MAX_NAME_CHARS).nullable() })
  .strict()
  .refine((answer) => answer.kind !== "one" || (answer.name !== null && answer.name.trim() !== ""));

/**
 * Builds the backtest's guest extractor. Each call sends one episode title,
 * as the user text with EXTRACT_SYSTEM and at most 200 output tokens, and
 * reads back { kind, name }. "one" needs a name of 1 to 100 characters,
 * returned trimmed; "none" and "several" pass through and any name sent with
 * them is ignored. The caller still checks that the name is in the title
 * (C9.1), because the model's word is never enough.
 *
 * Each call throws whatever model.structured throws: AgentError
 * AGENT_BAD_PROSE for a reply that fails the schema, such as "one" with an
 * empty name, and the client's other AgentError codes.
 */
export function createGuestExtractor(model: ModelClient): (title: string) => Promise<ExtractedGuest> {
  return async (title) => {
    const answer = await model.structured({ system: EXTRACT_SYSTEM, user: title, schema: ExtractSchema, maxTokens: MAX_TOKENS });
    if (answer.kind === "one") return { kind: "one", name: (answer.name ?? "").trim() };
    return { kind: answer.kind };
  };
}
