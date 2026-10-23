// Covers the per-key and per-visitor MCP counters on PGlite, and the app
// role's grants on them and on MCP's in-flight share (roles.sql applied to
// PGlite). It does not cover races between separate connections (PGlite has
// one, so simultaneous calls are serialised and this proves the
// single-statement cap), the MCP tools that will spend these counts (the
// next work order), or pruning old rows (ops-prune.test.ts).
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueToken } from "../src/mcp/tokens.js";
import {
  acquireTokenInflight,
  countKeyIssue,
  countTokenUse,
  MCP_LIMITS,
  releaseTokenInflight,
  resetTokenInflight,
  type TokenUseKind,
} from "../src/mcp/usage.js";
import { visitorKey } from "../src/net/visitor-key.js";
import { acquireMcpRunSlots, releaseMcpRunSlots } from "../src/server/caps.js";
import { ServerError } from "../src/server/errors.js";
import type { Db } from "../src/store/db.js";
import { StoreError } from "../src/store/errors.js";
import { migratedPglite } from "./helpers/pglite.js";

const DAY = new Date("2026-10-19T08:00:00.000Z");
const LATE_SAME_DAY = new Date("2026-10-19T23:59:59.999Z");
const NEXT_DAY = new Date("2026-10-20T00:00:00.000Z");

let db: Db;

beforeEach(async () => {
  db = await migratedPglite();
});

afterEach(async () => {
  await db.close();
});

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof ServerError ? error.code : String(error);
  }
  return undefined;
}

async function inflightOf(tokenId: string): Promise<number | undefined> {
  const { rows } = await db.query<{ n: number }>("SELECT n FROM mcp_token_inflight WHERE token_id = $1::uuid", [tokenId]);
  return rows[0]?.n;
}

function hashOf(address: string): string {
  const key = visitorKey(address, "s".repeat(32));
  if (key === null) throw new Error("expected a key");
  return key;
}

async function applyRoles(): Promise<void> {
  const sql = await readFile(new URL("../src/store/roles.sql", import.meta.url), "utf8");
  const statements = sql
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    // A semicolon inside the DO block's $$ body does not end a statement.
    .split(/;(?=(?:[^$]*\$\$[^$]*\$\$)*[^$]*$)/)
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");
  for (const statement of statements) await db.query(statement);
}

describe("MCP_LIMITS", () => {
  it("holds the starting values from the threat model: one human check buys at most 90 runs", () => {
    expect(MCP_LIMITS).toEqual({
      runsPerDay: 3,
      findsPerDay: 20,
      briefsPerDay: 15,
      inflightPerToken: 3,
      keysPerVisitorPerDay: 3,
      tokenLifeDays: 30,
    });
    expect(MCP_LIMITS.runsPerDay * MCP_LIMITS.tokenLifeDays).toBe(90);
  });
});

describe("countTokenUse (D3.6)", () => {
  it("gives exactly 5 of 20 simultaneous calls against a cap of 5", async () => {
    const { id } = await issueToken(db);

    const results = await Promise.all(Array.from({ length: 20 }, () => countTokenUse(db, id, "finds", 5, DAY)));

    expect(results.filter((counted) => counted)).toHaveLength(5);
    const { rows } = await db.query("SELECT day::text AS day, runs, finds, briefs FROM mcp_token_daily WHERE token_id = $1::uuid", [id]);
    expect(rows).toEqual([{ day: "2026-10-19", runs: 0, finds: 5, briefs: 0 }]);
  });

  it("counts each kind and each key on its own, and starts again on the next UTC day", async () => {
    const alice = await issueToken(db);
    const bob = await issueToken(db);

    for (let i = 0; i < 3; i += 1) expect(await countTokenUse(db, alice.id, "runs", 3, DAY)).toBe(true);
    expect(await countTokenUse(db, alice.id, "runs", 3, LATE_SAME_DAY)).toBe(false);
    expect(await countTokenUse(db, alice.id, "briefs", 15, LATE_SAME_DAY)).toBe(true);
    expect(await countTokenUse(db, bob.id, "runs", 3, DAY)).toBe(true);
    expect(await countTokenUse(db, alice.id, "runs", 3, NEXT_DAY)).toBe(true);

    const { rows } = await db.query<{ day: string; runs: number; briefs: number }>(
      "SELECT day::text AS day, runs, briefs FROM mcp_token_daily WHERE token_id = $1::uuid ORDER BY day",
      [alice.id],
    );
    expect(rows).toEqual([
      { day: "2026-10-19", runs: 3, briefs: 1 },
      { day: "2026-10-20", runs: 1, briefs: 0 },
    ]);
  });

  it("refuses a bad id, kind, cap or date and writes nothing, and fails as SRV_UNAVAILABLE for an unknown key row", async () => {
    const { id } = await issueToken(db);
    for (const tokenId of [id.toUpperCase(), "", "not-a-uuid", `${id}x`]) {
      expect(await codeOf(countTokenUse(db, tokenId, "runs", 3, DAY))).toBe("SRV_BAD_INPUT");
    }
    for (const kind of ["token_id", "day", "runs; DROP TABLE runs", "", "constructor"]) {
      expect(await codeOf(countTokenUse(db, id, kind as TokenUseKind, 3, DAY)), kind).toBe("SRV_BAD_INPUT");
    }
    for (const cap of [0, -1, 1.5, 1_001, Number.NaN]) {
      expect(await codeOf(countTokenUse(db, id, "runs", cap, DAY))).toBe("SRV_BAD_INPUT");
    }
    expect(await codeOf(countTokenUse(db, id, "runs", 3, new Date(Number.NaN)))).toBe("SRV_BAD_INPUT");
    expect((await db.query("SELECT 1 FROM mcp_token_daily")).rows).toEqual([]);

    expect(await codeOf(countTokenUse(db, crypto.randomUUID(), "runs", 3, DAY))).toBe("SRV_UNAVAILABLE");
  });
});

describe("a key's calls in flight (D3.6)", () => {
  it("gives exactly 3 of 10 simultaneous calls against a max of 3, frees one on release, and never goes below 0", async () => {
    const { id } = await issueToken(db);

    const results = await Promise.all(Array.from({ length: 10 }, () => acquireTokenInflight(db, id, 3)));

    expect(results.filter((acquired) => acquired)).toHaveLength(3);
    expect(await inflightOf(id)).toBe(3);
    await releaseTokenInflight(db, id);
    expect(await acquireTokenInflight(db, id, 3)).toBe(true);
    expect(await acquireTokenInflight(db, id, 3)).toBe(false);
    for (let i = 0; i < 5; i += 1) await releaseTokenInflight(db, id);
    expect(await inflightOf(id)).toBe(0);
  });

  it("keeps keys apart and resets every key at startup", async () => {
    const alice = await issueToken(db);
    const bob = await issueToken(db);
    expect(await acquireTokenInflight(db, alice.id, 1)).toBe(true);
    expect(await acquireTokenInflight(db, alice.id, 1)).toBe(false);
    expect(await acquireTokenInflight(db, bob.id, 1)).toBe(true);

    await resetTokenInflight(db);

    expect([await inflightOf(alice.id), await inflightOf(bob.id)]).toEqual([0, 0]);
    expect(await acquireTokenInflight(db, alice.id, 1)).toBe(true);
  });

  it("refuses a bad id or max", async () => {
    const { id } = await issueToken(db);
    for (const max of [0, 21, 2.5]) expect(await codeOf(acquireTokenInflight(db, id, max))).toBe("SRV_BAD_INPUT");
    expect(await codeOf(acquireTokenInflight(db, "x", 3))).toBe("SRV_BAD_INPUT");
    expect(await codeOf(releaseTokenInflight(db, "x"))).toBe("SRV_BAD_INPUT");
  });
});

describe("countKeyIssue (D1.5)", () => {
  it("gives exactly 3 of 20 simultaneous issues to one visitor, counts IPv4 and its mapped form as one, and resets the next day", async () => {
    const visitor = hashOf("203.0.113.9");

    const results = await Promise.all(Array.from({ length: 20 }, () => countKeyIssue(db, visitor, 3, DAY)));

    expect(results.filter((counted) => counted)).toHaveLength(3);
    expect(await countKeyIssue(db, hashOf("::ffff:203.0.113.9"), 3, LATE_SAME_DAY)).toBe(false);
    expect(await countKeyIssue(db, hashOf("203.0.113.10"), 3, DAY)).toBe(true);
    expect(await countKeyIssue(db, visitor, 3, NEXT_DAY)).toBe(true);
  });

  it("refuses a raw address, a bad cap or a bad date and stores nothing", async () => {
    const visitor = hashOf("203.0.113.9");
    for (const hash of ["203.0.113.9", "", visitor.toUpperCase(), visitor.slice(1)]) {
      expect(await codeOf(countKeyIssue(db, hash, 3, DAY))).toBe("SRV_BAD_INPUT");
    }
    for (const cap of [0, 101, 1.5]) expect(await codeOf(countKeyIssue(db, visitor, cap, DAY))).toBe("SRV_BAD_INPUT");
    expect(await codeOf(countKeyIssue(db, visitor, 3, new Date(Number.NaN)))).toBe("SRV_BAD_INPUT");
    expect((await db.query("SELECT 1 FROM mcp_key_issue")).rows).toEqual([]);
  });
});

describe("the app role on the MCP counters (roles.sql, C6.6)", () => {
  it("can count and take places but cannot move a row to another key, visitor or day, or delete one", async () => {
    const { id } = await issueToken(db);
    const other = await issueToken(db);
    const visitor = hashOf("203.0.113.9");
    await applyRoles();

    await db.query("SET ROLE vasal_app");
    expect(await countTokenUse(db, id, "runs", 3, DAY)).toBe(true);
    expect(await acquireTokenInflight(db, id, 3)).toBe(true);
    await releaseTokenInflight(db, id);
    expect(await countKeyIssue(db, visitor, 3, DAY)).toBe(true);
    expect(await acquireMcpRunSlots(db, 1, 3)).toBe(true);
    expect(await acquireMcpRunSlots(db, 1, 3)).toBe(false);
    await releaseMcpRunSlots(db);
    expect(await acquireMcpRunSlots(db, 1, 3)).toBe(true);

    const writes: Array<[string, unknown[]]> = [
      ["UPDATE mcp_token_daily SET token_id = $2::uuid WHERE token_id = $1::uuid", [id, other.id]],
      ["UPDATE mcp_token_daily SET day = day + 1 WHERE token_id = $1::uuid", [id]],
      ["DELETE FROM mcp_token_daily WHERE token_id = $1::uuid", [id]],
      ["UPDATE mcp_token_inflight SET token_id = $2::uuid WHERE token_id = $1::uuid", [id, other.id]],
      ["DELETE FROM mcp_token_inflight WHERE token_id = $1::uuid", [id]],
      ["UPDATE mcp_key_issue SET day = day + 1 WHERE visitor_hash = $1", [visitor]],
      ["UPDATE mcp_key_issue SET visitor_hash = $2 WHERE visitor_hash = $1", [visitor, "0".repeat(64)]],
      ["DELETE FROM mcp_key_issue WHERE visitor_hash = $1", [visitor]],
      ["UPDATE inflight SET slot = 'x' WHERE slot = 'mcp'", []],
      ["DELETE FROM inflight WHERE slot = 'mcp'", []],
    ];
    for (const [text, params] of writes) {
      await expect(db.query(text, params), text).rejects.toThrow(StoreError);
    }
    await db.query("RESET ROLE");

    // The owner can run the same statements, so each refusal above was the grant.
    for (const [text, params] of writes) await db.query(text, params);
  });
});
