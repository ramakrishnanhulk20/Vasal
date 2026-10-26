import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { AgentError, type AgentErrorCode } from "./errors.js";

/** How long one model call may take, and a signal that ends it early. */
export type ModelCallOptions = { signal?: AbortSignal; timeoutMs?: number };

export type ModelClient = {
  turn(
    p: {
      system: string;
      messages: Anthropic.MessageParam[];
      tools: Anthropic.Tool[];
      maxTokens: number;
    },
    options?: ModelCallOptions,
  ): Promise<Anthropic.Message>;
  structured<T>(p: { system: string; user: string; schema: z.ZodType<T>; maxTokens: number }, options?: ModelCallOptions): Promise<T>;
};

// Pinned, so an ANTHROPIC_BASE_URL left in the environment can never send the
// key anywhere else.
const API_BASE_URL = "https://api.anthropic.com";
const DEFAULT_CALL_TIMEOUT_MS = 45_000;
// Node keeps a timer delay in a signed 32-bit number and fires a longer one at
// once, so no deadline past this can be honoured.
const MAX_CALL_TIMEOUT_MS = 2_147_483_647;
// The SDK retries 429 and 5xx once, honouring Retry-After, then the call
// fails (C5.2). The retry runs inside the same call deadline, so it can never
// stretch the wait past it.
const MAX_RETRIES = 1;
const MAX_TOKENS_LIMIT = 16_000;
const OVERLOADED_STATUS = 529;
// About three characters of JSON per token. Reserving on the high side of the
// real count fails closed: the day's budget runs out early, never over (C5.1).
const CHARS_PER_TOKEN = 3;

// instanceof only, most specific first, never the message text: SDK messages
// can quote the request or the response body.
function codeFor(error: unknown): AgentErrorCode {
  if (error instanceof APIUserAbortError) return "MODEL_TIMEOUT";
  if (error instanceof APIConnectionTimeoutError) return "MODEL_TIMEOUT";
  if (error instanceof APIConnectionError) return "MODEL_UPSTREAM";
  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) return "MODEL_AUTH";
  if (error instanceof RateLimitError) return "MODEL_RATE_LIMIT";
  if (error instanceof BadRequestError || error instanceof NotFoundError || error instanceof UnprocessableEntityError) {
    return "MODEL_BAD_REQUEST";
  }
  if (error instanceof APIError) {
    return error.status === OVERLOADED_STATUS || error.type === "overloaded_error" ? "MODEL_OVERLOADED" : "MODEL_UPSTREAM";
  }
  return "MODEL_UPSTREAM";
}

function checkMaxTokens(maxTokens: number): void {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_TOKENS_LIMIT) {
    throw new RangeError("maxTokens must be a whole number from 1 to 16000.");
  }
}

function checkedTimeout(timeoutMs: number | undefined): number {
  const ms = timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  if (!Number.isSafeInteger(ms) || ms < 1 || ms > MAX_CALL_TIMEOUT_MS) {
    throw new RangeError("timeoutMs must be a whole number of milliseconds from 1 to 2147483647.");
  }
  return ms;
}

function jsonLength(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}

/** Called once after a call that Claude answered, with the tokens it billed. */
type Settle = (used: number) => Promise<void>;
type Spend = { reserved: number; settle: Settle | null };

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

// A count the reply leaves out is taken as the whole reservation, so a reply
// with no usage gives nothing back (C5.1).
function usedTokens(message: Anthropic.Message, reserved: number): number {
  const input: unknown = message.usage?.input_tokens;
  const output: unknown = message.usage?.output_tokens;
  return isCount(input) && isCount(output) ? input + output : reserved;
}

/**
 * The input tokens a call sending `parts` is counted as: their summed JSON
 * length divided by CHARS_PER_TOKEN, rounded up. Every reservation uses it,
 * and so does the research loop's run cap, so the two never disagree.
 */
export function estimateInputTokens(parts: readonly unknown[]): number {
  const sent = parts.reduce<number>((total, part) => total + jsonLength(part), 0);
  return Math.ceil(sent / CHARS_PER_TOKEN);
}

/**
 * Builds the one client that talks to Claude. The model name, effort, token
 * limits and prompts are all chosen by server code, never by a visitor
 * (C2.5). `thinking` is left out and tool_choice stays auto. The API key goes
 * only to the SDK constructor; `client` replaces the SDK client in tests.
 *
 * Before every call it reserves max_tokens plus a third of the JSON length of
 * the system prompt, the messages and the tools (or output schema) through
 * `reserveTokens`, and makes no call if that is refused (C5.1). When
 * `reserveTokens` returns a settle callback instead of true, it is called
 * once after Claude answers, before any check of the reply, with
 * usage.input_tokens plus usage.output_tokens, or with the whole reservation
 * when either count is missing. A call that fails settles nothing, so its
 * reservation stays spent. A settle that throws is logged as "token settle
 * failed" and nothing else, and never fails the call. SDK errors are mapped
 * by class to a fixed AgentError code and nothing from them is kept (C3.6,
 * C4.1).
 *
 * turn() returns the full message. structured() asks for JSON matching
 * `schema` (sent as a JSON schema output format) and checks the reply with
 * the same zod schema before returning it.
 *
 * Every call has a time limit (C2.4): options.timeoutMs, or 45 seconds when
 * it is left out, which is what briefs and the backtest's guest extractor
 * get. The SDK receives that timeout, maxRetries 1, and a signal that fires
 * when either the limit passes or options.signal fires, so the whole call,
 * retry and response body included, ends by then. A signal that has already
 * fired stops the call before any tokens are reserved.
 *
 * Throws AgentError MODEL_KEY_MISSING for an empty key, at creation. Each call
 * throws RangeError for maxTokens outside 1 to 16,000 or a timeoutMs that is
 * not a whole number from 1 to 2,147,483,647; MODEL_TIMEOUT when the time
 * limit passes or options.signal fires; MODEL_BUDGET when the reservation is
 * refused; MODEL_REFUSED on a refusal stop; MODEL_AUTH, MODEL_RATE_LIMIT,
 * MODEL_BAD_REQUEST, MODEL_OVERLOADED or MODEL_UPSTREAM for other SDK
 * failures; and from structured() also MODEL_TRUNCATED when the reply hit
 * max_tokens and AGENT_BAD_PROSE when it is not JSON that passes the schema.
 * A failed reservation's own error, such as StoreError, is passed through.
 */
export function createAnthropicModel(opts: {
  apiKey: string;
  model: string;
  effort: "low" | "medium" | "high";
  reserveTokens: (n: number) => Promise<boolean | ((used: number) => Promise<void>)>;
  client?: Anthropic;
}): ModelClient {
  if (opts.apiKey.trim() === "") throw new AgentError("MODEL_KEY_MISSING");
  const client =
    opts.client ??
    new Anthropic({
      apiKey: opts.apiKey,
      authToken: null,
      baseURL: API_BASE_URL,
      maxRetries: MAX_RETRIES,
      timeout: DEFAULT_CALL_TIMEOUT_MS,
      logLevel: "off",
    });
  const { model, effort } = opts;

  const reserve = async (maxTokens: number, parts: unknown[], signal: AbortSignal | undefined): Promise<Spend> => {
    if (signal?.aborted === true) throw new AgentError("MODEL_TIMEOUT");
    const reserved = maxTokens + estimateInputTokens(parts);
    const outcome = await opts.reserveTokens(reserved);
    if (!outcome) throw new AgentError("MODEL_BUDGET");
    return { reserved, settle: typeof outcome === "function" ? outcome : null };
  };

  const settleFor = async (spend: Spend, message: Anthropic.Message): Promise<void> => {
    if (spend.settle === null) return;
    try {
      await spend.settle(usedTokens(message, spend.reserved));
    } catch {
      // The whole reservation stays charged, which fails closed.
      console.warn("token settle failed");
    }
  };

  const send = async (
    params: Anthropic.MessageCreateParamsNonStreaming,
    timeoutMs: number,
    caller: AbortSignal | undefined,
    spend: Spend,
  ): Promise<Anthropic.Message> => {
    // The SDK's own timeout covers each attempt only up to the response
    // headers. This deadline also covers the retry and the body.
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = caller === undefined ? deadline : AbortSignal.any([caller, deadline]);
    let message: Anthropic.Message;
    try {
      message = await client.messages.create(params, { signal, timeout: timeoutMs, maxRetries: MAX_RETRIES });
    } catch (error) {
      // An abort while the body is read arrives as a plain fetch error, so
      // the fired signal, not the error's class, says it was the time limit.
      throw new AgentError(signal.aborted ? "MODEL_TIMEOUT" : codeFor(error));
    }
    // A refusal or a truncated reply is still billed, so it settles too.
    await settleFor(spend, message);
    return message;
  };

  return {
    async turn({ system, messages, tools, maxTokens }, options = {}) {
      checkMaxTokens(maxTokens);
      const timeoutMs = checkedTimeout(options.timeoutMs);
      const spend = await reserve(maxTokens, [system, messages, tools], options.signal);
      const message = await send(
        {
          model,
          max_tokens: maxTokens,
          system,
          messages,
          ...(tools.length > 0 ? { tools } : {}),
          output_config: { effort },
        },
        timeoutMs,
        options.signal,
        spend,
      );
      if (message.stop_reason === "refusal") throw new AgentError("MODEL_REFUSED");
      return message;
    },

    async structured<T>(
      { system, user, schema, maxTokens }: { system: string; user: string; schema: z.ZodType<T>; maxTokens: number },
      options: ModelCallOptions = {},
    ) {
      checkMaxTokens(maxTokens);
      const timeoutMs = checkedTimeout(options.timeoutMs);
      const format = zodOutputFormat(schema);
      const messages: Anthropic.MessageParam[] = [{ role: "user", content: user }];
      const spend = await reserve(maxTokens, [system, messages, format.schema], options.signal);
      const message = await send(
        {
          model,
          max_tokens: maxTokens,
          system,
          messages,
          output_config: { effort, format: { type: "json_schema", schema: format.schema } },
        },
        timeoutMs,
        options.signal,
        spend,
      );
      if (message.stop_reason === "refusal") throw new AgentError("MODEL_REFUSED");
      if (message.stop_reason === "max_tokens") throw new AgentError("MODEL_TRUNCATED");

      const text = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        throw new AgentError("AGENT_BAD_PROSE");
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new AgentError("AGENT_BAD_PROSE");
      return parsed.data;
    },
  };
}
