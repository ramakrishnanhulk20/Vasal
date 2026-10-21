// Covers the /mcp door's checks before the SDK (server.ts) and its mount in
// app.ts: the Origin, Content-Type and Authorization rules, the failed-auth
// throttle, the body cap and batch refusal, the key and flag checks, the
// per-key calls in flight, the method and path rules, what reaches the SDK,
// and a full flow searched for the key. Requests go through app.request() on
// the real app and a migrated PGlite database, with a db spy that counts
// queries. It does not cover the four tools in depth (mcp-tools.test.ts), the
// result builders (mcp-results.test.ts), a real socket or edge header (the
// live smoke), or races between database connections (PGlite has one).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueToken, MCP_ENABLED_FLAG, revokeToken } from "../src/mcp/tokens.js";
import { acquireTokenInflight } from "../src/mcp/usage.js";
import type { AgentPort } from "../src/server/agent-port.js";
import { createApp } from "../src/server/app.js";
import type { ServerConfig } from "../src/server/config.js";
import { claimRunStatus, finishRun, markBriefDone, putBoard, putBrief, putCandidates, setRunStatus } from "../src/server/runs.js";
import type { Db } from "../src/store/db.js";
import { StoreError } from "../src/store/errors.js";
import { setFlag } from "../src/store/flags.js";
import { setBucket } from "../src/store/meter.js";
import { migratedPglite } from "./helpers/pglite.js";

const APP_ORIGIN = "http://localhost:3000";
const IP_HEADER = "x-test-client-ip";
const VISITOR = "203.0.113.7";
const UNKNOWN_KEY = `vsl_${"A".repeat(43)}`;
const MARKER = "MARKER-mcp-hdr";
const CONFIG: ServerConfig = {
  production: false,
  port: 8787,
  appOrigin: APP_ORIGIN,
  databaseUrl: null,
  visitorHashSecret: "v".repeat(32),
  turnstileSecret: "test-secret",
  clientIpHeader: IP_HEADER,
  runsPerVisitorPerDay: 5,
  maxInflightRuns: 3,
  anthropicApiKey: null,
  model: "claude-haiku-5-5",
  effort: "medium",
  anthropicTokensPerDay: 2_000_000,
  trends: false,
};
const PING = { jsonrpc: "2.0", id: 1, method: "ping" };

let db: Db;
let key: string;
let keyId: string;

beforeEach(async () => {
  db = await migratedPglite();
  await setFlag(db, MCP_ENABLED_FLAG, true);
  await setFlag(db, "live_runs", true);
  ({ token: key, id: keyId } = await issueToken(db));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.close();
});

function spyAgent(): AgentPort {
  return { startRun: vi.fn(async () => {}), continueRun: vi.fn(async () => {}), writeBrief: vi.fn(async () => {}) };
}

// Records every statement, so a test can say how many reads a request made.
function countingDb(inner: Db) {
  const texts: string[] = [];
  const wrap = (target: Db): Db => ({
    query: <R = Record<string, unknown>>(text: string, params?: unknown[]) => {
      texts.push(text);
      return target.query<R>(text, params);
    },
    transaction: <T>(fn: (handle: Db) => Promise<T>) => target.transaction((handle) => fn(wrap(handle))),
    close: () => target.close(),
  });
  return { db: wrap(inner), texts };
}

function build(opts: { db?: Db; config?: Partial<ServerConfig>; now?: () => Date; agent?: AgentPort } = {}) {
  return createApp({
    db: opts.db ?? db,
    config: { ...CONFIG, ...opts.config },
    verifyTurnstile: async () => true,
    agent: opts.agent ?? spyAgent(),
    socketAddress: () => null,
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });
}

async function post(app: Hono, body: unknown = PING, headers: Record<string, string | null> = {}, path = "/mcp"): Promise<Response> {
  const merged = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${key}`,
    [IP_HEADER]: VISITOR,
  });
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) merged.delete(name);
    else merged.set(name, value);
  }
  return app.request(path, { method: "POST", headers: merged, body: typeof body === "string" ? body : JSON.stringify(body) });
}

function captureConsole(): string[] {
  const lines: string[] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
  }
  return lines;
}

function sdkRequests() {
  return vi.spyOn(WebStandardStreamableHTTPServerTransport.prototype, "handleRequest");
}

async function inflightOf(id: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>("SELECT coalesce(max(n), 0)::int AS n FROM mcp_token_inflight WHERE token_id = $1::uuid", [id]);
  return rows[0]!.n;
}

describe("before the SDK sees a request", () => {
  it("answers a well-formed ping from a valid key, through a fresh transport, and gives the call in flight back", async () => {
    const seen = sdkRequests();
    const app = build();

    const res = await post(app);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(seen).toHaveBeenCalledOnce();
    expect(await inflightOf(keyId)).toBe(0);
  });

  it("refuses any Origin header with 403 before reading anything, while no Origin works (D2.6)", async () => {
    const counted = countingDb(db);
    const seen = sdkRequests();
    const app = build({ db: counted.db });

    for (const origin of ["https://evil.example", APP_ORIGIN, "null", ""]) {
      const res = await post(app, PING, { origin });
      expect(res.status, origin).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden_origin" });
    }
    expect(counted.texts).toEqual([]);
    expect(seen).not.toHaveBeenCalled();
    expect((await post(app)).status).toBe(200);
  });

  it("refuses a 17 KiB body, a lying Content-Length, a batch and text/plain, and no request reaches the SDK (D2.5)", async () => {
    const seen = sdkRequests();
    const app = build();
    const big = { ...PING, params: { _meta: { pad: "x".repeat(17 * 1024) } } };

    const tooLarge = await post(app, big);
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toEqual({ error: "too_large" });
    expect((await post(app, PING, { "content-length": "999999" })).status).toBe(413);
    const batch = await post(app, [PING, { ...PING, id: 2 }]);
    expect(batch.status).toBe(400);
    expect(await batch.json()).toEqual({ error: "batch_refused" });
    const plain = await post(app, PING, { "content-type": "text/plain" });
    expect(plain.status).toBe(415);
    expect(await plain.json()).toEqual({ error: "unsupported_media_type" });
    for (const body of ["not json", "", "￾{"]) expect((await post(app, body)).status, body).toBe(400);

    expect(seen).not.toHaveBeenCalled();
    expect(await inflightOf(keyId)).toBe(0);
  });

  it("gives 401 with WWW-Authenticate and zero database queries for every badly shaped Authorization header (D1.2)", async () => {
    const counted = countingDb(db);
    const app = build({ db: counted.db });
    const shapes: Array<string | null> = [
      null,
      `Bearer  ${key}`,
      `Basic ${key}`,
      `Bearer ${key.slice(0, -1)}`,
      `Bearer ${key} extra`,
      `Bearer ${key}, Bearer ${key}`,
      `Bearer\t${key}`,
      `Bearer VSL_${key.slice(4)}`,
      key,
    ];

    for (const authorization of shapes) {
      const res = await post(app, PING, { authorization });
      expect(res.status, String(authorization)).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    const inQuery = await post(app, PING, { authorization: null }, `/mcp?token=${key}`);
    const inCookie = await post(app, PING, { authorization: null, cookie: `token=${key}` });
    const inBody = await post(app, { ...PING, params: { token: key } }, { authorization: null });
    for (const res of [inQuery, inCookie, inBody]) expect(res.status).toBe(401);

    expect(counted.texts).toEqual([]);
  });

  it("refuses a revoked key and an expired key on the very next request (D1.3)", async () => {
    const app = build();
    expect((await post(app)).status).toBe(200);

    expect(await revokeToken(db, keyId)).toBe(true);
    expect((await post(app)).status).toBe(401);

    const fresh = await issueToken(db);
    expect((await post(app, PING, { authorization: `Bearer ${fresh.token}` })).status).toBe(200);
    await db.query("UPDATE mcp_tokens SET created_at = now() - interval '31 days', expires_at = now() - interval '1 day' WHERE id = $1::uuid", [fresh.id]);
    expect((await post(app, PING, { authorization: `Bearer ${fresh.token}` })).status).toBe(401);
  });

  it("answers 429 to the 21st failed key from one address in a minute, at no database cost, and only for that address (D3.8)", async () => {
    let clock = new Date("2026-10-20T12:00:00.000Z");
    const counted = countingDb(db);
    const app = build({ db: counted.db, now: () => clock });

    for (let i = 0; i < 20; i += 1) {
      const before = counted.texts.length;
      expect((await post(app, PING, { authorization: `Bearer ${UNKNOWN_KEY}` })).status).toBe(401);
      expect(counted.texts.slice(before)).toHaveLength(1);
      expect(counted.texts.slice(before)[0]).toMatch(/^SELECT/);
    }
    const before = counted.texts.length;
    const throttled = await post(app, PING, { authorization: `Bearer ${UNKNOWN_KEY}` });
    expect(throttled.status).toBe(429);
    expect(await throttled.json()).toEqual({ error: "too_many_failures" });
    expect((await post(app)).status).toBe(429);
    expect(counted.texts.slice(before)).toEqual([]);

    expect((await post(app, PING, { authorization: `Bearer ${UNKNOWN_KEY}`, [IP_HEADER]: "203.0.113.8" })).status).toBe(401);
    expect((await post(app, PING, { [IP_HEADER]: "203.0.113.8" })).status).toBe(200);

    clock = new Date(clock.getTime() + 60_000);
    expect((await post(app)).status).toBe(200);
  });

  it("counts badly shaped headers too, and with no client-address header configured every failure shares one count", async () => {
    const app = build({ config: { clientIpHeader: null } });
    for (let i = 0; i < 20; i += 1) {
      expect((await post(app, PING, { authorization: "Basic x", [IP_HEADER]: `198.51.100.${i}` })).status).toBe(401);
    }
    expect((await post(app, PING, { [IP_HEADER]: "192.0.2.99" })).status).toBe(429);
  });

  it("answers 503 mcp_off to a valid key when the flag is off, missing or unreadable (D1.6, C5.7)", async () => {
    const seen = sdkRequests();
    await setFlag(db, MCP_ENABLED_FLAG, false);
    const off = await post(build());
    expect(off.status).toBe(503);
    expect(await off.json()).toEqual({ error: "mcp_off" });

    await db.query("DELETE FROM app_flags WHERE name = $1", [MCP_ENABLED_FLAG]);
    expect((await post(build())).status).toBe(503);

    await setFlag(db, MCP_ENABLED_FLAG, true);
    const flagFails: Db = {
      query: (text, params) => (text.includes("app_flags") ? Promise.reject(new StoreError("STORE_UNAVAILABLE")) : db.query(text, params)),
      transaction: (fn) => db.transaction(fn),
      close: async () => {},
    };
    expect((await post(build({ db: flagFails }))).status).toBe(503);
    expect(seen).not.toHaveBeenCalled();
  });

  it("answers 429 busy when the key already has 3 calls in flight, and a database failure is 503 unavailable (D3.6)", async () => {
    for (let i = 0; i < 3; i += 1) expect(await acquireTokenInflight(db, keyId, 3)).toBe(true);
    const busy = await post(build());
    expect(busy.status).toBe(429);
    expect(await busy.json()).toEqual({ error: "busy" });
    expect(await inflightOf(keyId)).toBe(3);

    const broken: Db = {
      query: (text, params) => (text.includes("mcp_tokens") ? Promise.reject(new StoreError("STORE_UNAVAILABLE")) : db.query(text, params)),
      transaction: (fn) => db.transaction(fn),
      close: async () => {},
    };
    const down = await post(build({ db: broken }));
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ error: "unavailable" });
  });

  it("serves only POST: GET, DELETE, PUT, HEAD and OPTIONS get 405 with Allow: POST (D2.2, D2.5)", async () => {
    const seen = sdkRequests();
    const app = build();
    for (const method of ["GET", "DELETE", "PUT", "PATCH", "HEAD", "OPTIONS"]) {
      const res = await app.request("/mcp", { method, headers: { authorization: `Bearer ${key}`, accept: "text/event-stream" } });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
    expect(seen).not.toHaveBeenCalled();
  });

  it("gives the SDK only Accept, Content-Type and MCP-Protocol-Version, so no key or planted header reaches a handler (D1.4)", async () => {
    const seen = sdkRequests();
    const app = build();

    const res = await post(app, PING, { "x-planted": MARKER, cookie: `c=${MARKER}`, "x-forwarded-host": "evil.example", "mcp-protocol-version": "2025-06-18" });

    expect(res.status).toBe(200);
    const request = seen.mock.calls[0]?.[0] as Request;
    expect([...request.headers.keys()].sort()).toEqual(["accept", "content-type", "mcp-protocol-version"]);
    expect(JSON.stringify([...request.headers])).not.toContain("vsl_");
    expect(request.url).toBe("http://vasal.invalid/mcp");
    const options = seen.mock.calls[0]?.[1];
    expect(options?.authInfo).toEqual({ token: "agent-key", clientId: keyId, scopes: [] });
  });

  it("answers resources/list and prompts/list with method-not-found (D2.4)", async () => {
    const app = build();
    for (const method of ["resources/list", "prompts/list", "sampling/createMessage", "logging/setLevel"]) {
      const res = await post(app, { jsonrpc: "2.0", id: 7, method, params: {} });
      expect(await res.json(), method).toEqual({ jsonrpc: "2.0", id: 7, error: { code: -32601, message: "Method not found" } });
    }
  });

  it("logs each refusal as one fixed line holding only the level, the route and a code, never the key", async () => {
    const lines = captureConsole();
    const app = build();
    await post(app, PING, { origin: "https://evil.example" });
    await post(app, PING, { authorization: `Bearer ${UNKNOWN_KEY}` });
    await post(app, [PING]);

    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { level: "warn", route: "/mcp", code: "forbidden_origin" },
      { level: "warn", route: "/mcp", code: "unauthorized" },
      { level: "warn", route: "/mcp", code: "batch_refused" },
    ]);
    expect(lines.join("\n")).not.toContain("vsl_");
  });
});

describe("the mount in app.ts (D2.6, D2.7)", () => {
  it("sends no CORS header on /mcp, not even to the app's own origin, while the website keeps its own Origin rule", async () => {
    const app = build();

    const preflight = await app.request("/mcp", { method: "OPTIONS", headers: { origin: APP_ORIGIN, "access-control-request-method": "POST" } });
    expect(preflight.status).toBe(405);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    const answered = await post(app);
    expect(answered.headers.get("access-control-allow-origin")).toBeNull();
    expect(answered.headers.get("x-content-type-options")).toBe("nosniff");

    const websiteNoOrigin = await app.request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json", [IP_HEADER]: VISITOR },
      body: JSON.stringify({ show: "SmartLess", turnstileToken: "tok" }),
    });
    expect(websiteNoOrigin.status).toBe(403);
    expect(await websiteNoOrigin.json()).toEqual({ error: "FORBIDDEN_ORIGIN" });
    const sitePreflight = await app.request("/runs", { method: "OPTIONS", headers: { origin: APP_ORIGIN, "access-control-request-method": "POST" } });
    expect(sitePreflight.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
  });

  it("answers an agent key only on the exact /mcp route the router matched", async () => {
    const lines = captureConsole();
    const seen = sdkRequests();
    const app = build();

    for (const path of ["/MCP", "/mcp/", "/mcpx", "/mcp/x", "//mcp"]) {
      const res = await post(app, PING, {}, path);
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual({ error: "NOT_FOUND" });
    }
    // The URL parser turns this into /runs, the website's own route, which
    // refuses it under the website's rules.
    const dotted = await post(app, PING, {}, "/mcp/../runs");
    expect(dotted.status).toBe(403);
    expect(await dotted.json()).toEqual({ error: "FORBIDDEN_ORIGIN" });
    expect(seen).not.toHaveBeenCalled();
    expect(lines.filter((line) => line.includes('"/mcp"'))).toEqual([]);

    // A percent-encoded letter decodes to /mcp itself, which still demands a key.
    const encoded = await post(app, PING, { authorization: null }, "/%6Dcp");
    expect(encoded.status).toBe(401);
    expect(await encoded.json()).toEqual({ error: "unauthorized" });
    expect(seen).not.toHaveBeenCalled();
  });
});

describe("a full MCP flow, searched for the key (D1.4)", () => {
  const candidateRow = (n: number) => ({
    appleId: String(1000 + n),
    name: `Synthetic Show ${n}`,
    publisher: "Synthetic Publisher",
    feedHandleSource: "directory",
    feedUrl: `https://feeds.example/show-${n}.xml`,
    qlooId: `qloo-show-000${n}`,
    qlooName: `Synthetic Show ${n}`,
  });
  const boardRow = (n: number) => ({
    personId: `qloo-person-000${n}`,
    name: `Synthetic Person ${n}`,
    fit: 0.5,
    fitKnown: true,
    fitRank: n,
    reach: "bookable",
    rising: { state: "steady", points: null },
    bringsNew: null,
    sharedTags: [],
    angle: "Their fans already love long conversations.",
    showName: "Synthetic Show 1",
  });
  const storeAgent: AgentPort = {
    startRun: async (runId) => {
      await setRunStatus(db, runId, "running");
      await putCandidates(db, runId, [candidateRow(1)]);
      await claimRunStatus(db, runId, "running", "awaiting_confirm");
    },
    continueRun: async (runId) => {
      await putBoard(db, runId, [1, 2, 3].map(boardRow));
      await finishRun(db, runId, "done", { name: "done", data: { guests: 3 } });
    },
    writeBrief: async (runId, guestId) => {
      const brief = { why: "w", angle: "a", questions: ["q?"], pitch_subject: "s", pitch_body: "b", removed: { links: 0, emails: 0 } };
      await putBrief(db, runId, guestId, brief);
      await markBriefDone(db, runId, guestId);
    },
  };

  async function everyRow(): Promise<string> {
    const { rows: tables } = await db.query<{ t: string }>(
      "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
    );
    const dump: string[] = [];
    for (const { t } of tables) {
      const { rows } = await db.query<{ j: string }>(`SELECT row_to_json(x)::text AS j FROM "${t}" x`);
      dump.push(...rows.map((row) => row.j));
    }
    return dump.join("\n");
  }

  it("leaves no vsl_ in any row, log line or answer but the key-issue reply, and hands handlers only the key row id", async () => {
    await setBucket(db, { key: "mcp:keys:day", cap: 10, windowEnd: new Date("2099-01-01T00:00:00.000Z") });
    const lines = captureConsole();
    const handlerSaw: Array<{ headers: Record<string, string> | undefined; authInfo: unknown }> = [];
    const register = McpServer.prototype.registerTool;
    vi.spyOn(McpServer.prototype, "registerTool").mockImplementation(function (this: McpServer, ...args: unknown[]) {
      const [name, config, handler] = args as [string, object, (input: unknown, extra: unknown) => unknown];
      const watched = (input: unknown, extra: { requestInfo?: { headers: Record<string, string> }; authInfo?: unknown }) => {
        handlerSaw.push({ headers: extra.requestInfo?.headers, authInfo: extra.authInfo });
        return handler(input, extra);
      };
      return (register as (...all: unknown[]) => ReturnType<McpServer["registerTool"]>).call(this, name, config, watched);
    });
    const app = build({ agent: storeAgent });

    const issued = await app.request("/agent-keys", {
      method: "POST",
      headers: { origin: APP_ORIGIN, "content-type": "application/json", [IP_HEADER]: VISITOR },
      body: JSON.stringify({ turnstileToken: "tok" }),
    });
    const { token: fresh } = (await issued.json()) as { token: string };
    expect(fresh.startsWith("vsl_")).toBe(true);

    const answers: string[] = [];
    let id = 0;
    const send = async (method: string, params?: unknown): Promise<Record<string, unknown>> => {
      id += 1;
      const body = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
      const res = await post(app, body, { authorization: `Bearer ${fresh}`, "x-planted": MARKER });
      const text = await res.text();
      answers.push(text, JSON.stringify([...res.headers]));
      return (JSON.parse(text) as { result: Record<string, unknown> }).result;
    };
    await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "flow", version: "1" } });
    await send("tools/list");
    const show = (await send("tools/call", { name: "find_show", arguments: { query: "SmartLess" } }))["structuredContent"] as {
      candidates: Array<{ candidateId: string }>;
    };
    const candidateId = show.candidates[0]!.candidateId;
    const board = (await send("tools/call", { name: "book_guests", arguments: { candidateId } }))["structuredContent"] as {
      runId: string;
      guests: Array<{ guestId: string }>;
    };
    await send("tools/call", { name: "get_board", arguments: { runId: board.runId } });
    const guestId = board.guests[0]!.guestId;
    const brief = (await send("tools/call", { name: "write_brief", arguments: { runId: board.runId, guestId } }))["structuredContent"];
    expect(brief).toMatchObject({ status: "done" });

    expect(await everyRow()).not.toContain("vsl_");
    expect(lines.join("\n")).not.toContain("vsl_");
    expect(answers.join("\n")).not.toContain("vsl_");
    expect(handlerSaw).toHaveLength(4);
    const { rows } = await db.query<{ id: string }>("SELECT id::text AS id FROM mcp_tokens WHERE id <> $1::uuid", [keyId]);
    for (const saw of handlerSaw) {
      expect(Object.keys(saw.headers ?? {}).sort()).toEqual(["accept", "content-type"]);
      expect(JSON.stringify(saw.headers)).not.toContain(MARKER);
      expect(saw.authInfo).toEqual({ token: "agent-key", clientId: rows[0]!.id, scopes: [] });
    }
  });
});
