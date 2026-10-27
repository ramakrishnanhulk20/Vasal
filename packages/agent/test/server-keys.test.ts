// Covers POST /agent-keys through app.request() on a migrated PGlite
// database, with a stub human check and, where the hostname and action
// matter, the real verifier on a fake siteverify. It does not cover the real
// Turnstile call or a real socket (the live dev smoke does), Cloudflare
// refusing a replayed answer (siteverify's own job), races between separate
// database connections (PGlite has one), or the MCP route that will accept
// these keys (the next work order).
import { createHash } from "node:crypto";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticateToken, MCP_ENABLED_FLAG, TOKEN_PATTERN } from "../src/mcp/tokens.js";
import { createUnavailableAgent } from "../src/server/agent-port.js";
import { createApp, type AppDeps } from "../src/server/app.js";
import type { ServerConfig } from "../src/server/config.js";
import { createTurnstileVerifier, TURNSTILE_ACTIONS } from "../src/server/turnstile.js";
import type { Db } from "../src/store/db.js";
import { StoreError } from "../src/store/errors.js";
import { setFlag } from "../src/store/flags.js";
import { setBucket, usage } from "../src/store/meter.js";
import { migratedPglite } from "./helpers/pglite.js";

const APP_ORIGIN = "http://localhost:3000";
const IP_HEADER = "x-test-client-ip";
const VISITOR = "203.0.113.7";
const MARKER = "MARKER-k3y5";
const FAR_FUTURE = new Date("2099-01-01T00:00:00.000Z");
const CONFIG: ServerConfig = {
  production: false,
  port: 8787,
  appOrigin: APP_ORIGIN,
  databaseUrl: null,
  databaseNetwork: null,
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

let db: Db;

beforeEach(async () => {
  db = await migratedPglite();
  await setFlag(db, MCP_ENABLED_FLAG, true);
  await setBucket(db, { key: "mcp:keys:day", cap: 50, windowEnd: FAR_FUTURE });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.close();
});

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function build(opts: { verify?: AppDeps["verifyTurnstile"]; db?: Db; config?: Partial<ServerConfig> } = {}) {
  const verify = vi.fn<AppDeps["verifyTurnstile"]>(opts.verify ?? (async () => true));
  const target = opts.db ?? db;
  const app = createApp({
    db: target,
    config: { ...CONFIG, ...opts.config },
    verifyTurnstile: verify,
    agent: createUnavailableAgent(target),
    socketAddress: () => null,
  });
  return { app, verify };
}

async function ask(
  app: Hono,
  body: unknown = { turnstileToken: "tok" },
  headers: Record<string, string | null> = {},
  path = "/agent-keys",
): Promise<Response> {
  const merged = new Headers({ origin: APP_ORIGIN, "content-type": "application/json", [IP_HEADER]: VISITOR });
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) merged.delete(name);
    else merged.set(name, value);
  }
  return app.request(path, { method: "POST", headers: merged, body: typeof body === "string" ? body : JSON.stringify(body) });
}

// Everything an issue could write, so "issued nothing and counted nothing" is one comparison.
async function snapshot(): Promise<string> {
  const queries = [
    "SELECT count(*)::int AS n FROM mcp_tokens",
    "SELECT visitor_hash, day::text AS day, n FROM mcp_key_issue ORDER BY visitor_hash",
    "SELECT key, cap, used FROM usage_buckets ORDER BY key",
    "SELECT count(*)::int AS n FROM runs",
  ];
  const results = [];
  for (const text of queries) results.push((await db.query(text)).rows);
  return JSON.stringify(results);
}

async function tokenRows(): Promise<number> {
  const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM mcp_tokens");
  return rows[0]!.n;
}

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

function captureConsole(): string[] {
  const lines: string[] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
  }
  return lines;
}

describe("POST /agent-keys", () => {
  it("issues one working key to a checked visitor, once, with no-store, asking siteverify for the agent-key action", async () => {
    const { app, verify } = build();

    const res = await ask(app);

    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { token: string; expiresAt: string };
    expect(Object.keys(body).sort()).toEqual(["expiresAt", "token"]);
    expect(body.token).toMatch(TOKEN_PATTERN);
    expect(verify).toHaveBeenCalledExactlyOnceWith("tok", VISITOR, TURNSTILE_ACTIONS.agentKey);
    const issued = await authenticateToken(db, body.token);
    expect(issued).not.toBeNull();
    const { rows } = await db.query<{ expires: Date }>("SELECT expires_at AS expires FROM mcp_tokens WHERE id = $1::uuid", [issued!.id]);
    expect(body.expiresAt).toBe(new Date(rows[0]!.expires).toISOString());
    expect((await usage(db, "mcp:keys:day"))?.used).toBe(1);
  });

  it("stores only the key's hash, and no row, response header or log line holds the key (D1.1, D1.4)", async () => {
    const lines = captureConsole();
    const { app } = build();

    const res = await ask(app);
    const { token } = (await res.json()) as { token: string };
    await ask(app, { turnstileToken: "tok", extra: true });

    const dump = await everyRow();
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(token.slice(4));
    expect(dump).toContain(sha256(token));
    expect(JSON.stringify([...res.headers])).not.toContain(token);
    expect(lines.join("\n")).not.toContain("vsl_");
  });

  it("refuses another origin, a missing Origin and non-JSON content types before reading the body (C5.5)", async () => {
    const { app, verify } = build();
    const before = await snapshot();

    for (const headers of [{ origin: "https://evil.example" }, { origin: null }, { "content-type": "text/plain" }, { origin: "null" }]) {
      const res = await ask(app, { turnstileToken: "tok" }, headers);
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(await res.json()).toEqual({ error: "FORBIDDEN_ORIGIN" });
    }
    expect(verify).not.toHaveBeenCalled();
    expect(await snapshot()).toBe(before);
  });

  it("caps the body at 4 KiB and accepts only { turnstileToken }", async () => {
    const { app, verify } = build();
    const before = await snapshot();

    const big = await ask(app, { turnstileToken: "t".repeat(4 * 1024) });
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: "TOO_LARGE" });
    for (const body of ["not json", { turnstileToken: "" }, { turnstileToken: "tok", visitor: "1.2.3.4" }, {}, [], { turnstileToken: 5 }]) {
      const res = await ask(app, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ error: "BAD_INPUT" });
    }
    expect(verify).not.toHaveBeenCalled();
    expect(await snapshot()).toBe(before);
  });

  it("answers 503 MCP_OFF when the flag is off, missing or unreadable, before the human check (D1.6, C5.7)", async () => {
    await setFlag(db, MCP_ENABLED_FLAG, false);
    const { app, verify } = build();
    const before = await snapshot();
    expect(await (await ask(app)).json()).toEqual({ error: "MCP_OFF" });

    await db.query("DELETE FROM app_flags WHERE name = $1", [MCP_ENABLED_FLAG]);
    const missing = await ask(app);
    expect(missing.status).toBe(503);

    await setFlag(db, MCP_ENABLED_FLAG, true);
    const flagFails: Db = {
      query: (text, params) => (text.includes("app_flags") ? Promise.reject(new StoreError("STORE_UNAVAILABLE")) : db.query(text, params)),
      transaction: (fn) => db.transaction(fn),
      close: async () => {},
    };
    const unreadable = await ask(build({ db: flagFails }).app);
    expect(unreadable.status).toBe(503);
    expect(await unreadable.json()).toEqual({ error: "MCP_OFF" });

    expect(verify).not.toHaveBeenCalled();
    expect(await snapshot()).toBe(before);
  });

  it("refuses a request with no usable client address", async () => {
    const { app, verify } = build();
    for (const value of [null, "203.0.113.7, 198.51.100.1", "not-an-address"]) {
      const res = await ask(app, { turnstileToken: "tok" }, { [IP_HEADER]: value });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "NO_CLIENT_ADDRESS" });
    }
    expect(verify).not.toHaveBeenCalled();
    expect(await tokenRows()).toBe(0);
  });

  it("issues nothing for an answer naming another hostname, the run-start action, no action, or a siteverify timeout (D1.5)", async () => {
    const answering = (reply: () => Promise<Response>) =>
      createTurnstileVerifier({
        secret: "0x4AAAAAAA-real-looking-secret",
        expectedHostname: new URL(APP_ORIGIN).hostname,
        fetchImpl: (async () => reply()) as typeof fetch,
        timeoutMs: 50,
      });
    const answer = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 });
    const before = await snapshot();

    const refused: Array<[string, () => Promise<Response>]> = [
      ["another hostname", answer({ success: true, hostname: "evil.example", action: TURNSTILE_ACTIONS.agentKey })],
      ["the run-start action", answer({ success: true, hostname: "localhost", action: TURNSTILE_ACTIONS.runStart })],
      ["no action", answer({ success: true, hostname: "localhost" })],
      ["a failed check", answer({ success: false, hostname: "localhost", action: TURNSTILE_ACTIONS.agentKey })],
      ["a siteverify timeout", () => new Promise<Response>(() => {})],
    ];
    for (const [label, reply] of refused) {
      const res = await ask(build({ verify: answering(reply) }).app);
      expect(res.status, label).toBe(403);
      expect(await res.json()).toEqual({ error: "HUMAN_CHECK_FAILED" });
    }
    const thrown = await ask(build({ verify: async () => Promise.reject(new Error(MARKER)) }).app);
    expect(thrown.status).toBe(403);
    expect(await snapshot()).toBe(before);

    const ok = await ask(build({ verify: answering(answer({ success: true, hostname: "LocalHost", action: TURNSTILE_ACTIONS.agentKey })) }).app);
    expect(ok.status).toBe(201);
  });

  it("refuses a fourth key from one visitor in a UTC day, changing nothing, while another visitor still gets one", async () => {
    const { app } = build();
    for (let i = 0; i < 3; i += 1) expect((await ask(app)).status).toBe(201);
    const before = await snapshot();

    const fourth = await ask(app, { turnstileToken: "tok" }, { [IP_HEADER]: `::ffff:${VISITOR}` });

    expect(fourth.status).toBe(429);
    expect(await fourth.json()).toEqual({ error: "VISITOR_LIMIT" });
    expect(await snapshot()).toBe(before);
    expect((await ask(app, { turnstileToken: "tok" }, { [IP_HEADER]: "203.0.113.8" })).status).toBe(201);
  });

  it("issues exactly 3 keys from 20 simultaneous requests by one visitor against a cap of 3", async () => {
    const { app } = build();

    const results = await Promise.all(Array.from({ length: 20 }, () => ask(app)));

    expect(results.filter((res) => res.status === 201)).toHaveLength(3);
    expect(results.filter((res) => res.status === 429)).toHaveLength(17);
    expect(await tokenRows()).toBe(3);
    expect((await usage(db, "mcp:keys:day"))?.used).toBe(3);
  });

  it("refuses with KEY_BUDGET when the global daily bucket is full or missing, and the visitor's count is rolled back", async () => {
    await setBucket(db, { key: "mcp:keys:day", cap: 1, windowEnd: FAR_FUTURE });
    const { app } = build();
    expect((await ask(app)).status).toBe(201);
    const before = await snapshot();

    const full = await ask(app, { turnstileToken: "tok" }, { [IP_HEADER]: "203.0.113.8" });
    expect(full.status).toBe(429);
    expect(await full.json()).toEqual({ error: "KEY_BUDGET" });
    expect(await snapshot()).toBe(before);

    await db.query("DELETE FROM usage_buckets WHERE key = 'mcp:keys:day'");
    const missing = await ask(app, { turnstileToken: "tok" }, { [IP_HEADER]: "203.0.113.9" });
    expect(missing.status).toBe(429);
    expect((await db.query("SELECT count(*)::int AS n FROM mcp_key_issue")).rows).toEqual([{ n: 1 }]);
  });

  it("answers a database failure with 500 INTERNAL, logging only the route and a code", async () => {
    const lines = captureConsole();
    const failing: Db = {
      query: (text, params) => db.query(text, params),
      transaction: () => Promise.reject(new StoreError("STORE_UNAVAILABLE")),
      close: async () => {},
    };

    const res = await ask(build({ db: failing }).app);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "INTERNAL" });
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([{ level: "error", route: "/agent-keys", code: "STORE_UNAVAILABLE" }]);
    expect(await tokenRows()).toBe(0);
  });

  it("answers only the exact POST route, and lets the app origin send its preflight", async () => {
    const { app, verify } = build();
    for (const path of ["/agent-keys/", "/AGENT-KEYS", "/agent-keysx", "/agent-keys/x"]) {
      expect((await ask(app, { turnstileToken: "tok" }, {}, path)).status, path).toBe(404);
    }
    expect(verify).not.toHaveBeenCalled();

    const preflight = await app.request("/agent-keys", {
      method: "OPTIONS",
      headers: { origin: APP_ORIGIN, "access-control-request-method": "POST" },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    expect(preflight.headers.get("access-control-allow-credentials")).toBeNull();
  });
});

describe("GET /agent-keys", () => {
  it("states whether keys are open and each key's limits, changing nothing, with an unreadable flag read as closed", async () => {
    const { app, verify } = build();
    const before = await snapshot();
    const open = await app.request("/agent-keys");
    expect(open.status).toBe(200);
    expect(open.headers.get("cache-control")).toBe("public, max-age=30");
    expect(await open.json()).toEqual({
      open: true,
      limits: { runsPerDay: 3, findsPerDay: 20, briefsPerDay: 15, inflightPerKey: 3, keyLifeDays: 30, keysPerVisitorPerDay: 3 },
    });

    await setFlag(db, MCP_ENABLED_FLAG, false);
    expect(((await (await app.request("/agent-keys")).json()) as { open: boolean }).open).toBe(false);

    const flagFails: Db = {
      query: () => Promise.reject(new StoreError("STORE_UNAVAILABLE")),
      transaction: (fn) => db.transaction(fn),
      close: async () => {},
    };
    const unreadable = await build({ db: flagFails }).app.request("/agent-keys");
    expect(unreadable.status).toBe(200);
    expect(((await unreadable.json()) as { open: boolean }).open).toBe(false);

    expect(verify).not.toHaveBeenCalled();
    expect(await snapshot()).toBe(before);
  });
});
