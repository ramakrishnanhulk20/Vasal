import type Anthropic from "@anthropic-ai/sdk";
import type { MeteredQloo } from "../qloo/metered.js";
import { cleanText } from "../text/normalize.js";
import type { RunContext } from "./context.js";
import { AgentError } from "./errors.js";
import { estimateInputTokens, type ModelClient } from "./model.js";
import { RESEARCH_NUDGE, researchSystem } from "./prompts.js";
import { researchTools, runTool, TOOL_LIMITS, type ToolName, type ToolOutcome } from "./tools.js";

export type LoopLimits = { maxTurns: number; maxToolCalls: number; maxRunTokens: number; maxWallMs: number; turnMaxTokens: number };
export type StepEvent = { tool: string; ok: boolean; label: string };

/** The run caps from threat model C2.4, as numbers. */
export const DEFAULT_LIMITS: Readonly<LoopLimits> = Object.freeze({
  maxTurns: 12,
  maxToolCalls: 25,
  maxRunTokens: 250_000,
  maxWallMs: 120_000,
  turnMaxTokens: 8_000,
});

// A turn started just before the wall clock ends still gets a usable
// timeout; the wall-clock signal is what ends it on time.
const MIN_TURN_TIMEOUT_MS = 1_000;
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

// Singular and plural, so a tool added later fails to compile until its
// limit can be named.
const LIMIT_NOUNS: Record<ToolName, readonly [string, string]> = {
  people_for_show: ["people list", "people lists"],
  audience_of: ["audience check", "audience checks"],
  trend_of: ["trend check", "trend checks"],
  shared_taste: ["taste comparison", "taste comparisons"],
  upcoming_releases: ["release list", "release lists"],
  find_person: ["name lookup", "name lookups"],
  recent_episode_titles: ["episode title list", "episode title lists"],
  finish_board: ["board submission", "board submissions"],
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
  const name = [...cleanText(person.name, { maxChars: MAX_LABEL_NAME_CHARS }).trim()].slice(0, MAX_LABEL_NAME_CHARS).join("").trim();
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

// Read from runTool's own JSON like countIn, and anything but a whole number
// above 0 reads as 0, so the label never shows a figure code did not write.
function numberIn(content: string, key: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return 0;
  }
  const value = field(parsed, key);
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function pastGuestsSuffix(outcome: ToolOutcome): string {
  const skipped = numberIn(outcome.content, "skippedPastGuests");
  return skipped > 0 ? `, leaving out ${plural(skipped, "past guest", "past guests")}` : "";
}

function okLabel(tool: ToolName, ctx: RunContext, input: unknown, outcome: ToolOutcome): string {
  switch (tool) {
    case "people_for_show":
      return `Found ${plural(countIn(outcome.content, "people"), "person", "people")} this show's listeners love${pastGuestsSuffix(outcome)}`;
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
      return `Looked up a name and found ${plural(countIn(outcome.content, "people"), "match", "matches")}${pastGuestsSuffix(outcome)}`;
    case "recent_episode_titles":
      return `Read ${plural(countIn(outcome.content, "titles"), "recent episode title", "recent episode titles")}`;
    case "finish_board":
      return `Picked ${plural(outcome.finished?.length ?? 0, "guest", "guests")} for the board`;
  }
}

// The code runTool itself wrote. It only chooses between fixed labels and is
// never printed, and anything that does not read as a code gives null.
function errorCodeIn(content: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  const code = field(parsed, "error");
  return typeof code === "string" ? code : null;
}

function failedLabel(tool: ToolName, ctx: RunContext, input: unknown, outcome: ToolOutcome): string {
  const code = errorCodeIn(outcome.content);
  if (code === "LIMIT_REACHED") {
    const [one, many] = LIMIT_NOUNS[tool];
    return `Reached this run's limit of ${plural(TOOL_LIMITS[tool], one, many)}`;
  }
  if (tool === "audience_of" && code === "NO_DATA") return `Qloo has no audience data for ${personName(ctx, input)}`;
  return FAILED_LABELS[tool];
}

/**
 * The step event for one finished tool call. Every label is fixed words,
 * counts read from runTool's own output or TOOL_LIMITS, and at most a Qloo
 * entity name (direction controls stripped, at most 100 characters), so no
 * model text, tool input or tool name the model made up is ever streamed
 * (C3.1, C3.3). A failed call's label is chosen by the code runTool wrote:
 * LIMIT_REACHED names the tool's per-run limit and its size, audience_of's
 * NO_DATA says Qloo has no audience data for the person, and every other
 * failure, or content that holds no readable code, keeps its tool's label.
 */
export function stepFor(ctx: RunContext, name: string, input: unknown, outcome: ToolOutcome): StepEvent {
  const tool = isToolName(name) ? name : "unknown";
  if (tool === "unknown") return { tool, ok: false, label: FAILED_LABELS.unknown };
  if (outcome.isError) return { tool, ok: false, label: failedLabel(tool, ctx, input, outcome) };
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
 * The model sees only the fixed system prompt (researchSystem for
 * deps.trends and ctx.pastGuests.checked), `Show to research: ` plus the
 * JSON of ctx.show.name, and
 * tool results. It never sees the exclusion list
 * or anything the visitor typed (C2.7, C2.5). Each response is kept in full.
 * Every tool_use block in a response runs through runTool in order, and all
 * of their tool_result blocks, with is_error set from each outcome, go back
 * in one user message (C2.8). After each tool `onStep` gets a label written
 * by code (stepFor). A response with no tool call gets RESEARCH_NUDGE once.
 * deps.trends also goes to researchTools and runTool, so with it false
 * trend_of is neither named, offered nor run.
 *
 * Every cap is enforced here in code, never by asking the model (C2.1,
 * C2.4): before each model call the turn count, tool calls, the wall clock,
 * and whether the summed input and output tokens of every reply, plus the
 * turn's estimated input (estimateInputTokens, the model client's own
 * reservation estimate, or the last turn's counted tokens if more) and its
 * output limit (turnMaxTokens), still fit in maxRunTokens are
 * checked; before each tool the tool-call count; after each tool the tokens
 * and the wall clock. A reply whose usage cannot be read counts as the whole
 * token budget, so it fails closed. The wall clock runs maxWallMs from
 * deps.startedAtMs (on the nowMs clock, default now; a later value counts
 * as now), so a caller can count time it spent before research. Each model
 * call gets the wall-clock time left as its timeoutMs (at least 1 second)
 * and a signal that fires when the wall clock runs out, and every Qloo call
 * a tool makes gets the same signal, so a call still in flight then is cut
 * off and no Qloo call starts after it.
 *
 * Throws AgentError AGENT_LIMIT for any cap, including a Qloo call cut off
 * by the wall clock, MODEL_TIMEOUT for a model call cut off by its timeout
 * or the wall clock, AGENT_NO_BOARD for a second reply with no tool call,
 * MODEL_TRUNCATED for a reply cut off at its token limit, any other
 * AgentError the model client throws, RangeError for a limit that is not a
 * positive whole number or a startedAtMs that is not a finite number, and
 * whatever runTool or onStep rethrows (such as StoreError).
 */
export async function runResearch(
  ctx: RunContext,
  deps: {
    model: ModelClient;
    qloo: MeteredQloo;
    today: Date;
    trends: boolean;
    onStep: (s: StepEvent) => Promise<void>;
    nowMs?: () => number;
    startedAtMs?: number;
  },
  limits?: Partial<LoopLimits>,
): Promise<Array<{ personId: string; angle: string }>> {
  const caps = checkedLimits(limits ?? {});
  const clock = deps.nowMs ?? Date.now;
  const now = clock();
  // A start in the future would stretch the cap, so it counts as now.
  const startedAt = Math.min(deps.startedAtMs ?? now, now);
  if (!Number.isFinite(startedAt)) throw new RangeError("startedAtMs must be a finite number.");
  const deadline = startedAt + caps.maxWallMs;
  const toolOptions = { trends: deps.trends };
  const tools = researchTools(toolOptions);
  const system = researchSystem({ ...toolOptions, pastGuestsChecked: ctx.pastGuests.checked });
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: `Show to research: ${JSON.stringify(ctx.show.name)}` }];
  let turns = 0;
  let toolCalls = 0;
  let tokens = 0;
  let lastTurnTokens = 0;
  let nudged = false;

  const wallClock = new AbortController();
  // The signal counts too: a timer can fire a moment before the clock reads
  // the deadline, and a call it cut off must still end the run as a cap.
  const overTime = () => wallClock.signal.aborted || clock() >= deadline;
  const timeLeft = () => Math.max(MIN_TURN_TIMEOUT_MS, Math.ceil(deadline - clock()));
  const tokensOf = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : caps.maxRunTokens);
  const wallTimer = setTimeout(() => wallClock.abort(), Math.max(0, deadline - now));
  const qlooOptions = { ...toolOptions, signal: wallClock.signal };

  try {
    for (;;) {
      // A turn resends the whole conversation and may write up to
      // turnMaxTokens, so it starts only if both still fit under the cap. Its
      // input is taken as the model client's own reservation estimate, or the
      // last turn's counted tokens if more, since it resends all of that turn.
      const estimatedInput = Math.max(estimateInputTokens([system, messages, tools]), lastTurnTokens);
      const turnFits = tokens + estimatedInput + caps.turnMaxTokens <= caps.maxRunTokens;
      const which = turns >= caps.maxTurns ? "turn" : toolCalls >= caps.maxToolCalls ? "tool call" : !turnFits ? "token" : overTime() ? "time" : null;
      if (which !== null) {
        // AGENT_LIMIT names no cap, so the operator's log says which one ended
        // the run. Fixed words and counts only.
        console.warn(`research stopped at the ${which} limit after ${turns} turns, ${toolCalls} tool calls, ${tokens} tokens`);
        throw limitHit();
      }
      const response = await deps.model.turn(
        { system, messages, tools, maxTokens: caps.turnMaxTokens },
        { signal: wallClock.signal, timeoutMs: timeLeft() },
      );
      turns += 1;
      lastTurnTokens = tokensOf(response.usage?.input_tokens) + tokensOf(response.usage?.output_tokens);
      tokens += lastTurnTokens;
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
        const outcome = await runTool(ctx, deps.qloo, block.name, block.input, deps.today, qlooOptions);
        await deps.onStep(stepFor(ctx, block.name, block.input, outcome));
        if (tokens >= caps.maxRunTokens || overTime()) throw limitHit();
        if (outcome.finished !== undefined) return outcome.finished;
        results.push({ type: "tool_result", tool_use_id: block.id, content: outcome.content, is_error: outcome.isError });
      }
      messages.push({ role: "user", content: results });
    }
  } finally {
    clearTimeout(wallTimer);
  }
}
