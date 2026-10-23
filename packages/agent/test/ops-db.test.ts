// Covers how the operator scripts read their database settings, where a
// tunnel connection points (read from pg's startup message on a local fake
// server), and bootstrapOwner and applyRoles run on Postgres in PGlite. It
// does not open a hosted connection or log in with a password, because PGlite
// has no password authentication, and it does not cover a provider's own
// roles or a server older than Postgres 16.
import { readFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyRoles,
  bootstrapOwner,
  databaseNetworkFrom,
  hexPasswordFrom,
  OpsConfigError,
  openBootstrapDb,
  openOwnerDb,
  RoleSetupError,
  ROLES_FILE,
  tunnelPortFrom,
} from "../src/ops/db.js";
import type { Db } from "../src/store/db.js";
import { StoreError } from "../src/store/errors.js";
import { migrate } from "../src/store/migrate.js";
import { SCRAM_VERIFIER } from "../src/store/scram.js";

const MARKER = "MARKER-d41b";
const OWNER_PASSWORD = "a1".repeat(32);
const APP_PASSWORD = "b2".repeat(32);

function opsConfigError(run: () => unknown): OpsConfigError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(OpsConfigError);
    return error as OpsConfigError;
  }
  throw new Error("expected an OpsConfigError");
}

describe("databaseNetworkFrom", () => {
  it("reads railway-private, and unset or blank as no network", () => {
    expect(databaseNetworkFrom({ DATABASE_NETWORK: "railway-private" })).toEqual({ network: "railway-private" });
    expect(databaseNetworkFrom({ DATABASE_NETWORK: " railway-private " })).toEqual({ network: "railway-private" });
    expect(databaseNetworkFrom({})).toEqual({});
    expect(databaseNetworkFrom({ DATABASE_NETWORK: " " })).toEqual({});
  });

  it("refuses any other value, naming the variable and not the value", () => {
    for (const value of [`railway-private${MARKER}`, "RAILWAY-PRIVATE", `public${MARKER}`]) {
      const error = opsConfigError(() => databaseNetworkFrom({ DATABASE_NETWORK: value }));
      expect(error.message).toContain("DATABASE_NETWORK");
      expect(error.message).not.toContain(value);
    }
  });

  it("is read before the owner connection opens", () => {
    const error = opsConfigError(() =>
      openOwnerDb({ OWNER_DATABASE_URL: `postgresql://vasal_owner:${MARKER}@postgres.railway.internal/railway`, DATABASE_NETWORK: MARKER }),
    );
    expect(error.message).toContain("DATABASE_NETWORK");
    expect(error.message).not.toContain(MARKER);
  });
});

describe("hexPasswordFrom and tunnelPortFrom", () => {
  it("accepts exactly 64 lower-case hex characters for both passwords", () => {
    expect(hexPasswordFrom({ VASAL_OWNER_PASSWORD: OWNER_PASSWORD }, "VASAL_OWNER_PASSWORD")).toBe(OWNER_PASSWORD);
    expect(hexPasswordFrom({ VASAL_APP_PASSWORD: APP_PASSWORD }, "VASAL_APP_PASSWORD")).toBe(APP_PASSWORD);
  });

  it("refuses anything else, naming the variable and not the value", () => {
    for (const variable of ["VASAL_OWNER_PASSWORD", "VASAL_APP_PASSWORD"] as const) {
      for (const value of [
        undefined,
        "",
        "a1".repeat(31),
        `${"a1".repeat(32)}0`,
        "A1".repeat(32),
        `'${"a".repeat(63)}`,
        ` ${"a1".repeat(32)}`,
        `${MARKER}${"0".repeat(64 - MARKER.length)}`,
      ]) {
        const error = opsConfigError(() => hexPasswordFrom({ [variable]: value }, variable));
        expect(error.message).toContain(variable);
        if (value !== undefined && value.length > 3) expect(error.message).not.toContain(value);
        expect(error.message).not.toContain(MARKER);
      }
    }
  });

  it("reads a tunnel port as digits from 1 to 65535 only", () => {
    expect(tunnelPortFrom("5432")).toBe(5432);
    expect(tunnelPortFrom("65535")).toBe(65_535);
    for (const text of ["0", "65536", "-1", " 5432", "5432 ", "54.32", "0x10", "", "123456"]) {
      expect(() => tunnelPortFrom(text), text).toThrow(OpsConfigError);
    }
  });
});

// A fake server that reads the first message pg sends: the 8-byte SSLRequest
// when it wants TLS, or the startup message with the user and database.
async function firstMessageTo(open: (port: number) => Db): Promise<{ ssl: boolean; params: Record<string, string> }> {
  let received: (value: { ssl: boolean; params: Record<string, string> }) => void = () => {};
  const message = new Promise<{ ssl: boolean; params: Record<string, string> }>((resolve) => {
    received = resolve;
  });
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 8 || buffer.length < buffer.readInt32BE(0)) return;
      const code = buffer.readInt32BE(4);
      const params: Record<string, string> = {};
      if (code === 196_608) {
        const fields = buffer.subarray(8, buffer.readInt32BE(0)).toString("utf8").split("\0");
        for (let i = 0; i + 1 < fields.length; i += 2) if (fields[i]) params[fields[i]!] = fields[i + 1]!;
      }
      received({ ssl: code === 80_877_103, params });
      socket.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const db = open((server.address() as AddressInfo).port);
  try {
    await expect(db.query("SELECT 1")).rejects.toThrow(StoreError);
    return await message;
  } finally {
    await db.close().catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("tunnel connections", () => {
  it("connects the owner as vasal_owner to PGDATABASE on 127.0.0.1, without TLS", async () => {
    const env = { VASAL_OWNER_PASSWORD: OWNER_PASSWORD, PGDATABASE: "railway", OWNER_DATABASE_URL: "postgresql://other@db.example/x" };
    const first = await firstMessageTo((port) => openOwnerDb(env, { tunnelPort: port }));
    expect(first.ssl).toBe(false);
    expect(first.params).toMatchObject({ user: "vasal_owner", database: "railway" });
  });

  it("connects bootstrap as PGUSER, keeping a password with URL characters intact", async () => {
    const env = { PGUSER: "postgres", PGPASSWORD: "p@ss:w/rd%#?", PGDATABASE: "rail way", BOOTSTRAP_DATABASE_URL: "postgresql://x@db.example/x" };
    const first = await firstMessageTo((port) => openBootstrapDb(env, { tunnelPort: port }));
    expect(first.ssl).toBe(false);
    expect(first.params).toMatchObject({ user: "postgres", database: "rail way" });
  });

  it("names the first missing variable, and never a value", () => {
    const owner = (env: NodeJS.ProcessEnv) => opsConfigError(() => openOwnerDb(env, { tunnelPort: 5432 })).message;
    expect(owner({ PGDATABASE: "railway" })).toContain("VASAL_OWNER_PASSWORD");
    expect(owner({ VASAL_OWNER_PASSWORD: OWNER_PASSWORD })).toContain("PGDATABASE");

    const bootstrap = (env: NodeJS.ProcessEnv, opts: { tunnelPort?: number } = { tunnelPort: 5432 }) =>
      opsConfigError(() => openBootstrapDb(env, opts)).message;
    expect(bootstrap({ PGPASSWORD: MARKER, PGDATABASE: "railway" })).toContain("PGUSER");
    expect(bootstrap({ PGUSER: "postgres", PGDATABASE: "railway" })).toContain("PGPASSWORD");
    expect(bootstrap({ PGUSER: "postgres", PGPASSWORD: MARKER })).toContain("PGDATABASE");
    expect(bootstrap({ PGUSER: "postgres", PGPASSWORD: MARKER }, {})).toContain("BOOTSTRAP_DATABASE_URL");
    expect(bootstrap({ PGPASSWORD: MARKER, PGDATABASE: "railway" })).not.toContain(MARKER);
    expect(() => openOwnerDb({ VASAL_OWNER_PASSWORD: OWNER_PASSWORD, PGDATABASE: "railway" }, { tunnelPort: 70_000 })).toThrow(OpsConfigError);
  });
});

type Recorded = Db & { calls: Array<{ text: string; params: unknown[] | undefined }> };

// pg sends a query that has no params with its simple protocol, which may
// hold several statements. PGlite offers that only through exec, so this
// stand-in for the pg adapter routes the same way and records every call.
function simpleProtocolDb(pg: PGlite): Recorded {
  const calls: Recorded["calls"] = [];
  const over = (conn: PGlite | Transaction): Db => {
    const self: Db = {
      async query<R>(text: string, params?: unknown[]) {
        calls.push({ text, params });
        if (params !== undefined) return { rows: (await conn.query<R>(text, params)).rows };
        const results = await conn.exec(text);
        return { rows: (results.at(-1)?.rows ?? []) as R[] };
      },
      transaction: (fn) => ("transaction" in conn ? conn.transaction((tx) => fn(over(tx))) : fn(self)),
      close: () => pg.close(),
    };
    return self;
  };
  return Object.assign(over(pg), { calls });
}

describe("bootstrapOwner and applyRoles on Postgres", () => {
  let pg: PGlite;
  let db: Recorded;

  beforeEach(async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    pg = await PGlite.create();
    db = simpleProtocolDb(pg);
  });

  afterEach(async () => {
    await pg.close();
  });

  const attributesOf = async (role: string) =>
    (
      await pg.query(
        `SELECT rolsuper, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls
         FROM pg_roles WHERE rolname = $1`,
        [role],
      )
    ).rows[0];
  const passwordOf = async (role: string) =>
    (await pg.query<{ rolpassword: string | null }>("SELECT rolpassword FROM pg_authid WHERE rolname = $1", [role])).rows[0]?.rolpassword;
  const allowed = async (sql: string) => (await pg.query<{ ok: boolean }>(sql)).rows[0]?.ok;

  it("creates vasal_owner once with least privilege, a SCRAM verifier and CREATE on schema public", async () => {
    expect(await bootstrapOwner(db, OWNER_PASSWORD)).toEqual({ created: true });
    const firstVerifier = await passwordOf("vasal_owner");
    expect(await bootstrapOwner(db, OWNER_PASSWORD)).toEqual({ created: false });

    expect(await attributesOf("vasal_owner")).toEqual({
      rolsuper: false,
      rolcreaterole: true,
      rolcreatedb: false,
      rolcanlogin: true,
      rolreplication: false,
      rolbypassrls: false,
    });
    const verifier = await passwordOf("vasal_owner");
    expect(verifier).toMatch(SCRAM_VERIFIER);
    expect(verifier).not.toBe(firstVerifier);
    expect(db.calls.map((call) => call.text).join("\n")).not.toContain(OWNER_PASSWORD);
    expect(await allowed("SELECT has_schema_privilege('vasal_owner', 'public', 'USAGE, CREATE') AS ok")).toBe(true);
  });

  it("lets that owner migrate, then apply roles.sql twice as one batch each time", async () => {
    await bootstrapOwner(db, OWNER_PASSWORD);
    await pg.query("SET ROLE vasal_owner");
    await migrate(db);

    expect(await applyRoles(db, APP_PASSWORD)).toEqual({ created: true });
    expect(await applyRoles(db, APP_PASSWORD)).toEqual({ created: false });
    await pg.query("RESET ROLE");

    const owners = await pg.query<{ tableowner: string }>("SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'public'");
    expect(owners.rows).toEqual([{ tableowner: "vasal_owner" }]);
    const rolesSql = await readFile(ROLES_FILE, "utf8");
    expect(db.calls.filter((call) => call.text === rolesSql)).toEqual([
      { text: rolesSql, params: undefined },
      { text: rolesSql, params: undefined },
    ]);
    expect(db.calls.map((call) => call.text).join("\n")).not.toContain(APP_PASSWORD);
    expect(await attributesOf("vasal_app")).toEqual({
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolcanlogin: true,
      rolreplication: false,
      rolbypassrls: false,
    });
    expect(await passwordOf("vasal_app")).toMatch(SCRAM_VERIFIER);
    expect(await allowed("SELECT has_column_privilege('vasal_app', 'usage_buckets', 'used', 'UPDATE') AS ok")).toBe(true);
    expect(await allowed("SELECT has_column_privilege('vasal_app', 'usage_buckets', 'cap', 'UPDATE') AS ok")).toBe(false);
    expect(await allowed("SELECT has_table_privilege('vasal_app', 'runs', 'DELETE') AS ok")).toBe(false);
    expect(await allowed("SELECT has_table_privilege('vasal_app', 'app_flags', 'UPDATE') AS ok")).toBe(false);
    expect(await allowed("SELECT has_schema_privilege('vasal_app', 'public', 'CREATE') AS ok")).toBe(false);
  });

  it("refuses a role that already exists with more power, and changes nothing", async () => {
    await pg.query("CREATE ROLE vasal_owner WITH LOGIN SUPERUSER");
    await expect(bootstrapOwner(db, OWNER_PASSWORD)).rejects.toThrow(RoleSetupError);
    expect(await passwordOf("vasal_owner")).toBeNull();

    await pg.query("CREATE ROLE vasal_app WITH LOGIN CREATEDB");
    await migrate(db);
    await expect(applyRoles(db, APP_PASSWORD)).rejects.toThrow(RoleSetupError);
    expect(await passwordOf("vasal_app")).toBeNull();
    expect(await allowed("SELECT has_table_privilege('vasal_app', 'runs', 'SELECT') AS ok")).toBe(false);
  });

  it("refuses a password that is not 64 hex characters before sending anything", async () => {
    await expect(bootstrapOwner(db, "short")).rejects.toThrow(StoreError);
    await expect(applyRoles(db, `${APP_PASSWORD}'`)).rejects.toThrow(StoreError);
    expect(db.calls).toEqual([]);
  });
});
