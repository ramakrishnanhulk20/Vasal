// Covers the Turnstile siteverify call against fake fetch functions: the
// request shape and every way the answer fails closed. It does not cover
// Cloudflare itself (a scratchpad script checks the published test secrets
// live), the widget in the browser, or checking the hostname or action that
// Cloudflare returns.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerError } from "../src/server/errors.js";
import { createTurnstileVerifier } from "../src/server/turnstile.js";

const SECRET = "0x4AAAAAAA-SECRET-MARKER-9d1e";
const TOKEN = "token-MARKER-4b2a";
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

type Call = { url: string; init: RequestInit | undefined };

function fakeFetch(reply: () => Response | Promise<Response>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return reply();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;
let spies: Array<ReturnType<typeof vi.spyOn>>;

beforeEach(() => {
  spies = CONSOLE_METHODS.map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
});

afterEach(() => {
  for (const spy of spies) {
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  }
});

describe("createTurnstileVerifier", () => {
  it("is true for a 200 with success true, and sends a form with remoteip", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json({ success: true, hostname: "app.example" }));
    const verify = createTurnstileVerifier({ secret: SECRET, fetchImpl });

    expect(await verify(TOKEN, "203.0.113.9")).toBe(true);

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(SITEVERIFY);
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(typeof init?.body).toBe("string");
    const form = new URLSearchParams(init?.body as string);
    expect([...form.keys()]).toEqual(["secret", "response", "remoteip"]);
    expect(form.get("secret")).toBe(SECRET);
    expect(form.get("response")).toBe(TOKEN);
    expect(form.get("remoteip")).toBe("203.0.113.9");
  });

  it("leaves remoteip out when there is none, and encodes the token as one value", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json({ success: true }));
    const verify = createTurnstileVerifier({ secret: SECRET, fetchImpl });

    expect(await verify("a&secret=other&b=c", null)).toBe(true);

    const form = new URLSearchParams(calls[0]!.init?.body as string);
    expect([...form.keys()]).toEqual(["secret", "response"]);
    expect(form.get("secret")).toBe(SECRET);
    expect(form.get("response")).toBe("a&secret=other&b=c");
  });

  it("is false for any answer other than a 200 with success === true", async () => {
    const replies: Array<() => Response> = [
      () => json({ success: false, "error-codes": ["invalid-input-response"] }),
      () => json({ success: "true" }),
      () => json({ success: 1 }),
      () => json({}),
      () => json(null),
      () => json([{ success: true }]),
      () => json({ success: true }, 500),
      () => json({ success: true }, 201),
      () => new Response("{not json", { status: 200 }),
      () => new Response(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]), { status: 200 }),
      () => new Response(null, { status: 200 }),
      () => json({ success: true, pad: "x".repeat(64 * 1024) }),
    ];
    for (const reply of replies) {
      const { fetchImpl } = fakeFetch(reply);
      expect(await createTurnstileVerifier({ secret: SECRET, fetchImpl })(TOKEN, null)).toBe(false);
    }
  });

  it("accepts a body just under the 64 KiB cap", async () => {
    const { fetchImpl } = fakeFetch(() => json({ success: true, pad: "x".repeat(60 * 1024) }));
    expect(await createTurnstileVerifier({ secret: SECRET, fetchImpl })(TOKEN, null)).toBe(true);
  });

  it("is false when fetch fails, including with an error that carries the secret", async () => {
    for (const failure of [
      new TypeError("fetch failed: redirect mode is set to error"),
      new Error(`request failed: secret=${SECRET}&response=${TOKEN}`),
    ]) {
      const fetchImpl = (async () => {
        throw failure;
      }) as typeof fetch;
      expect(await createTurnstileVerifier({ secret: SECRET, fetchImpl })(TOKEN, null)).toBe(false);
    }
  });

  it("is false on a timeout, even when fetch ignores the abort signal", async () => {
    const neverAnswers = (() => new Promise<Response>(() => {})) as typeof fetch;
    const started = Date.now();

    expect(await createTurnstileVerifier({ secret: SECRET, fetchImpl: neverAnswers, timeoutMs: 50 })(TOKEN, null)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("is false when the body never finishes, and aborts the request", async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"success":'));
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    expect(await createTurnstileVerifier({ secret: SECRET, fetchImpl, timeoutMs: 50 })(TOKEN, null)).toBe(false);
    expect(signal?.aborted).toBe(true);
  });

  it("is false without a request for an empty, oversized or non-string token", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json({ success: true }));
    const verify = createTurnstileVerifier({ secret: SECRET, fetchImpl });

    expect(await verify("", null)).toBe(false);
    expect(await verify("x".repeat(2_049), null)).toBe(false);
    expect(await verify(undefined as unknown as string, null)).toBe(false);
    expect(calls).toHaveLength(0);

    expect(await verify("x".repeat(2_048), null)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("refuses bad options with a fixed message that never holds the secret", () => {
    for (const opts of [{ secret: "" }, { secret: SECRET, timeoutMs: 0 }, { secret: SECRET, timeoutMs: 30_001 }, { secret: SECRET, timeoutMs: 1.5 }]) {
      let caught: unknown;
      try {
        createTurnstileVerifier(opts);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ServerError);
      expect((caught as ServerError).code).toBe("SRV_BAD_INPUT");
      expect(String(caught)).not.toContain("MARKER");
      expect(JSON.stringify(caught)).not.toContain("MARKER");
    }
  });
});
