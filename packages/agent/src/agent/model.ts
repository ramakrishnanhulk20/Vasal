import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
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

export type ModelClient = {
  turn(p: {
    system: string;
    messages: Anthropic.MessageParam[];
    tools: Anthropic.Tool[];
    maxTokens: number;
  }): Promise<Anthropic.Message>;
  structured<T>(p: { system: string; user: string; schema: z.ZodType<T>; maxTokens: number }): Promise<T>;
};

// Pinned, so an ANTHROPIC_BASE_URL left in the environment can never send the
// key anywhere else.
const API_BASE_URL = "https://api.anthropic.com";
const REQUEST_TIMEOUT_MS = 60_000;
// The SDK retries 429 and 5xx, honouring Retry-After, then the call fails (C5.2).
const MAX_RETRIES = 2;
const MAX_TOKENS_LIMIT = 16_000;
const OVERLOADED_STATUS = 529;
// About three characters of JSON per token. Reserving on the high side of the
// real count fails closed: the day's budget runs out early, never over (C5.1).
const CHARS_PER_TOKEN = 3;

// instanceof only, most specific first, never the message text: SDK messages
// can quote the request or the response body.
function codeFor(error: unknown): AgentErrorCode {
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

function jsonLength(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}

/**
 * Builds the one client that talks to Claude. The model name, effort, token
 * limits and prompts are all chosen by server code, never by a visitor
 * (C2.5). `thinking` is left out and tool_choice stays auto. The API key goes
 * only to the SDK constructor; `client` replaces the SDK client in tests.
 *
 * Before every call it reserves max_tokens plus a third of the JSON length of
 * the system prompt, the messages and the tools (or output schema) through
 * `reserveTokens`, and makes no call if that is refused (C5.1). SDK errors
 * are mapped by class to a fixed AgentError code and nothing from them is
 * kept (C3.6, C4.1).
 *
 * turn() returns the full message. structured() asks for JSON matching
 * `schema` (sent as a JSON schema output format) and checks the reply with
 * the same zod schema before returning it.
 *
 * Throws AgentError MODEL_KEY_MISSING for an empty key, at creation. Each call
 * throws RangeError for maxTokens outside 1 to 16,000; MODEL_BUDGET when the
 * reservation is refused; MODEL_REFUSED on a refusal stop; MODEL_AUTH,
 * MODEL_RATE_LIMIT, MODEL_BAD_REQUEST, MODEL_OVERLOADED, MODEL_UPSTREAM or
 * MODEL_TIMEOUT for SDK failures; and from structured() also MODEL_TRUNCATED
 * when the reply hit max_tokens and AGENT_BAD_PROSE when it is not JSON that
 * passes the schema. A failed reservation's own error, such as StoreError, is
 * passed through.
 */
export function createAnthropicModel(opts: {
  apiKey: string;
  model: string;
  effort: "low" | "medium" | "high";
  reserveTokens: (n: number) => Promise<boolean>;
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
      timeout: REQUEST_TIMEOUT_MS,
      logLevel: "off",
    });
  const { model, effort } = opts;

  const reserve = async (maxTokens: number, parts: unknown[]): Promise<void> => {
    const sent = parts.reduce<number>((total, part) => total + jsonLength(part), 0);
    if (!(await opts.reserveTokens(maxTokens + Math.ceil(sent / CHARS_PER_TOKEN)))) throw new AgentError("MODEL_BUDGET");
  };

  const send = async (params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> => {
    try {
      return await client.messages.create(params);
    } catch (error) {
      throw new AgentError(codeFor(error));
    }
  };

  return {
    async turn({ system, messages, tools, maxTokens }) {
      checkMaxTokens(maxTokens);
      await reserve(maxTokens, [system, messages, tools]);
      const message = await send({
        model,
        max_tokens: maxTokens,
        system,
        messages,
        ...(tools.length > 0 ? { tools } : {}),
        output_config: { effort },
      });
      if (message.stop_reason === "refusal") throw new AgentError("MODEL_REFUSED");
      return message;
    },

    async structured<T>({ system, user, schema, maxTokens }: { system: string; user: string; schema: z.ZodType<T>; maxTokens: number }) {
      checkMaxTokens(maxTokens);
      const format = zodOutputFormat(schema);
      const messages: Anthropic.MessageParam[] = [{ role: "user", content: user }];
      await reserve(maxTokens, [system, messages, format.schema]);
      const message = await send({
        model,
        max_tokens: maxTokens,
        system,
        messages,
        output_config: { effort, format: { type: "json_schema", schema: format.schema } },
      });
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
