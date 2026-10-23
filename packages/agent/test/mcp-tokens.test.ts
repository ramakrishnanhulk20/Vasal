// Covers agent keys on PGlite: issue, the Authorization header parser, the
// one-query check, the mcp_enabled flag, the operator's list and revoke
// functions that the ops script calls, and the app role's grants on
// mcp_tokens (roles.sql applied to PGlite). It does not cover the key-issue
// route (server-keys.test.ts), races between separate connections (PGlite
// has one), or the MCP route that will read the header (the next work order).
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authenticateToken,
  issueToken,
  listTokens,
  MCP_ENABLED_FLAG,
  mcpEnabled,
  parseBearer,
  revokeAllTokens,
  revokeToken,
  TOKEN_PATTERN,
} from "../src/mcp/tokens.js";
import { ServerError } from "../src/server/errors.js";
import type { Db } from "../src/store/db.js";
import { StoreError } from "../src/store/errors.js";
import { setFlag } from "../src/store/flags.js";
import { migratedPglite } from "./helpers/pglite.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const MARKER = "MARKER-t0k3n";

let db: Db;

beforeEach(async () => {
  db = await migratedPglite();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.close();
});

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof ServerError ? error.code : String(error);
  }
  return undefined;
}

// Every row of every table, as text, so "the key is stored nowhere" is one search.
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

function recordingDb(): { db: Db; calls: string[] } {
  const calls: string[] = [];
  const self: Db = {
    query: async (text) => {
      calls.push(text);
      return { rows: [] };
    },
    transaction: (fn) => fn(self),
    close: async () => {},
  };
  return { db: self, calls };
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

describe("issueToken (D1.1, D1.4, D1.7)", () => {
  it("returns a fresh vsl_ key, stores only its SHA-256, and writes it to no row and no log", async () => {
    const lines = captureConsole();

    const first = await issueToken(db);
    const second = await issueToken(db);

    expect(first.token).toMatch(TOKEN_PATTERN);
    expect(second.token).toMatch(TOKEN_PATTERN);
    expect(second.token).not.toBe(first.token);
    expect(Buffer.from(first.token.slice(4), "base64url")).toHaveLength(32);

    const { rows } = await db.query<{ id: string; token_hash: string }>(
      "SELECT id::text AS id, token_hash FROM mcp_tokens ORDER BY created_at, id",
    );
    expect(new Map(rows.map((row) => [row.id, row.token_hash]))).toEqual(
      new Map([
        [first.id, sha256(first.token)],
        [second.id, sha256(second.token)],
      ]),
    );
    const dump = await everyRow();
    for (const { token } of [first, second]) {
      expect(dump).not.toContain(token);
      expect(dump).not.toContain(token.slice(4));
    }
    expect(dump).not.toContain("vsl_");
    expect(lines.join("\n")).not.toContain("vsl_");
  });

  it("sets created and expiry times from the database clock, 30 days apart, with no visitor column", async () => {
    const issued = await issueToken(db);

    const { rows } = await db.query<{ created: Date; expires: Date; drift: number }>(
      `SELECT created_at AS created, expires_at AS expires,
              abs(extract(epoch FROM (now() - created_at)))::float8 AS drift
       FROM mcp_tokens WHERE id = $1::uuid`,
      [issued.id],
    );
    expect(rows[0]!.drift).toBeLessThan(60);
    expect(new Date(rows[0]!.expires).getTime() - new Date(rows[0]!.created).getTime()).toBe(30 * DAY_MS);
    expect(issued.expiresAt).toEqual(new Date(rows[0]!.expires));

    const { rows: columns } = await db.query<{ c: string }>(
      "SELECT column_name AS c FROM information_schema.columns WHERE table_name = 'mcp_tokens' ORDER BY ordinal_position",
    );
    expect(columns.map((column) => column.c)).toEqual(["id", "token_hash", "created_at", "expires_at", "revoked"]);
  });

  it("reports a database failure as SRV_UNAVAILABLE without the key in the error", async () => {
    const failing: Db = {
      query: () => Promise.reject(new Error(MARKER)),
      transaction: () => Promise.reject(new Error(MARKER)),
      close: async () => {},
    };
    const error = await issueToken(failing).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServerError);
    expect((error as ServerError).code).toBe("SRV_UNAVAILABLE");
    expect(String((error as Error).message)).not.toMatch(/vsl_|MARKER/);
  });
});

describe("parseBearer (D1.2)", () => {
  const token = `vsl_${"A".repeat(20)}-_${"z9".repeat(10)}a`;

  it("accepts Bearer in any ASCII case, one space, then exactly the key format", () => {
    expect(token).toMatch(TOKEN_PATTERN);
    for (const scheme of ["Bearer", "bearer", "BEARER", "bEaReR"]) {
      expect(parseBearer(`${scheme} ${token}`), scheme).toBe(token);
    }
  });

  it("refuses every other shape", () => {
    const refused: Array<[string, unknown]> = [
      ["two spaces", `Bearer  ${token}`],
      ["Basic", `Basic ${token}`],
      ["a short key", `Bearer ${token.slice(0, -1)}`],
      ["a long key", `Bearer ${token}A`],
      ["extra text after", `Bearer ${token} extra`],
      ["a trailing space", `Bearer ${token} `],
      ["a leading space", ` Bearer ${token}`],
      ["a tab", `Bearer\t${token}`],
      ["a line break", `Bearer ${token}\n`],
      ["a comma list", `Bearer ${token}, Bearer ${token}`],
      ["an upper-case prefix", `Bearer VSL_${token.slice(4)}`],
      ["no prefix", `Bearer ${token.slice(4)}`],
      ["a padded key", `Bearer ${token.slice(0, -1)}=`],
      ["a dotted scheme", `Bear.r ${token}`],
      ["a non-ASCII scheme", `Bearerİ ${token}`],
      ["the key alone", token],
      ["empty", ""],
      ["null", null],
      ["undefined", undefined],
      ["a number", 5],
    ];
    for (const [label, header] of refused) {
      expect(parseBearer(header as string | null | undefined), label).toBeNull();
    }
  });
});

describe("authenticateToken (D1.3, D6.1)", () => {
  it("returns the key row id for a live key", async () => {
    const issued = await issueToken(db);
    expect(await authenticateToken(db, issued.token)).toEqual({ id: issued.id });
  });

  it("refuses a key revoked between two calls, on the second call", async () => {
    const issued = await issueToken(db);
    expect(await authenticateToken(db, issued.token)).toEqual({ id: issued.id });

    await db.query("UPDATE mcp_tokens SET revoked = true WHERE id = $1::uuid", [issued.id]);

    expect(await authenticateToken(db, issued.token)).toBeNull();
  });

  it("refuses a key whose expiry has passed on the database clock", async () => {
    const issued = await issueToken(db);
    await db.query(
      "UPDATE mcp_tokens SET created_at = now() - interval '31 days', expires_at = now() - interval '1 day' WHERE id = $1::uuid",
      [issued.id],
    );
    expect(await authenticateToken(db, issued.token)).toBeNull();
  });

  it("refuses a row that fails the key schema, such as a life longer than issue grants", async () => {
    const stretched = await issueToken(db);
    await db.query("UPDATE mcp_tokens SET expires_at = created_at + interval '365 days' WHERE id = $1::uuid", [stretched.id]);
    expect(await authenticateToken(db, stretched.token)).toBeNull();

    const backwards = await issueToken(db);
    await db.query("UPDATE mcp_tokens SET created_at = expires_at + interval '1 hour' WHERE id = $1::uuid", [backwards.id]);
    expect(await authenticateToken(db, backwards.token)).toBeNull();
  });

  it("refuses an unknown key, and refuses a malformed one with no database read", async () => {
    await issueToken(db);
    expect(await authenticateToken(db, `vsl_${"Q".repeat(43)}`)).toBeNull();

    const { db: recording, calls } = recordingDb();
    for (const value of ["", "vsl_short", `VSL_${"Q".repeat(43)}`, `vsl_${"Q".repeat(43)} `, `Bearer vsl_${"Q".repeat(43)}`]) {
      expect(await authenticateToken(recording, value)).toBeNull();
    }
    expect(await authenticateToken(recording, 5 as unknown as string)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("reports a database failure as SRV_UNAVAILABLE, never as a pass or a plain refusal", async () => {
    const issued = await issueToken(db);
    await db.close();
    expect(await codeOf(authenticateToken(db, issued.token))).toBe("SRV_UNAVAILABLE");
    db = await migratedPglite();
  });
});

describe("mcpEnabled (D1.6, C5.7)", () => {
  it("is true only for a stored boolean true, and false when missing, off or unreadable", async () => {
    expect(await mcpEnabled(db)).toBe(false);
    await setFlag(db, MCP_ENABLED_FLAG, true);
    expect(await mcpEnabled(db)).toBe(true);
    await setFlag(db, MCP_ENABLED_FLAG, false);
    expect(await mcpEnabled(db)).toBe(false);

    const broken: Db = {
      query: () => Promise.reject(new StoreError("STORE_UNAVAILABLE")),
      transaction: () => Promise.reject(new StoreError("STORE_UNAVAILABLE")),
      close: async () => {},
    };
    expect(await mcpEnabled(broken)).toBe(false);
  });
});

describe("the operator's list and revoke, behind ops mcp list, revoke and revoke-all (D1.6)", () => {
  it("revokes one key at once, leaves the others working, and lists keys with no hash", async () => {
    const kept = await issueToken(db);
    const leaked = await issueToken(db);

    expect(await revokeToken(db, leaked.id)).toBe(true);

    expect(await authenticateToken(db, leaked.token)).toBeNull();
    expect(await authenticateToken(db, kept.token)).toEqual({ id: kept.id });
    expect(await revokeToken(db, leaked.id)).toBe(true);
    expect(await revokeToken(db, crypto.randomUUID())).toBe(false);
    expect(await codeOf(revokeToken(db, leaked.id.toUpperCase()))).toBe("SRV_BAD_INPUT");
    expect(await codeOf(revokeToken(db, `${leaked.id}' OR '1'='1`))).toBe("SRV_BAD_INPUT");

    const listed = await listTokens(db);
    expect(listed.total).toBe(2);
    expect(listed.tokens.map((entry) => [entry.id, entry.revoked]).sort()).toEqual(
      [
        [kept.id, false],
        [leaked.id, true],
      ].sort(),
    );
    const text = JSON.stringify(listed);
    for (const issued of [kept, leaked]) {
      expect(text).not.toContain(sha256(issued.token));
      expect(text).not.toContain(issued.token);
    }
  });

  it("revokes every live key in one step and counts only the ones it changed", async () => {
    const keys = [await issueToken(db), await issueToken(db), await issueToken(db)];
    await revokeToken(db, keys[0]!.id);

    expect(await revokeAllTokens(db)).toBe(2);

    for (const issued of keys) expect(await authenticateToken(db, issued.token)).toBeNull();
    expect(await revokeAllTokens(db)).toBe(0);
  });
});

describe("the app role on mcp_tokens (roles.sql, C6.6, D1.6)", () => {
  it("can issue and check keys but cannot un-revoke, extend or delete one", async () => {
    const revoked = await issueToken(db);
    await revokeToken(db, revoked.id);
    await applyRoles();

    await db.query("SET ROLE vasal_app");
    expect((await db.query<{ who: string }>("SELECT current_user AS who")).rows).toEqual([{ who: "vasal_app" }]);
    const issued = await issueToken(db);
    expect(await authenticateToken(db, issued.token)).toEqual({ id: issued.id });
    const writes: Array<[string, unknown[]]> = [
      ["UPDATE mcp_tokens SET revoked = false WHERE id = $1::uuid", [revoked.id]],
      ["UPDATE mcp_tokens SET expires_at = expires_at + interval '30 days' WHERE id = $1::uuid", [issued.id]],
      ["UPDATE mcp_tokens SET token_hash = $2 WHERE id = $1::uuid", [issued.id, "0".repeat(64)]],
      ["DELETE FROM mcp_tokens WHERE id = $1::uuid", [revoked.id]],
      ["TRUNCATE mcp_tokens", []],
    ];
    for (const [text, params] of writes) {
      await expect(db.query(text, params), text).rejects.toThrow(StoreError);
    }
    expect(await codeOf(revokeToken(db, issued.id))).toBe("SRV_UNAVAILABLE");
    expect(await authenticateToken(db, revoked.token)).toBeNull();
    await db.query("RESET ROLE");

    // The owner can run the same statements, so each refusal above was the grant.
    await db.query(writes[0]![0], writes[0]![1]);
    expect(await authenticateToken(db, revoked.token)).toEqual({ id: revoked.id });
  });
});
