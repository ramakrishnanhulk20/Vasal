// Covers the Claude client wrapper against a fake SDK client: the request it
// sends and the request options (timeout, signal, one retry), the token
// reservation that comes before every call, each call's time limit, the
// mapping of each SDK error class to a fixed code, refusal and truncation
// stops, and checking structured replies. It does not cover the real SDK's
// network behaviour, its retry timing, or how well any real model follows
// the prompts. No real Anthropic call is made.
import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentError } from "../src/agent/errors.js";
import { createAnthropicModel } from "../src/agent/model.js";

const MARKER = "MARKER-7a11e";
const API_KEY = `sk-ant-test-${MARKER}-key`;
const TOOLS: Anthropic.Tool[] = [
  { name: "people_for_show", description: "d", input_schema: { type: "object", properties: {}, additionalProperties: false } },
];

function message(over: Record<string, unknown> = {}): Anthropic.Message {
  return {
    id: "msg_synthetic",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [{ type: "text", text: "ok", citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    container: null,
    diagnostics: null,
    usage: { input_tokens: 10, output_tokens: 5 },
    ...over,
  } as unknown as Anthropic.Message;
}

type SdkOptions = NonNullable<Parameters<Anthropic["messages"]["create"]>[1]>;

function fakeSdk(respond: (options?: SdkOptions) => Promise<Anthropic.Message>) {
  const create = vi.fn<(params: Anthropic.MessageCreateParamsNonStreaming, options?: SdkOptions) => Promise<Anthropic.Message>>(
    (_params, options) => respond(options),
  );
  const client = { messages: { create } } as unknown as Anthropic;
  return { client, create };
}

// Like the real SDK: no answer ever comes, and the call rejects with
// `onAbort()` once the request's signal fires, or at once if it already has.
const neverAnswers =
  (onAbort: () => Error = () => new APIUserAbortError()) =>
  (options?: SdkOptions) =>
    new Promise<Anthropic.Message>((_resolve, reject) => {
      if (options?.signal?.aborted === true) reject(new APIUserAbortError());
      options?.signal?.addEventListener("abort", () => reject(onAbort()), { once: true });
    });

function build(respond: (options?: SdkOptions) => Promise<Anthropic.Message> = async () => message(), reserved = true) {
  const { client, create } = fakeSdk(respond);
  const reserveTokens = vi.fn<(n: number) => Promise<boolean>>(async () => reserved);
  const model = createAnthropicModel({ apiKey: API_KEY, model: "claude-haiku-5-5", effort: "medium", reserveTokens, client });
  return { model, create, reserveTokens };
}

const turnInput = () => ({
  system: "system text",
  messages: [{ role: "user", content: "Show to research: \"Synthetic Show\"" }] as Anthropic.MessageParam[],
  tools: TOOLS,
  maxTokens: 8000,
});

async function agentErrorOf(promise: Promise<unknown>): Promise<AgentError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AgentError);
    return error as AgentError;
  }
  throw new Error("expected an AgentError");
}

function expectClean(error: AgentError): void {
  for (const text of [error.message, String(error), JSON.stringify(error), error.stack ?? ""]) {
    expect(text).not.toContain(MARKER);
    expect(text).not.toContain(API_KEY);
  }
  expect((error as { cause?: unknown }).cause).toBeUndefined();
}

describe("createAnthropicModel turn", () => {
  it("reserves tokens first, then sends the configured model and effort with no thinking and no tool choice", async () => {
    const { model, create, reserveTokens } = build();
    const input = turnInput();

    const reply = await model.turn(input);

    expect(reply.id).toBe("msg_synthetic");
    const sent = JSON.stringify(input.system).length + JSON.stringify(input.messages).length + JSON.stringify(input.tools).length;
    expect(reserveTokens).toHaveBeenCalledWith(8000 + Math.ceil(sent / 3));
    expect(reserveTokens.mock.invocationCallOrder[0]!).toBeLessThan(create.mock.invocationCallOrder[0]!);
    const params = create.mock.calls[0]![0];
    expect(params).toEqual({
      model: "claude-haiku-5-5",
      max_tokens: 8000,
      system: "system text",
      messages: input.messages,
      tools: TOOLS,
      output_config: { effort: "medium" },
    });
    expect(params).not.toHaveProperty("thinking");
    expect(params).not.toHaveProperty("tool_choice");
    expect(JSON.stringify(params)).not.toContain(API_KEY);
  });

  it("makes no SDK call when the token reservation is refused (C5.1)", async () => {
    const { model, create } = build(undefined, false);

    expect((await agentErrorOf(model.turn(turnInput()))).code).toBe("MODEL_BUDGET");
    expect((await agentErrorOf(model.structured({ system: "s", user: "u", schema: z.object({ a: z.string() }), maxTokens: 100 }))).code).toBe(
      "MODEL_BUDGET",
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("turns a refusal stop into MODEL_REFUSED", async () => {
    const { model } = build(async () => message({ stop_reason: "refusal", content: [{ type: "text", text: MARKER, citations: null }] }));

    const error = await agentErrorOf(model.turn(turnInput()));

    expect(error.code).toBe("MODEL_REFUSED");
    expectClean(error);
  });

  it("maps each SDK error class to its code by instanceof and copies nothing from it (C3.6, C4.1)", async () => {
    const headers = new Headers({ "x-api-key": API_KEY });
    const body = { error: { type: "api_error", message: MARKER }, request: API_KEY };
    const cases: Array<[Error, string]> = [
      [new AuthenticationError(401, body, `${MARKER} ${API_KEY}`, headers), "MODEL_AUTH"],
      [new PermissionDeniedError(403, body, MARKER, headers), "MODEL_AUTH"],
      [new RateLimitError(429, body, MARKER, headers), "MODEL_RATE_LIMIT"],
      [new BadRequestError(400, body, MARKER, headers), "MODEL_BAD_REQUEST"],
      [new NotFoundError(404, body, MARKER, headers), "MODEL_BAD_REQUEST"],
      [new InternalServerError(529, body, MARKER, headers, "overloaded_error"), "MODEL_OVERLOADED"],
      [new InternalServerError(500, body, MARKER, headers, "api_error"), "MODEL_UPSTREAM"],
      [new InternalServerError(503, body, MARKER, headers, "overloaded_error"), "MODEL_OVERLOADED"],
      [new APIError(418, body, MARKER, headers), "MODEL_UPSTREAM"],
      [new APIUserAbortError({ message: MARKER }), "MODEL_TIMEOUT"],
      [new APIConnectionTimeoutError({ message: MARKER }), "MODEL_TIMEOUT"],
      [new APIConnectionError({ message: MARKER, cause: new Error(API_KEY) }), "MODEL_UPSTREAM"],
      [new Error(`${MARKER} ${API_KEY}`), "MODEL_UPSTREAM"],
    ];

    for (const [thrown, code] of cases) {
      const { model } = build(async () => {
        throw thrown;
      });
      const fromTurn = await agentErrorOf(model.turn(turnInput()));
      const fromStructured = await agentErrorOf(
        model.structured({ system: "s", user: "u", schema: z.object({ a: z.string() }), maxTokens: 100 }),
      );
      expect([fromTurn.code, fromStructured.code]).toEqual([code, code]);
      expectClean(fromTurn);
      expectClean(fromStructured);
    }
  });

  it("refuses an empty key and an out-of-range token limit before any call", async () => {
    const { client, create } = fakeSdk(async () => message());
    const reserveTokens = vi.fn(async () => true);
    expect(() => createAnthropicModel({ apiKey: "  ", model: "claude-haiku-5-5", effort: "low", reserveTokens, client })).toThrow(AgentError);

    const model = createAnthropicModel({ apiKey: API_KEY, model: "claude-haiku-5-5", effort: "low", reserveTokens, client });
    for (const maxTokens of [0, -1, 1.5, 16_001, Number.NaN]) {
      await expect(model.turn({ ...turnInput(), maxTokens })).rejects.toThrow(RangeError);
    }
    expect(reserveTokens).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});

describe("createAnthropicModel time limits (C2.4)", () => {
  const schema = z.object({ a: z.string() });
  const structuredInput = () => ({ system: "s", user: "u", schema, maxTokens: 100 });

  it("hands the SDK the caller's timeout, one retry and a signal that follows the caller's", async () => {
    const { model, create } = build();
    const caller = new AbortController();

    await model.turn(turnInput(), { signal: caller.signal, timeoutMs: 7_000 });

    const options = create.mock.calls[0]![1]!;
    expect(options.timeout).toBe(7_000);
    expect(options.maxRetries).toBe(1);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal?.aborted).toBe(false);
    caller.abort();
    expect(options.signal?.aborted).toBe(true);
  });

  it("gives a call with no timeout 45 seconds, as briefs and the guest extractor use", async () => {
    const { model, create } = build(async () => message({ content: [{ type: "text", text: '{"a":"b"}', citations: null }] }));

    await model.structured(structuredInput());

    const options = create.mock.calls[0]![1]!;
    expect(options.timeout).toBe(45_000);
    expect(options.maxRetries).toBe(1);
    expect(options.signal?.aborted).toBe(false);
  });

  it("ends a call that never answers at its own limit, with no caller signal", async () => {
    const { model, create } = build(neverAnswers());
    const started = Date.now();

    const error = await agentErrorOf(model.structured(structuredInput(), { timeoutMs: 200 }));

    const elapsed = Date.now() - started;
    expect(error.code).toBe("MODEL_TIMEOUT");
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(1_200);
    expect(create.mock.calls[0]![1]!.signal?.aborted).toBe(true);
  });

  it("calls it MODEL_TIMEOUT when the signal fires while the body is read, and makes no call once it has fired", async () => {
    const caller = new AbortController();
    const reading = build(neverAnswers(() => new DOMException(`${MARKER} aborted`, "AbortError") as unknown as Error));
    const pending = agentErrorOf(reading.model.turn(turnInput(), { signal: caller.signal, timeoutMs: 60_000 }));
    await vi.waitFor(() => expect(reading.create).toHaveBeenCalledTimes(1));
    caller.abort();
    const error = await pending;
    expect(error.code).toBe("MODEL_TIMEOUT");
    expectClean(error);

    const late = build();
    const fired = AbortSignal.abort();
    expect((await agentErrorOf(late.model.turn(turnInput(), { signal: fired }))).code).toBe("MODEL_TIMEOUT");
    expect((await agentErrorOf(late.model.structured(structuredInput(), { signal: fired }))).code).toBe("MODEL_TIMEOUT");
    expect(late.reserveTokens).not.toHaveBeenCalled();
    expect(late.create).not.toHaveBeenCalled();
  });

  it("refuses a timeout that is not a whole number of milliseconds from 1 to 2147483647 before any call", async () => {
    const { model, create, reserveTokens } = build();
    for (const timeoutMs of [0, -1, 1.5, Number.NaN, 2 ** 31]) {
      await expect(model.turn(turnInput(), { timeoutMs })).rejects.toThrow(RangeError);
      await expect(model.structured(structuredInput(), { timeoutMs })).rejects.toThrow(RangeError);
    }
    expect(reserveTokens).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});

describe("createAnthropicModel structured", () => {
  const schema = z.object({ kind: z.enum(["one", "none"]), name: z.string().max(10).nullable() }).strict();

  it("asks for the schema as a JSON output format and returns the checked value", async () => {
    const { model, create, reserveTokens } = build(async () =>
      message({
        content: [
          { type: "thinking", thinking: "", signature: "sig" },
          { type: "text", text: '{"kind":"one","name":"Dax"}', citations: null },
        ],
      }),
    );

    expect(await model.structured({ system: "extract", user: "title", schema, maxTokens: 200 })).toEqual({ kind: "one", name: "Dax" });

    const params = create.mock.calls[0]![0];
    expect(params.max_tokens).toBe(200);
    expect(params.messages).toEqual([{ role: "user", content: "title" }]);
    expect(params.output_config?.effort).toBe("medium");
    expect(params.output_config?.format?.type).toBe("json_schema");
    expect(params.output_config?.format?.schema).toMatchObject({ type: "object", required: ["kind", "name"], additionalProperties: false });
    expect(params).not.toHaveProperty("tools");
    expect(reserveTokens.mock.calls[0]![0]).toBeGreaterThan(200);
  });

  it("gives MODEL_TRUNCATED at max_tokens and AGENT_BAD_PROSE for text that is not JSON or fails the schema", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ stop_reason: "max_tokens", content: [{ type: "text", text: '{"kind":"one","na', citations: null }] }, "MODEL_TRUNCATED"],
      [{ stop_reason: "refusal", content: [] }, "MODEL_REFUSED"],
      [{ content: [{ type: "text", text: `not json ${MARKER}`, citations: null }] }, "AGENT_BAD_PROSE"],
      [{ content: [{ type: "text", text: `{"kind":"one","name":"${MARKER}-too-long"}`, citations: null }] }, "AGENT_BAD_PROSE"],
      [{ content: [{ type: "text", text: '{"kind":"one","name":"Dax","extra":1}', citations: null }] }, "AGENT_BAD_PROSE"],
      [{ content: [] }, "AGENT_BAD_PROSE"],
    ];
    for (const [over, code] of cases) {
      const { model } = build(async () => message(over));
      const error = await agentErrorOf(model.structured({ system: "s", user: "u", schema, maxTokens: 200 }));
      expect(error.code).toBe(code);
      expectClean(error);
    }
  });
});
