import { z } from "zod";
import { ServerError } from "./errors.js";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 64 * 1024;
// Cloudflare documents tokens of up to 2048 characters.
const MAX_TOKEN_LENGTH = 2_048;
const MAX_REMOTE_IP_LENGTH = 100;

// Only the literal boolean true passes. "true", 1 and a missing field fail.
const passed = z.object({ success: z.literal(true) });

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

async function siteverify(fetchImpl: typeof fetch, form: URLSearchParams, signal: AbortSignal): Promise<boolean> {
  const response = await fetchImpl(SITEVERIFY_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    redirect: "error",
    signal,
  });
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    return false;
  }
  const text = await readCapped(response);
  if (text === null) return false;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return false;
  }
  return passed.safeParse(body).success;
}

/**
 * Builds the human check for run start (C5.7). The returned function POSTs
 * secret, response and, when given, remoteip as a form to Cloudflare's
 * siteverify endpoint, refusing redirects, and resolves true only when the
 * reply is a 200 whose JSON body has success === true. Everything else
 * resolves false: an empty token or one over 2,048 characters (no request is
 * made), a network error, a redirect, a non-200, a body over 64 KiB, bytes
 * that are not UTF-8 JSON, and no answer within `timeoutMs` (default 5,000).
 * The timer covers the request and the body together, so even a fetch that
 * ignores the abort signal cannot hold a run start open. The returned
 * function never throws and never logs; neither the secret nor the token
 * appears in anything it produces. Throws ServerError("SRV_BAD_INPUT") at
 * build time for an empty secret or a timeoutMs outside 1 to 30,000; that
 * message is fixed and never holds the secret.
 */
export function createTurnstileVerifier(opts: {
  secret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): (token: string, remoteIp: string | null) => Promise<boolean> {
  const { secret } = opts;
  if (typeof secret !== "string" || secret.length === 0) throw new ServerError("SRV_BAD_INPUT");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new ServerError("SRV_BAD_INPUT");
  }
  const fetchImpl: typeof fetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));

  return async (token, remoteIp) => {
    if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return false;

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
      return await Promise.race([siteverify(fetchImpl, form, controller.signal), timedOut]);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
}
