// Checks a running agent server from the outside, the way a visitor, another
// website or an agent would reach it: every public door must answer as
// designed. It holds no secret and sends none, and it makes no Qloo or model
// call: the requests that could start a run or issue an agent key carry a
// dummy human-check token, which a real Turnstile secret refuses before
// anything is spent.
//
// Usage: npm run prove -- --remote <url> [--origin https://vasal.site] [--allow-empty-showcase]
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { RUN_EVENTS } from "../src/server/sse.js";

export type Outcome = "PASS" | "FAIL" | "SKIP" | "WARN";
export type CheckLine = { outcome: Outcome; name: string; reason: string };
export type ProveOptions = {
  base: URL;
  origin: string;
  allowEmptyShowcase: boolean;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  streamTimeoutMs?: number;
};

const USAGE = "Usage: npm run prove -- --remote <url> [--origin https://vasal.site] [--allow-empty-showcase]";
const DEFAULT_ORIGIN = "https://vasal.site";
const FOREIGN_ORIGIN = "https://evil.example";
// Cloudflare's documented dummy token. A real secret refuses it, so the run
// start below stops at the human check.
const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
const COMMA_ADDRESS = "192.0.2.1, 198.51.100.2";
const BAD_ADDRESS = "not-an-address";
const MAX_BODY_CHARS = 1_000_000;
const EVENT_NAMES: readonly string[] = RUN_EVENTS;
// A refusal code is shown only when it has the server's own shape, so text
// from an unexpected server cannot reach the terminal (C3.6).
const CODE_SHAPE = /^[A-Za-z_]{1,40}$/;

type Answer = { status: number; headers: Headers; body: unknown; ms: number };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function codeOf(body: unknown): string {
  const code = isObject(body) ? body["error"] : undefined;
  return typeof code === "string" && CODE_SHAPE.test(code) ? code : "no error code";
}

function ringCount(kolam: unknown): number {
  if (!isObject(kolam) || !Array.isArray(kolam["rings"])) return 0;
  return kolam["rings"].length;
}

/**
 * Runs every check against `base` in a fixed order and returns one line per
 * check: PASS, FAIL, SKIP or WARN with a short reason. Each request has its
 * own timeout (default 10 s) and the event stream is read for at most
 * `streamTimeoutMs` (default 15 s). A network failure is a FAIL with a fixed
 * reason; no response text reaches a reason except an error code of the
 * server's own shape. Never throws.
 */
export async function prove(opts: ProveOptions): Promise<CheckLine[]> {
  const fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
  const streamTimeoutMs = opts.streamTimeoutMs ?? 15_000;
  const lines: CheckLine[] = [];
  const add = (outcome: Outcome, name: string, reason: string) => lines.push({ outcome, name, reason });

  // Relative to the base, so a server mounted under a path prefix still works.
  const urlOf = (path: string) => new URL(path.replace(/^\//, ""), opts.base);
  const ask = async (path: string, init: RequestInit = {}): Promise<Answer | null> => {
    const started = performance.now();
    try {
      const response = await fetchImpl(urlOf(path), {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      const text = await response.text();
      let body: unknown = null;
      if (text.length <= MAX_BODY_CHARS) {
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
      }
      return { status: response.status, headers: response.headers, body, ms: Math.round(performance.now() - started) };
    } catch {
      return null;
    }
  };
  const noAnswer = (name: string) => add("FAIL", name, `no answer within ${requestTimeoutMs / 1_000} s, or the connection failed`);
  const postJson = (path: string, body: unknown, headers: Record<string, string>) =>
    ask(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  const health = await ask("/health");
  if (health === null) noAnswer("health");
  else if (health.status === 200 && isObject(health.body) && health.body["ok"] === true) add("PASS", "health", `200 with ok true in ${health.ms} ms`);
  else add("FAIL", "health", `${health.status}, expected 200 with ok true`);

  let runId: string | null = null;
  const showcase = await ask("/showcase");
  if (showcase === null) noAnswer("showcase");
  else if (showcase.status !== 200 || !isObject(showcase.body) || !Array.isArray(showcase.body["runs"])) {
    add("FAIL", "showcase", `${showcase.status}, expected 200 with a runs list`);
  } else {
    const runs: unknown[] = showcase.body["runs"];
    const broken = runs.findIndex((run) => {
      if (!isObject(run) || typeof run["runId"] !== "string" || !Array.isArray(run["guests"]) || run["guests"].length === 0) return true;
      const guests: unknown[] = run["guests"];
      if (!guests.every((guest) => isObject(guest) && Array.isArray(guest["sharedTags"]))) return true;
      const tags = guests.reduce<number>((sum, guest) => sum + ((guest as { sharedTags: unknown[] }).sharedTags.length), 0);
      return tags === 0 || ringCount(run["kolam"]) === 0;
    });
    if (runs.length === 0) {
      if (opts.allowEmptyShowcase) add("SKIP", "showcase", "200 with no promoted runs, allowed by --allow-empty-showcase");
      else add("FAIL", "showcase", "200 with no promoted runs; promote one with the ops promote command");
    } else if (broken !== -1) {
      add("FAIL", "showcase", `run ${broken + 1} of ${runs.length} lacks guests, shared tags or a kolam with rings`);
    } else {
      const first = runs[0] as { runId: string; guests: Array<{ sharedTags: unknown[] }>; kolam: unknown };
      runId = first.runId;
      const tags = first.guests.reduce((sum, guest) => sum + guest.sharedTags.length, 0);
      add("PASS", "showcase", `${runs.length} promoted; the first has ${first.guests.length} guests, ${tags} shared tags and a kolam with ${ringCount(first.kolam)} rings`);
    }
  }

  if (runId === null) {
    add("SKIP", "run", "no showcase run to read");
    add("SKIP", "events", "no showcase run to stream");
  } else {
    const run = await ask(`/runs/${encodeURIComponent(runId)}`);
    if (run === null) noAnswer("run");
    else if (
      run.status === 200 &&
      isObject(run.body) &&
      run.body["status"] === "done" &&
      Array.isArray(run.body["board"]) &&
      run.body["board"].length > 0 &&
      ringCount(run.body["kolam"]) > 0
    ) {
      add("PASS", "run", `done, with ${(run.body["board"] as unknown[]).length} guests on the board and a kolam`);
    } else add("FAIL", "run", `${run.status}, expected a done run with a board and a kolam`);
    lines.push(await streamCheck(fetchImpl, urlOf(`/runs/${encodeURIComponent(runId)}/events`), streamTimeoutMs));
  }

  const startBody = { show: "Prove probe", turnstileToken: DUMMY_TOKEN };
  const foreignRun = await postJson("/runs", startBody, { origin: FOREIGN_ORIGIN });
  if (foreignRun === null) noAnswer("runs from a foreign site");
  else if (foreignRun.status === 403 && codeOf(foreignRun.body) === "FORBIDDEN_ORIGIN") add("PASS", "runs from a foreign site", "403 FORBIDDEN_ORIGIN");
  else add("FAIL", "runs from a foreign site", `${foreignRun.status} ${codeOf(foreignRun.body)}, expected 403 FORBIDDEN_ORIGIN`);

  const foreignKey = await postJson("/agent-keys", { turnstileToken: DUMMY_TOKEN }, { origin: FOREIGN_ORIGIN });
  if (foreignKey === null) noAnswer("agent keys from a foreign site");
  else if (foreignKey.status === 403 && codeOf(foreignKey.body) === "FORBIDDEN_ORIGIN") add("PASS", "agent keys from a foreign site", "403 FORBIDDEN_ORIGIN");
  else add("FAIL", "agent keys from a foreign site", `${foreignKey.status} ${codeOf(foreignKey.body)}, expected 403 FORBIDDEN_ORIGIN`);

  const mcpNoKey = await postJson("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, {});
  if (mcpNoKey === null) noAnswer("mcp without a key");
  else if (mcpNoKey.status === 401 && /^Bearer\b/i.test(mcpNoKey.headers.get("www-authenticate") ?? "")) {
    add("PASS", "mcp without a key", "401 with WWW-Authenticate: Bearer");
  } else add("FAIL", "mcp without a key", `${mcpNoKey.status}, expected 401 with WWW-Authenticate: Bearer`);

  const mcpGet = await ask("/mcp");
  if (mcpGet === null) noAnswer("mcp by GET");
  else if (mcpGet.status === 405) add("PASS", "mcp by GET", "405");
  else add("FAIL", "mcp by GET", `${mcpGet.status}, expected 405`);

  const preflight = await ask("/mcp", {
    method: "OPTIONS",
    headers: { origin: opts.origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type, authorization" },
  });
  if (preflight === null) noAnswer("mcp preflight");
  else if (preflight.headers.get("access-control-allow-origin") === null) add("PASS", "mcp preflight", `${preflight.status} with no Access-Control-Allow-Origin`);
  else add("FAIL", "mcp preflight", `${preflight.status} with an Access-Control-Allow-Origin header, so a browser page could call /mcp`);

  const unknownPath = await ask(`/nope-${randomUUID()}`);
  if (unknownPath === null) noAnswer("unknown path");
  else if (unknownPath.status === 404) add("PASS", "unknown path", "404");
  else add("FAIL", "unknown path", `${unknownPath.status}, expected 404`);

  const probe = await postJson("/runs", startBody, { origin: opts.origin, "x-real-ip": COMMA_ADDRESS });
  const name = "X-Real-IP comma probe";
  if (probe === null) noAnswer(name);
  else {
    const code = codeOf(probe.body);
    if (probe.status === 403 && code === "HUMAN_CHECK_FAILED") {
      add("PASS", name, "partial: 403 HUMAN_CHECK_FAILED, so the edge replaced the header with one address and the dummy token was refused before any spend");
    } else if (probe.status === 400 && code === "NO_CLIENT_ADDRESS") {
      add("WARN", name, "400 NO_CLIENT_ADDRESS: the comma list reached the server, so the edge passed a client-written X-Real-IP through. Check CLIENT_IP_HEADER");
    } else if (probe.status === 503 && code === "LIVE_RUNS_OFF") {
      add("SKIP", name, "503 LIVE_RUNS_OFF, so the header was not tested");
    } else if (probe.status === 403 && code === "FORBIDDEN_ORIGIN") {
      add("FAIL", name, "403 FORBIDDEN_ORIGIN: --origin is not the server's APP_ORIGIN, so the header was not tested");
    } else if (probe.status === 202 || probe.status === 429) {
      add("FAIL", name, `${probe.status}: the dummy token passed the human check, so a run could start with no human`);
    } else add("FAIL", name, `${probe.status} ${code}, expected 403 HUMAN_CHECK_FAILED`);
  }

  // The key route reads the address before the human check and does not
  // depend on live runs, so this tests the edge on every run while MCP is on.
  const keyProbe = await postJson("/agent-keys", { turnstileToken: DUMMY_TOKEN }, { origin: opts.origin, "x-real-ip": BAD_ADDRESS });
  const keyName = "X-Real-IP agent-key probe";
  if (keyProbe === null) noAnswer(keyName);
  else {
    const code = codeOf(keyProbe.body);
    if (keyProbe.status === 403 && code === "HUMAN_CHECK_FAILED") {
      add("PASS", keyName, "403 HUMAN_CHECK_FAILED: the edge replaced a client-written X-Real-IP, and the dummy token was refused before any key was issued");
    } else if (keyProbe.status === 400 && code === "NO_CLIENT_ADDRESS") {
      add("FAIL", keyName, "400 NO_CLIENT_ADDRESS: a client-written X-Real-IP reached the server, so a caller can choose the address it is counted under. Check the edge and CLIENT_IP_HEADER");
    } else if (keyProbe.status === 503 && code === "MCP_OFF") {
      add("SKIP", keyName, "503 MCP_OFF, so the header was not tested");
    } else if (keyProbe.status === 201) {
      add("FAIL", keyName, "201: the dummy token passed the human check, so an agent key was issued with no human");
    } else add("FAIL", keyName, `${keyProbe.status} ${code}, expected 403 HUMAN_CHECK_FAILED`);
  }

  return lines;
}

/** The process exit code for a set of check lines: 1 when any check failed, otherwise 0. */
export function exitCodeFor(lines: readonly CheckLine[]): number {
  return lines.some((line) => line.outcome === "FAIL") ? 1 : 0;
}

// A frame is the id, event and data lines a formatSseFrame call writes. A
// comment frame (a ping) is skipped and does not count as the first frame.
function parseFrame(block: string): { ok: boolean; event: string } | null {
  const lines = block.split("\n");
  if (lines.every((line) => line.startsWith(":"))) return null;
  const field = (name: string) => lines.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
  const id = field("id");
  const event = field("event") ?? "";
  const data = field("data");
  let parsed = data !== undefined;
  try {
    if (data !== undefined) JSON.parse(data);
  } catch {
    parsed = false;
  }
  return { ok: id !== undefined && /^[0-9]{1,16}$/.test(id) && EVENT_NAMES.includes(event) && parsed, event };
}

async function streamCheck(fetchImpl: typeof fetch, url: URL, timeoutMs: number): Promise<CheckLine> {
  const name = "events";
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let firstMs: number | null = null;
  let frames = 0;
  let last = "";
  try {
    const response = await fetchImpl(url, { headers: { accept: "text/event-stream" }, redirect: "manual", signal: controller.signal });
    if (response.status !== 200 || !(response.headers.get("content-type") ?? "").startsWith("text/event-stream") || response.body === null) {
      await response.body?.cancel().catch(() => {});
      return { outcome: "FAIL", name, reason: `${response.status}, expected 200 text/event-stream` };
    }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value.replace(/\r\n?/g, "\n");
      let end = buffer.indexOf("\n\n");
      while (end !== -1) {
        const frame = parseFrame(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf("\n\n");
        if (frame === null) continue;
        if (!frame.ok) {
          await reader.cancel().catch(() => {});
          return { outcome: "FAIL", name, reason: `frame ${frames + 1} did not parse as id, a known event and JSON data` };
        }
        firstMs ??= Math.round(performance.now() - started);
        frames += 1;
        last = frame.event;
      }
      if (last === "done" || last === "failed") {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } catch {
    if (frames === 0) return { outcome: "FAIL", name, reason: `no frame within ${timeoutMs / 1_000} s, or the connection failed` };
  } finally {
    clearTimeout(timer);
  }
  if (frames === 0 || firstMs === null) return { outcome: "FAIL", name, reason: "the stream ended with no frame" };
  const ending = last === "done" || last === "failed" ? `, ending with ${last}` : "";
  return { outcome: "PASS", name, reason: `first frame in ${firstMs} ms, ${frames} ${frames === 1 ? "frame" : "frames"} parsed${ending}` };
}

function originFrom(text: string): string | null {
  const url = URL.parse(text);
  return url !== null && (url.protocol === "https:" || url.protocol === "http:") ? url.origin : null;
}

async function main(): Promise<number> {
  let values: { remote?: string | undefined; origin?: string | undefined; "allow-empty-showcase"?: boolean | undefined };
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: { remote: { type: "string" }, origin: { type: "string" }, "allow-empty-showcase": { type: "boolean", default: false } },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    console.error(USAGE);
    return 2;
  }
  const remote = values.remote === undefined ? null : URL.parse(values.remote);
  const origin = originFrom(values.origin ?? DEFAULT_ORIGIN);
  if (remote === null || (remote.protocol !== "https:" && remote.protocol !== "http:") || origin === null) {
    console.error(USAGE);
    return 2;
  }
  const base = new URL(remote.pathname.endsWith("/") ? remote.href : `${remote.href}/`);
  console.log(`Proving ${base.origin} as the site ${origin} would reach it.`);
  const lines = await prove({ base, origin, allowEmptyShowcase: values["allow-empty-showcase"] === true });
  for (const line of lines) console.log(`${line.outcome.padEnd(4)}  ${line.name}: ${line.reason}`);
  const count = (outcome: Outcome) => lines.filter((line) => line.outcome === outcome).length;
  console.log(`${count("PASS")} passed, ${count("FAIL")} failed, ${count("SKIP")} skipped, ${count("WARN")} warned.`);
  return exitCodeFor(lines);
}

if (import.meta.main) process.exitCode = await main();
