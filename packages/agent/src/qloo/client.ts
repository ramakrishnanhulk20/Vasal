import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { QlooError, type QlooErrorCode } from "./errors.js";
import { buildQlooRequest, type BuiltRequest, type QlooOperation } from "./request.js";
import { parseQlooResponse } from "./schemas.js";

/** The Qloo paths a raw request may name, one per method of Qloo's own harness client. */
export const RAW_QLOO_PATHS = ["/search", "/entities", "/v2/tags", "/v2/insights", "/v2/analysis/compare", "/v2/trending"] as const;
export type RawQlooPath = (typeof RAW_QLOO_PATHS)[number];

/** One request in the shape Qloo's harness asks for: a fixed path and its query as text pairs. */
export type RawQlooRequest = { path: RawQlooPath; params: ReadonlyArray<readonly [string, string]> };

/** A raw answer is any JSON object. The harness reads it field by field and checks each one itself. */
export const RawQlooBody = z.record(z.string(), z.unknown());
export type RawQlooBody = z.infer<typeof RawQlooBody>;

/** Qloo's own monthly count as one reply's headers gave it, and when that reply arrived. */
export type QlooQuota = { remaining: number; limit: number; seenAt: Date };

export type QlooClientOptions = {
  apiKey: string;
  baseUrl: URL;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onQuota?: (quota: QlooQuota) => void | Promise<void>;
};

/** Per-call settings any Qloo call path accepts. `signal` ends the call when it fires. */
export type QlooCallOptions = { signal?: AbortSignal };

export type QlooCallResult<T> = {
  data: T;
  request: { path: string; params: Array<[string, string]> };
  status: number;
  durationMs: number;
};

export type QlooClient = {
  call<T>(op: QlooOperation, options?: QlooCallOptions): Promise<QlooCallResult<T>>;
  callRaw(request: RawQlooRequest, options?: QlooCallOptions): Promise<QlooCallResult<RawQlooBody>>;
};

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 2;
const RETRY_AFTER_CAP_MS = 10_000;
const BACKOFF_MS = [500, 1500] as const;

const CODE_FOR_STATUS: Partial<Record<number, QlooErrorCode>> = {
  401: "QLOO_AUTH",
  403: "QLOO_FORBIDDEN_TYPE",
  404: "QLOO_NOT_FOUND",
  // A request timeout clears on its own like a 5xx, so it is retried.
  408: "QLOO_UPSTREAM",
  429: "QLOO_RATE_LIMIT",
};

// Qloo's own client stops at 5 MiB. A body past that is refused rather than
// buffered, so one oversized answer cannot exhaust the agent's memory (C1.4 in spirit).
const MAX_BODY_BYTES = 5 * 1024 * 1024;
// A raw answer is cached whole, so it is held to the cache's own body limit
// rather than failing at the store after the slot is spent.
const MAX_RAW_BODY_BYTES = 1_000_000;

const RAW_PATHS: ReadonlySet<string> = new Set(RAW_QLOO_PATHS);
const RAW_KEY = /^[a-z][a-z0-9_.]{0,63}$/;
const MAX_RAW_PARAMS = 20;
// Keeps the cache key, which holds the encoded query, inside the cache's
// 4,096-character key limit.
const MAX_RAW_QUERY_CHARS = 3_000;
// The same test request.ts applies: URLSearchParams would turn a lone
// surrogate into U+FFFD, so the text sent would differ from the text checked.
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

const isRetryableStatus = (status: number) => status === 408 || status === 429 || (status >= 500 && status <= 599);

// Any other 4xx says Qloo refused this request as sent, so it would fail the
// same way again. QLOO_UPSTREAM is the code the meter retries, so a 400 must
// never become it (C5.2).
function codeForStatus(status: number): QlooErrorCode {
  return CODE_FOR_STATUS[status] ?? (status >= 400 && status <= 499 ? "QLOO_BAD_INPUT" : "QLOO_UPSTREAM");
}

// Digits only, so a sign, a decimal point, an exponent or a second value
// joined by a comma all read as no count. Fifteen digits stay a safe integer.
const QUOTA_COUNT = /^[0-9]{1,15}$/;

function quotaCount(value: string | null): number | null {
  return value !== null && QUOTA_COUNT.test(value) ? Number(value) : null;
}

// Headers.get matches names case-insensitively, so any capitalisation Qloo sends is read.
function quotaOf(headers: Headers, seenAt: Date): QlooQuota | null {
  const remaining = quotaCount(headers.get("x-month-ratelimit-remaining"));
  const limit = quotaCount(headers.get("x-month-ratelimit-limit"));
  return remaining === null || limit === null ? null : { remaining, limit, seenAt };
}

/**
 * Builds the one GET request for a raw harness request. The client sends
 * exactly this request and the cache keys on exactly this `cacheKey`, so the
 * two can never disagree (C7.1). The key starts "RAW GET", a namespace of its
 * own, so a raw answer never shares an entry with a checked operation's.
 *
 * The path must be one of RAW_QLOO_PATHS and only the origin of `baseUrl` is
 * used. Every key must match /^[a-z][a-z0-9_.]{0,63}$/ and appear once, every
 * value must be non-empty text with no lone surrogate, there may be at most
 * 20 pairs, and the encoded query at most 3,000 characters. Pairs are sorted
 * by key and each value enters the query through URLSearchParams as one
 * encoded parameter (C2.3).
 *
 * Throws QlooError("QLOO_BAD_INPUT") for anything outside those rules.
 */
export function buildRawQlooRequest(baseUrl: URL, raw: RawQlooRequest): BuiltRequest {
  const bad = () => new QlooError("QLOO_BAD_INPUT");
  if (!RAW_PATHS.has(raw.path) || !Array.isArray(raw.params) || raw.params.length > MAX_RAW_PARAMS) throw bad();
  const seen = new Set<string>();
  const params: Array<[string, string]> = [];
  for (const pair of raw.params) {
    if (!Array.isArray(pair) || pair.length !== 2) throw bad();
    const [key, value] = pair;
    if (typeof key !== "string" || !RAW_KEY.test(key) || seen.has(key)) throw bad();
    if (typeof value !== "string" || value === "" || LONE_SURROGATE.test(value)) throw bad();
    seen.add(key);
    params.push([key, value]);
  }
  // Keys are unique, so ordering by key alone fixes the order. Code-unit
  // order, so the key never depends on the machine's locale.
  params.sort(([keyA], [keyB]) => (keyA < keyB ? -1 : 1));
  const query = new URLSearchParams(params).toString();
  if (query.length > MAX_RAW_QUERY_CHARS) throw bad();

  const url = new URL(raw.path, baseUrl.origin);
  url.search = query;
  return { method: "GET", url, path: raw.path, params, cacheKey: `RAW GET ${url.host}${raw.path}?${query}` };
}

async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  const parts: string[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new QlooError("QLOO_UPSTREAM");
    }
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join("");
}

function retryDelayMs(retryAfter: string | null, retryIndex: number): number {
  const backoff = BACKOFF_MS[Math.min(retryIndex, BACKOFF_MS.length - 1)] ?? BACKOFF_MS[1];
  const value = retryAfter?.trim();
  if (value === undefined || value === "") return backoff;
  if (/^\d+$/.test(value)) return Math.min(Number(value) * 1000, RETRY_AFTER_CAP_MS);
  const at = Date.parse(value);
  return Number.isNaN(at) ? backoff : Math.min(Math.max(0, at - Date.now()), RETRY_AFTER_CAP_MS);
}

/**
 * Creates the one client that talks to Qloo over HTTPS.
 *
 * Sends GET only, with the key in the X-Api-Key header and nowhere else.
 * Redirects are refused, because fetch would forward X-Api-Key to wherever a
 * redirect points. Each attempt has its own timeout (default 20 s). Only 429
 * and 5xx are retried, at most `maxRetries` times (default 2), waiting
 * Retry-After seconds when given (capped at 10 s), else 500 ms then 1500 ms.
 * A final 401 throws QLOO_AUTH, 403 QLOO_FORBIDDEN_TYPE, 404 QLOO_NOT_FOUND,
 * 429 QLOO_RATE_LIMIT, any other 4xx QLOO_BAD_INPUT (never retried, here or
 * by the meter), and any other status, 5xx included, QLOO_UPSTREAM, as does
 * a network failure.
 *
 * A call's options.signal is combined with each attempt's own timeout, so
 * whichever fires first cuts the attempt off, body read included. Once the
 * signal has fired no attempt starts, neither the first nor a retry, and the
 * wait before a retry ends at once. A call it ends throws QLOO_TIMEOUT.
 *
 * callRaw sends the request buildRawQlooRequest builds, under the same
 * headers, redirect refusal, timeout and signal, and makes exactly one
 * attempt whatever `maxRetries` says, so one metered slot is one request. Its
 * body is capped at 1,000,000 bytes and must be a JSON object. A refused
 * request throws QLOO_BAD_INPUT before anything is sent, and an answer that
 * is not a JSON object throws QLOO_SCHEMA.
 *
 * After every reply, whatever its status and whether or not its body could be
 * read, X-Month-RateLimit-Remaining and X-Month-RateLimit-Limit are read
 * (names in any case). When both are plain digits, `onQuota` gets them with
 * the time the reply arrived, and the attempt waits for it to finish before
 * it returns or throws, so a stored count is in place before the next request.
 * A missing or malformed header calls nothing. An onQuota that throws is
 * ignored. Header values are never logged.
 *
 * Throws QlooError("QLOO_KEY_MISSING") for an empty key and
 * QlooError("QLOO_BAD_INPUT") for a non-https base URL or bad limits.
 */
export function createQlooClient(cfg: QlooClientOptions): QlooClient {
  if (cfg.apiKey.trim() === "") throw new QlooError("QLOO_KEY_MISSING");
  if (cfg.baseUrl.protocol !== "https:") throw new QlooError("QLOO_BAD_INPUT");

  const fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = cfg.maxRetries ?? DEFAULT_MAX_RETRIES;
  const sleep = cfg.sleep ?? ((ms: number, signal?: AbortSignal) => (signal === undefined ? delay(ms) : delay(ms, undefined, { signal })));
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new QlooError("QLOO_BAD_INPUT");
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) throw new QlooError("QLOO_BAD_INPUT");

  const headers = { Accept: "application/json", "X-Api-Key": cfg.apiKey };
  const { onQuota } = cfg;

  async function report(quota: QlooQuota | null): Promise<void> {
    if (quota === null || onQuota === undefined) return;
    try {
      await onQuota(quota);
    } catch {
      // The reply is already paid for, so a count that failed to store must
      // not fail the call too. The next reply stores a fresh one.
    }
  }

  // One attempt, including reading the body, under its own timeout and the
  // caller's signal. Any failure becomes a fixed code; the underlying error
  // is dropped because undici errors can quote header values.
  async function attempt(
    request: BuiltRequest,
    caller: AbortSignal | undefined,
    maxBytes: number,
  ): Promise<{ response: Response; body: string | undefined }> {
    const own = AbortSignal.timeout(timeoutMs);
    const signal = caller === undefined ? own : AbortSignal.any([caller, own]);
    let quota: QlooQuota | null = null;
    try {
      const response = await fetchImpl(request.url, { method: request.method, headers, redirect: "error", signal });
      quota = quotaOf(response.headers, new Date());
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { response, body: undefined };
      }
      return { response, body: await readBodyCapped(response, maxBytes) };
    } catch (err) {
      if (err instanceof QlooError) throw err;
      throw new QlooError(signal.aborted ? "QLOO_TIMEOUT" : "QLOO_UPSTREAM");
    } finally {
      // After the body, so storing the count never eats into the attempt's timeout.
      await report(quota);
    }
  }

  async function send<T>(
    request: BuiltRequest,
    options: QlooCallOptions,
    limits: { retries: number; maxBytes: number },
    parse: (json: unknown) => T,
  ): Promise<QlooCallResult<T>> {
    const startedAt = performance.now();
    const caller = options.signal;
    const fired = () => caller?.aborted === true;

    for (let retriesUsed = 0; ; retriesUsed += 1) {
      // Checked here and not only in fetch, so an injected fetch or sleep
      // that ignores the signal still sends nothing once it has fired.
      if (fired()) throw new QlooError("QLOO_TIMEOUT");
      const { response, body } = await attempt(request, caller, limits.maxBytes);

      if (body !== undefined) {
        let json: unknown;
        try {
          json = JSON.parse(body);
        } catch {
          throw new QlooError("QLOO_SCHEMA", response.status);
        }
        return {
          data: parse(json),
          request: { path: request.path, params: request.params.map(([key, value]) => [key, value]) },
          status: response.status,
          durationMs: Math.round(performance.now() - startedAt),
        };
      }

      if (isRetryableStatus(response.status) && retriesUsed < limits.retries) {
        try {
          await sleep(retryDelayMs(response.headers.get("retry-after"), retriesUsed), caller);
        } catch {
          throw new QlooError(fired() ? "QLOO_TIMEOUT" : "QLOO_UPSTREAM");
        }
        continue;
      }
      throw new QlooError(codeForStatus(response.status), response.status);
    }
  }

  const rawBodyOf = (json: unknown): RawQlooBody => {
    const checked = RawQlooBody.safeParse(json);
    if (!checked.success) throw new QlooError("QLOO_SCHEMA");
    return checked.data;
  };

  return {
    async call<T>(op: QlooOperation, options: QlooCallOptions = {}): Promise<QlooCallResult<T>> {
      const request = buildQlooRequest(cfg.baseUrl, op);
      return send(request, options, { retries: maxRetries, maxBytes: MAX_BODY_BYTES }, (json) => parseQlooResponse(op, json) as T);
    },

    async callRaw(raw: RawQlooRequest, options: QlooCallOptions = {}): Promise<QlooCallResult<RawQlooBody>> {
      const request = buildRawQlooRequest(cfg.baseUrl, raw);
      return send(request, options, { retries: 0, maxBytes: MAX_RAW_BODY_BYTES }, rawBodyOf);
    },
  };
}
