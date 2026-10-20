// Covers the Turnstile siteverify call against fake fetch functions: the
// request shape, every way the answer fails closed, and the binding of an
// answer to this site's hostname and to one action (C5.9). It does not cover
// Cloudflare itself (the published test secrets were checked live with curl
// on 19 Oct 2026), the widget in the browser, or token replay, which
// Cloudflare refuses on its side.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TURNSTILE_TEST_SECRET_ALWAYS_PASSES } from "../src/server/config.js";
import { ServerError } from "../src/server/errors.js";
import { createTurnstileVerifier, TURNSTILE_ACTIONS } from "../src/server/turnstile.js";

const SECRET = "0x4AAAAAAA-SECRET-MARKER-9d1e";
const TOKEN = "token-MARKER-4b2a";
const HOST = "app.example";
const RUN_START = TURNSTILE_ACTIONS.runStart;
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

const solved = (extra: Record<string, unknown> = {}) => ({ success: true, hostname: HOST, action: RUN_START, ...extra });

const verifierFor = (reply: () => Response, secret = SECRET) =>
  createTurnstileVerifier({ secret, expectedHostname: HOST, fetchImpl: fakeFetch(reply).fetchImpl });

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
  it("is true for a 200 with success, this hostname and the action, and sends a form with remoteip", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(solved()));
    const verify = createTurnstileVerifier({ secret: SECRET, expectedHostname: HOST, fetchImpl });

    expect(await verify(TOKEN, "203.0.113.9", RUN_START)).toBe(true);

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
    const { fetchImpl, calls } = fakeFetch(() => json(solved()));
    const verify = createTurnstileVerifier({ secret: SECRET, expectedHostname: HOST, fetchImpl });

    expect(await verify("a&secret=other&b=c", null, RUN_START)).toBe(true);

    const form = new URLSearchParams(calls[0]!.init?.body as string);
    expect([...form.keys()]).toEqual(["secret", "response"]);
    expect(form.get("secret")).toBe(SECRET);
    expect(form.get("response")).toBe("a&secret=other&b=c");
  });

  it("is false for any answer other than a 200 with success === true", async () => {
    const replies: Array<() => Response> = [
      () => json({ success: false, hostname: HOST, action: RUN_START, "error-codes": ["invalid-input-response"] }),
      () => json(solved({ success: "true" })),
      () => json(solved({ success: 1 })),
      () => json({}),
      () => json(null),
      () => json([solved()]),
      () => json(solved(), 500),
      () => json(solved(), 201),
      () => new Response("{not json", { status: 200 }),
      () => new Response(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]), { status: 200 }),
      () => new Response(null, { status: 200 }),
      () => json(solved({ pad: "x".repeat(64 * 1024) })),
    ];
    for (const reply of replies) {
      expect(await verifierFor(reply)(TOKEN, null, RUN_START)).toBe(false);
    }
  });

  it("accepts a body just under the 64 KiB cap", async () => {
    expect(await verifierFor(() => json(solved({ pad: "x".repeat(60 * 1024) })))(TOKEN, null, RUN_START)).toBe(true);
  });

  it("is false when fetch fails, including with an error that carries the secret", async () => {
    for (const failure of [
      new TypeError("fetch failed: redirect mode is set to error"),
      new Error(`request failed: secret=${SECRET}&response=${TOKEN}`),
    ]) {
      const fetchImpl = (async () => {
        throw failure;
      }) as typeof fetch;
      expect(await createTurnstileVerifier({ secret: SECRET, expectedHostname: HOST, fetchImpl })(TOKEN, null, RUN_START)).toBe(false);
    }
  });

  it("is false on a timeout, even when fetch ignores the abort signal", async () => {
    const neverAnswers = (() => new Promise<Response>(() => {})) as typeof fetch;
    const verify = createTurnstileVerifier({ secret: SECRET, expectedHostname: HOST, fetchImpl: neverAnswers, timeoutMs: 50 });
    const started = Date.now();

    expect(await verify(TOKEN, null, RUN_START)).toBe(false);
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

    expect(await createTurnstileVerifier({ secret: SECRET, expectedHostname: HOST, fetchImpl, timeoutMs: 50 })(TOKEN, null, RUN_START)).toBe(
      false,
    );
    expect(signal?.aborted).toBe(true);
  });

  it("is false without a request for an empty, oversized or non-string token, or no action", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(solved()));
    const verify = createTurnstileVerifier({ secret: SECRET, expectedHostname: HOST, fetchImpl });

    expect(await verify("", null, RUN_START)).toBe(false);
    expect(await verify("x".repeat(2_049), null, RUN_START)).toBe(false);
    expect(await verify(undefined as unknown as string, null, RUN_START)).toBe(false);
    expect(await verify(TOKEN, null, "")).toBe(false);
    expect(await verify(TOKEN, null, undefined as unknown as string)).toBe(false);
    expect(calls).toHaveLength(0);

    expect(await verify("x".repeat(2_048), null, RUN_START)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("refuses bad options with a fixed message that never holds the secret", () => {
    const bad = [
      { secret: "", expectedHostname: HOST },
      { secret: SECRET, expectedHostname: "" },
      { secret: SECRET, expectedHostname: undefined as unknown as string },
      { secret: SECRET, expectedHostname: HOST, timeoutMs: 0 },
      { secret: SECRET, expectedHostname: HOST, timeoutMs: 30_001 },
      { secret: SECRET, expectedHostname: HOST, timeoutMs: 1.5 },
    ];
    for (const opts of bad) {
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

describe("binding an answer to this site and this action (C5.9)", () => {
  it("passes this hostname in any ASCII case, on either side", async () => {
    expect(await verifierFor(() => json(solved({ hostname: "App.EXAMPLE" })))(TOKEN, null, RUN_START)).toBe(true);
    const fetchImpl = fakeFetch(() => json(solved())).fetchImpl;
    expect(await createTurnstileVerifier({ secret: SECRET, expectedHostname: "APP.Example", fetchImpl })(TOKEN, null, RUN_START)).toBe(true);
  });

  it("refuses an answer solved on another site, or with no usable hostname", async () => {
    const hostnames: unknown[] = ["evil.example", "app.example.evil.example", "evil-app.example", "app.example.", " app.example", 123, null];
    for (const hostname of hostnames) {
      expect(await verifierFor(() => json(solved({ hostname })))(TOKEN, null, RUN_START), String(hostname)).toBe(false);
    }
    expect(await verifierFor(() => json({ success: true, action: RUN_START }))(TOKEN, null, RUN_START)).toBe(false);
  });

  it("refuses a Unicode hostname that only lower-cases into ours", async () => {
    const fetchImpl = fakeFetch(() => json(solved({ hostname: "Kuri.example" }))).fetchImpl;
    const verify = createTurnstileVerifier({ secret: SECRET, expectedHostname: "kuri.example", fetchImpl });

    expect("Kuri.example".toLowerCase()).toBe("kuri.example");
    expect(await verify(TOKEN, null, RUN_START)).toBe(false);
  });

  it("refuses the agent-key action, a missing action, or a near miss on a run start", async () => {
    const actions: unknown[] = [TURNSTILE_ACTIONS.agentKey, "RUN_START", "run_start ", "", "test", 1, null];
    for (const action of actions) {
      expect(await verifierFor(() => json(solved({ action })))(TOKEN, null, RUN_START), String(action)).toBe(false);
    }
    expect(await verifierFor(() => json({ success: true, hostname: HOST }))(TOKEN, null, RUN_START)).toBe(false);
  });

  it("never lets a run-start answer issue an agent key", async () => {
    expect(await verifierFor(() => json(solved()))(TOKEN, null, TURNSTILE_ACTIONS.agentKey)).toBe(false);
    expect(await verifierFor(() => json(solved({ action: TURNSTILE_ACTIONS.agentKey })))(TOKEN, null, TURNSTILE_ACTIONS.agentKey)).toBe(true);
  });
});

describe("Cloudflare's always-pass test secret (development only)", () => {
  // The reply the live service gave on 19 Oct 2026, and the one the testing docs show.
  const LIVE_REPLY = { success: true, "error-codes": [], hostname: "example.com", metadata: { result_with_testing_key: true } };
  const DOCUMENTED_REPLY = { success: true, "error-codes": [], hostname: "localhost", action: "test", cdata: "test-data" };

  it("checks only success with that secret, because its answer cannot name this site", async () => {
    for (const reply of [LIVE_REPLY, DOCUMENTED_REPLY]) {
      expect(await verifierFor(() => json(reply), TURNSTILE_TEST_SECRET_ALWAYS_PASSES)(TOKEN, null, RUN_START)).toBe(true);
    }
    const refused = { success: false, "error-codes": ["invalid-input-response"], metadata: { result_with_testing_key: true } };
    expect(await verifierFor(() => json(refused), TURNSTILE_TEST_SECRET_ALWAYS_PASSES)(TOKEN, null, RUN_START)).toBe(false);
  });

  it("holds every other secret to the full binding, even for a reply shaped like the test one", async () => {
    for (const reply of [LIVE_REPLY, DOCUMENTED_REPLY]) {
      expect(await verifierFor(() => json(reply))(TOKEN, null, RUN_START)).toBe(false);
    }
  });
});
