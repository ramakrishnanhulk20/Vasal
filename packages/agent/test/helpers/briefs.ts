// A brief in the shape the agent runner stores (writeBrief in agent/brief.ts
// plus its removed counts), and a model draft that passes the runner's prose
// checks. Every word is made up, so no test holds model or Qloo text (C7.3).
import { putBrief } from "../../src/server/runs.js";
import type { Db } from "../../src/store/db.js";

export const syntheticBrief = (n: number) => ({
  why: `Synthetic Guest ${n} suits the show's listeners.`,
  angle: "A synthetic angle.",
  questions: ["One?", "Two?", "Three?", "Four?", "Five?"],
  pitch_subject: "A synthetic pitch",
  pitch_body: "Hi team,\nA synthetic pitch body.",
  removed: { links: 0, emails: 0 },
});

// Uses only the placeholders every board guest has, so it passes for a guest
// with no shared tags too.
export const BRIEF_DRAFT = {
  why: "{{guest}} has {{fit}} with {{show}} listeners.",
  angle: "A talk about what {{show}} listeners enjoy.",
  questions: ["One?", "Two?", "Three?", "Four?", "Five?"],
  pitch_subject: "{{show}} would love to have {{guest}}",
  pitch_body: "Hi team, could {{guest}} join {{show}} this month?",
};

/** Stores syntheticBrief(1), (2) and so on for the given guests, in order. */
export async function storeBriefs(db: Db, runId: string, guestIds: readonly string[]): Promise<void> {
  for (const [index, guestId] of guestIds.entries()) await putBrief(db, runId, guestId, syntheticBrief(index + 1));
}
