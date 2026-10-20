import { z } from "zod";
import { TURNSTILE_TEST_SECRET_ALWAYS_PASSES } from "./config.js";
import { ServerError } from "./errors.js";

/**
 * The action name each human-check surface sets on its widget (`data-action`
 * or the `action` render option) and the server demands back from siteverify
 * (C5.9, D1.5). An answer solved for one surface is refused by the other.
 */
export const TURNSTILE_ACTIONS = { runStart: "run_start", agentKey: "agent_key" } as const;

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 64 * 1024;
// Cloudflare documents tokens of up to 2048 characters.
const MAX_TOKEN_LENGTH = 2_048;
const MAX_REMOTE_IP_LENGTH = 100;

// Only the literal boolean true passes. "true", 1 and a missing field fail.
const succeeded = z.object({ success: z.literal(true) });
const bound = succeeded.extend({ hostname: z.string(), action: z.string() });

// Hostnames ignore case only for ASCII letters, which is also all the URL
// parser lower-cases. String toLowerCase would fold the Kelvin sign U+212A
// into "k" and let a different name pass as ours.
const ASCII_UPPER = /[A-Z]+/g;
const lowerAscii = (text: string): string => text.replace(ASCII_UPPER, (letters) => letters.toLowerCase());

async function readCapped(response: Response): Promise<string | null> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) return null;
  if (response.body === null) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    return null;
  }
}

// Resolves to the parsed JSON body of a 200 reply, or undefined for anything
// else, so the caller judges only a complete, well-formed answer.
async function siteverify(fetchImpl: typeof fetch, form: URLSearchParams, signal: AbortSignal): Promise<unknown> {
  const response = await fetchImpl(SITEVERIFY_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    redirect: "error",
    signal,
  });
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    return undefined;
  }
  const text = await readCapped(response);
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Builds the human check (C5.9). The returned function POSTs secret,
 * response and, when given, remoteip as a form to Cloudflare's siteverify
 * endpoint, refusing redirects, and resolves true only when the reply is a
 * 200 whose JSON body has success === true, a string `hostname` equal to
 * `expectedHostname` (ASCII letters lower-cased on both sides), and a string
 * `action` exactly equal to `expectedAction`, one of TURNSTILE_ACTIONS.
 * Everything else resolves false: an empty token or one over 2,048
 * characters, or an empty expectedAction (no request is made for these), a
 * network error, a redirect, a non-200, a body over 64 KiB, bytes that are
 * not UTF-8 JSON, another hostname or action, a missing one, and no answer
 * within `timeoutMs` (default 5,000). The timer covers the request and the
 * body together, so even a fetch that ignores the abort signal cannot hold a
 * run start open. With Cloudflare's always-pass test secret only `success`
 * is checked, because that secret's answer cannot name this site; config
 * refuses every test secret in production. The returned function never
 * throws and never logs; neither the secret nor the token appears in
 * anything it produces. Throws ServerError("SRV_BAD_INPUT") at build time
 * for an empty secret, an empty expectedHostname or a timeoutMs outside 1 to
 * 30,000; that message is fixed and never holds the secret.
 */
export function createTurnstileVerifier(opts: {
  secret: string;
  expectedHostname: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): (token: string, remoteIp: string | null, expectedAction: string) => Promise<boolean> {
  const { secret } = opts;
  if (typeof secret !== "string" || secret.length === 0) throw new ServerError("SRV_BAD_INPUT");
  if (typeof opts.expectedHostname !== "string" || opts.expectedHostname.length === 0) {
    throw new ServerError("SRV_BAD_INPUT");
  }
  const hostname = lowerAscii(opts.expectedHostname);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new ServerError("SRV_BAD_INPUT");
  }
  const fetchImpl: typeof fetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  // The always-pass test secret passes any token from any page, so the check
  // is already off and binding its answer proves nothing. Its answer cannot
  // name this site either: the testing docs show hostname "localhost" with
  // action "test", and on 19 Oct 2026 the live service answered hostname
  // "example.com" with no action at all. Only development can reach this,
  // because config refuses every test secret in production.
  const testSecret = secret === TURNSTILE_TEST_SECRET_ALWAYS_PASSES;

  const accepts = (body: unknown, expectedAction: string): boolean => {
    if (testSecret) return succeeded.safeParse(body).success;
    const parsed = bound.safeParse(body);
    return parsed.success && lowerAscii(parsed.data.hostname) === hostname && parsed.data.action === expectedAction;
  };

  return async (token, remoteIp, expectedAction) => {
    if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return false;
    if (typeof expectedAction !== "string" || expectedAction.length === 0) return false;

    const form = new URLSearchParams();
    form.set("secret", secret);
    form.set("response", token);
    if (typeof remoteIp === "string" && remoteIp !== "" && remoteIp.length <= MAX_REMOTE_IP_LENGTH) {
      form.set("remoteip", remoteIp);
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      const answer = siteverify(fetchImpl, form, controller.signal).then((body) => accepts(body, expectedAction));
      return await Promise.race([answer, timedOut]);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
}
