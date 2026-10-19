import { setTimeout as delay } from "node:timers/promises";
import { QlooError, type QlooErrorCode } from "./errors.js";
import { buildQlooRequest, type BuiltRequest, type QlooOperation } from "./request.js";
import { parseQlooResponse } from "./schemas.js";

export type QlooClientOptions = {
  apiKey: string;
  baseUrl: URL;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
};

export type QlooCallResult<T> = {
  data: T;
  request: { path: string; params: Array<[string, string]> };
  status: number;
  durationMs: number;
};

export type QlooClient = {
  call<T>(op: QlooOperation): Promise<QlooCallResult<T>>;
};

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 2;
const RETRY_AFTER_CAP_MS = 10_000;
const BACKOFF_MS = [500, 1500] as const;

const CODE_FOR_STATUS: Partial<Record<number, QlooErrorCode>> = {
  401: "QLOO_AUTH",
  403: "QLOO_FORBIDDEN_TYPE",
  404: "QLOO_NOT_FOUND",
  429: "QLOO_RATE_LIMIT",
};

// Qloo's own client stops at 5 MiB. A body past that is refused rather than
// buffered, so one oversized answer cannot exhaust the agent's memory (C1.4 in spirit).
const MAX_BODY_BYTES = 5 * 1024 * 1024;

const isRetryableStatus = (status: number) => status === 429 || (status >= 500 && status <= 599);

async function readBodyCapped(response: Response): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  const parts: string[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_BODY_BYTES) {
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
  const sleep = cfg.sleep ?? ((ms: number) => delay(ms));
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new QlooError("QLOO_BAD_INPUT");
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) throw new QlooError("QLOO_BAD_INPUT");

  const headers = { Accept: "application/json", "X-Api-Key": cfg.apiKey };

  // One attempt, including reading the body, under one timeout. Any failure
  // becomes a fixed code; the underlying error is dropped because undici
  // errors can quote header values.
  async function attempt(request: BuiltRequest): Promise<{ response: Response; body: string | undefined }> {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetchImpl(request.url, { method: request.method, headers, redirect: "error", signal });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { response, body: undefined };
      }
      return { response, body: await readBodyCapped(response) };
    } catch (err) {
      if (err instanceof QlooError) throw err;
      throw new QlooError(signal.aborted ? "QLOO_TIMEOUT" : "QLOO_UPSTREAM");
    }
  }

  return {
    async call<T>(op: QlooOperation): Promise<QlooCallResult<T>> {
      const request = buildQlooRequest(cfg.baseUrl, op);
      const startedAt = performance.now();

      for (let retriesUsed = 0; ; retriesUsed += 1) {
        const { response, body } = await attempt(request);

        if (body !== undefined) {
          let json: unknown;
          try {
            json = JSON.parse(body);
          } catch {
            throw new QlooError("QLOO_SCHEMA", response.status);
          }
          return {
            data: parseQlooResponse(op, json) as T,
            request: { path: request.path, params: request.params.map(([key, value]) => [key, value]) },
            status: response.status,
            durationMs: Math.round(performance.now() - startedAt),
          };
        }

        if (isRetryableStatus(response.status) && retriesUsed < maxRetries) {
          await sleep(retryDelayMs(response.headers.get("retry-after"), retriesUsed));
          continue;
        }
        throw new QlooError(CODE_FOR_STATUS[response.status] ?? "QLOO_UPSTREAM", response.status);
      }
    },
  };
}
