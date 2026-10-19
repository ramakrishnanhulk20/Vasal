import type Anthropic from "@anthropic-ai/sdk";
import type { MeteredQloo } from "../qloo/metered.js";
import { stripBidiControls } from "../text/normalize.js";
import type { RunContext } from "./context.js";
import { AgentError } from "./errors.js";
import type { ModelClient } from "./model.js";
import { RESEARCH_NUDGE, RESEARCH_SYSTEM } from "./prompts.js";
import { researchTools, runTool, TOOL_LIMITS, type ToolName, type ToolOutcome } from "./tools.js";

export type LoopLimits = { maxTurns: number; maxToolCalls: number; maxRunTokens: number; maxWallMs: number; turnMaxTokens: number };
export type StepEvent = { tool: string; ok: boolean; label: string };

/** The run caps from threat model C2.4, as numbers. */
export const DEFAULT_LIMITS: Readonly<LoopLimits> = Object.freeze({
  maxTurns: 12,
  maxToolCalls: 25,
  maxRunTokens: 150_000,
  maxWallMs: 120_000,
  turnMaxTokens: 8_000,
});

const MAX_LABEL_NAME_CHARS = 100;
const RELEASE_WORDS: Readonly<Record<string, string>> = { movie: "movies", tv_show: "TV shows", book: "books" };

const FAILED_LABELS: Record<ToolName | "unknown", string> = {
  unknown: "Refused a tool that is not on the list",
  people_for_show: "Could not list people for this show",
  audience_of: "Could not check an audience",
  trend_of: "Could not check a trend",
  shared_taste: "Could not compare tastes",
  upcoming_releases: "Could not list upcoming releases",
  find_person: "Could not look up a name",
  recent_episode_titles: "Could not read the episode titles",
  finish_board: "Sent some picks back to be fixed",
};

const limitHit = (): AgentError => new AgentError("AGENT_LIMIT");
const isToolName = (name: string): name is ToolName => Object.hasOwn(TOOL_LIMITS, name);
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function field(input: unknown, key: string): unknown {
  return typeof input === "object" && input !== null && Object.hasOwn(input, key) ? (input as Record<string, unknown>)[key] : undefined;
}

// The model's input is used only as a key into what Qloo returned this run,
// so the name shown is Qloo's, already cleaned, and never the model's text.
function personName(ctx: RunContext, input: unknown): string {
  const id = field(input, "personId");
  const person = typeof id === "string" ? ctx.people.get(id) : undefined;
  if (person === undefined) return "this person";
  const name = [...stripBidiControls(person.name).trim()].slice(0, MAX_LABEL_NAME_CHARS).join("").trim();
  return name === "" ? "this person" : name;
}

// Counts come from the JSON runTool itself wrote, never from the model.
function countIn(content: string, key: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return 0;
  }
  const items = field(parsed, key);
  const omitted = field(parsed, "omitted");
  const shown = Array.isArray(items) ? items.length : 0;
  return shown + (typeof omitted === "number" && Number.isSafeInteger(omitted) && omitted > 0 ? omitted : 0);
}

function okLabel(tool: ToolName, ctx: RunContext, input: unknown, outcome: ToolOutcome): string {
  switch (tool) {
    case "people_for_show":
      return `Found ${plural(countIn(outcome.content, "people"), "person", "people")} this show's listeners love`;
    case "audience_of":
      return `Checked who ${personName(ctx, input)}'s fans are`;
    case "trend_of":
      return `Checked whether interest in ${personName(ctx, input)} is rising`;
    case "shared_taste":
      return `Found ${plural(countIn(outcome.content, "sharedTastes"), "taste", "tastes")} ${personName(ctx, input)}'s fans share with this show's listeners`;
    case "upcoming_releases": {
      const kind = field(input, "kind");
      const words = typeof kind === "string" && Object.hasOwn(RELEASE_WORDS, kind) ? RELEASE_WORDS[kind] : "releases";
      return `Found ${countIn(outcome.content, "titles")} upcoming ${words}`;
    }
    case "find_person":
      return `Looked up a name and found ${plural(countIn(outcome.content, "people"), "match", "matches")}`;
    case "recent_episode_titles":
      return `Read ${plural(countIn(outcome.content, "titles"), "recent episode title", "recent episode titles")}`;
    case "finish_board":
      return `Picked ${plural(outcome.finished?.length ?? 0, "guest", "guests")} for the board`;
  }
}

/**
 * The step event for one finished tool call. Every label is fixed words,
 * counts read from runTool's own output, and at most a Qloo entity name
 * (direction controls stripped, at most 100 characters), so no model text,
 * tool input or tool name the model made up is ever streamed (C3.1, C3.3).
 */
export function stepFor(ctx: RunContext, name: string, input: unknown, outcome: ToolOutcome): StepEvent {
  const tool = isToolName(name) ? name : "unknown";
  if (tool === "unknown" || outcome.isError) return { tool, ok: false, label: FAILED_LABELS[tool] };
  return { tool, ok: true, label: okLabel(tool, ctx, input, outcome) };
}

function checkedLimits(overrides: Partial<LoopLimits>): LoopLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("Every loop limit must be a positive whole number.");
  }
  return limits;
}

/**
 * Runs the research conversation for one confirmed show and returns the
 * model's checked picks from finish_board.
 *
 * The model sees only the fixed system prompt, `Show to research: ` plus the
 * JSON of ctx.show.name, and tool results. It never sees the exclusion list
 * or anything the visitor typed (C2.7, C2.5). Each response is kept in full.
 * Every tool_use block in a response runs through runTool in order, and all
 * of their tool_result blocks, with is_error set from each outcome, go back
 * in one user message (C2.8). After each tool `onStep` gets a label written
 * by code (stepFor). A response with no tool call gets RESEARCH_NUDGE once.
 *
 * Every cap is enforced here in code, never by asking the model (C2.1,
 * C2.4): before each model call the turn count, tool calls, the summed
 * input and output tokens of every reply and the wall clock are checked;
 * before each tool the tool-call count; after each tool the tokens and the
 * wall clock. A reply whose usage cannot be read counts as the whole token
 * budget, so it fails closed.
 *
 * Throws AgentError AGENT_LIMIT for any cap, AGENT_NO_BOARD for a second
 * reply with no tool call, MODEL_TRUNCATED for a reply cut off at its token
 * limit, any AgentError the model client throws, RangeError for a limit that
 * is not a positive whole number, and whatever runTool or onStep rethrows
 * (such as StoreError).
 */
export async function runResearch(
  ctx: RunContext,
  deps: { model: ModelClient; qloo: MeteredQloo; today: Date; onStep: (s: StepEvent) => Promise<void>; nowMs?: () => number },
  limits?: Partial<LoopLimits>,
): Promise<Array<{ personId: string; angle: string }>> {
  const caps = checkedLimits(limits ?? {});
  const clock = deps.nowMs ?? Date.now;
  const startedAt = clock();
  const tools = researchTools();
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: `Show to research: ${JSON.stringify(ctx.show.name)}` }];
  let turns = 0;
  let toolCalls = 0;
  let tokens = 0;
  let nudged = false;

  const overTime = () => clock() - startedAt >= caps.maxWallMs;
  const tokensOf = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : caps.maxRunTokens);

  for (;;) {
    if (turns >= caps.maxTurns || toolCalls >= caps.maxToolCalls || tokens >= caps.maxRunTokens || overTime()) throw limitHit();
    const response = await deps.model.turn({ system: RESEARCH_SYSTEM, messages, tools, maxTokens: caps.turnMaxTokens });
    turns += 1;
    tokens += tokensOf(response.usage?.input_tokens) + tokensOf(response.usage?.output_tokens);
    messages.push({ role: "assistant", content: response.content });

    // A tool input cut off at the token limit can still parse, so none of
    // that reply's tools are run.
    if (response.stop_reason === "max_tokens") throw new AgentError("MODEL_TRUNCATED");
    if (response.stop_reason === "model_context_window_exceeded") throw limitHit();

    const toolUses = response.content.filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
    if (toolUses.length === 0) {
      if (nudged) throw new AgentError("AGENT_NO_BOARD");
      nudged = true;
      messages.push({ role: "user", content: RESEARCH_NUDGE });
      continue;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUses) {
      if (toolCalls >= caps.maxToolCalls) throw limitHit();
      toolCalls += 1;
      const outcome = await runTool(ctx, deps.qloo, block.name, block.input, deps.today);
      await deps.onStep(stepFor(ctx, block.name, block.input, outcome));
      if (tokens >= caps.maxRunTokens || overTime()) throw limitHit();
      if (outcome.finished !== undefined) return outcome.finished;
      results.push({ type: "tool_result", tool_use_id: block.id, content: outcome.content, is_error: outcome.isError });
    }
    messages.push({ role: "user", content: results });
  }
}
