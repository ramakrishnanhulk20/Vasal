import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createPgDb, createPgliteDb, isDbNetwork, type Db, type DbNetwork } from "../store/db.js";
import { StoreError } from "../store/errors.js";
import { setFlag } from "../store/flags.js";
import { migrate } from "../store/migrate.js";
import { rolePasswordSql, scramVerifier, type PasswordRole } from "../store/scram.js";

const REPO_ROOT_ENV_FILE = fileURLToPath(new URL("../../../../.env", import.meta.url));
/** The app role and its grants, applied by applyRoles and printed by `ops roles`. */
export const ROLES_FILE = fileURLToPath(new URL("../store/roles.sql", import.meta.url));

const HEX_PASSWORD = /^[0-9a-f]{64}$/;
const PORT_TEXT = /^[0-9]{1,5}$/;
// A tunnel ends on this machine, so the connection is loopback and createPgDb
// sends it without TLS; the tunnel itself carries the encryption.
const TUNNEL_HOST = "127.0.0.1";

/** Thrown when a setting an ops command needs is missing. The message names the variable, never a value. */
export class OpsConfigError extends Error {
  override readonly name = "OpsConfigError";
}

/** Thrown when a role already exists with attributes other than the ones the scripts create. The message is fixed text. */
export class RoleSetupError extends Error {
  override readonly name = "RoleSetupError";
}

/**
 * Loads the repo-root .env into process.env when the file exists. Values
 * already set in the environment win over the file.
 */
export function loadRepoEnv(): void {
  if (existsSync(REPO_ROOT_ENV_FILE)) process.loadEnvFile(REPO_ROOT_ENV_FILE);
}

/**
 * Reads DATABASE_NETWORK the way the server config does: unset or blank is no
 * network, and "railway-private" is that network. Throws OpsConfigError for
 * anything else; the message names the variable, never its value.
 */
export function databaseNetworkFrom(env: NodeJS.ProcessEnv): { network?: DbNetwork } {
  const text = env["DATABASE_NETWORK"]?.trim() ?? "";
  if (text === "") return {};
  if (!isDbNetwork(text)) throw new OpsConfigError("DATABASE_NETWORK must be railway-private, or unset.");
  return { network: text };
}

/**
 * Reads a role password the ops scripts set: exactly 64 lower-case hex
 * characters, as 32 random bytes print. Throws OpsConfigError naming the
 * variable, never its value, for anything else.
 */
export function hexPasswordFrom(env: NodeJS.ProcessEnv, variable: "VASAL_OWNER_PASSWORD" | "VASAL_APP_PASSWORD"): string {
  const value = env[variable];
  if (typeof value !== "string" || !HEX_PASSWORD.test(value)) {
    throw new OpsConfigError(`${variable} must be 64 lower-case hex characters: 32 random bytes written in hex.`);
  }
  return value;
}

function checkPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new OpsConfigError("--tunnel needs a port from 1 to 65535.");
  return port;
}

/** Reads the --tunnel value: digits only, 1 to 65535. Throws OpsConfigError for anything else. */
export function tunnelPortFrom(text: string): number {
  return checkPort(PORT_TEXT.test(text) ? Number(text) : Number.NaN);
}

function requiredText(env: NodeJS.ProcessEnv, variable: string, purpose: string): string {
  const value = env[variable];
  if (typeof value !== "string" || value.trim() === "") throw new OpsConfigError(`${variable} is not set. ${purpose}`);
  return value.trim();
}

// Each part is percent-encoded so any character in a password survives
// poolConfigFrom's decodeURIComponent unchanged.
function tunnelUrl(user: string, password: string, port: number, database: string): string {
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${TUNNEL_HOST}:${checkPort(port)}/${encodeURIComponent(database)}`;
}

/**
 * Opens the database owner connection with createPgDb, for the jobs the app
 * role vasal_app is not allowed to do: migrating, setting caps and flags,
 * pruning and setting up the app role (C6.6). The connection comes from
 * OWNER_DATABASE_URL, or with `opts.tunnelPort` it is vasal_owner with
 * VASAL_OWNER_PASSWORD on 127.0.0.1:<port> to the database PGDATABASE.
 * DATABASE_NETWORK is passed on as createPgDb's network. When `env` is the
 * real process environment, the repo-root .env is loaded first. Throws
 * OpsConfigError when a needed variable is unset, blank or malformed;
 * DATABASE_URL is never used in its place, because that is the app role.
 * Throws StoreError("STORE_BAD_INPUT") for a string that is not a postgres
 * URL with a host, and that error never repeats the string.
 */
export function openOwnerDb(env: NodeJS.ProcessEnv = process.env, opts: { tunnelPort?: number } = {}): Db {
  if (env === process.env) loadRepoEnv();
  const network = databaseNetworkFrom(env);
  if (opts.tunnelPort !== undefined) {
    const password = hexPasswordFrom(env, "VASAL_OWNER_PASSWORD");
    const database = requiredText(env, "PGDATABASE", "--tunnel needs the database name in PGDATABASE.");
    return createPgDb(tunnelUrl("vasal_owner", password, opts.tunnelPort, database), network);
  }
  const url = env["OWNER_DATABASE_URL"];
  if (typeof url !== "string" || url.trim() === "") {
    throw new OpsConfigError(
      "OWNER_DATABASE_URL is not set. Put the database owner's connection string in .env, or use --dev for a throwaway local database.",
    );
  }
  return createPgDb(url.trim(), network);
}

/**
 * Opens the database superuser connection that `ops bootstrap` alone uses,
 * from BOOTSTRAP_DATABASE_URL, or with `opts.tunnelPort` as PGUSER with
 * PGPASSWORD on 127.0.0.1:<port> to the database PGDATABASE. DATABASE_NETWORK
 * applies as for the owner. Loads the repo-root .env first for the real
 * process environment. Throws OpsConfigError naming the first missing
 * variable, and StoreError("STORE_BAD_INPUT") for a malformed URL; neither
 * message holds a value.
 */
export function openBootstrapDb(env: NodeJS.ProcessEnv = process.env, opts: { tunnelPort?: number } = {}): Db {
  if (env === process.env) loadRepoEnv();
  const network = databaseNetworkFrom(env);
  if (opts.tunnelPort !== undefined) {
    const purpose = "--tunnel needs the superuser's PGUSER, PGPASSWORD and PGDATABASE.";
    const user = requiredText(env, "PGUSER", purpose);
    const password = requiredText(env, "PGPASSWORD", purpose);
    const database = requiredText(env, "PGDATABASE", purpose);
    return createPgDb(tunnelUrl(user, password, opts.tunnelPort, database), network);
  }
  const url = requiredText(
    env,
    "BOOTSTRAP_DATABASE_URL",
    "Give the database superuser's connection string for this one command, or use --tunnel <port>.",
  );
  return createPgDb(url, network);
}

const roleAttributes = z.object({
  rolsuper: z.boolean(),
  rolcreaterole: z.boolean(),
  rolcreatedb: z.boolean(),
  rolcanlogin: z.boolean(),
  rolreplication: z.boolean(),
  rolbypassrls: z.boolean(),
});
type RoleAttributes = z.output<typeof roleAttributes>;

const OWNER_ATTRIBUTES: RoleAttributes = {
  rolsuper: false,
  rolcreaterole: true,
  rolcreatedb: false,
  rolcanlogin: true,
  rolreplication: false,
  rolbypassrls: false,
};
const APP_ATTRIBUTES: RoleAttributes = { ...OWNER_ATTRIBUTES, rolcreaterole: false };

async function roleExists(db: Db, role: PasswordRole): Promise<boolean> {
  const { rows } = await db.query("SELECT 1 AS present FROM pg_roles WHERE rolname = $1", [role]);
  return rows.length > 0;
}

// A role made some other way may hold more than the scripts give it, such as
// SUPERUSER. Setting its password would hand that power on, so the whole
// transaction is refused instead.
async function checkAttributes(db: Db, role: PasswordRole, wanted: RoleAttributes): Promise<void> {
  const { rows } = await db.query(
    `SELECT rolsuper, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls
     FROM pg_roles WHERE rolname = $1`,
    [role],
  );
  const parsed = roleAttributes.safeParse(rows[0]);
  const matches = parsed.success && (Object.keys(wanted) as Array<keyof RoleAttributes>).every((key) => parsed.data[key] === wanted[key]);
  if (!matches) {
    throw new RoleSetupError(
      `The role ${role} already exists with attributes other than the ones the scripts give it. Fix or drop it by hand, then run this again.`,
    );
  }
}

/**
 * Run once as the database superuser. In one transaction: creates the role
 * vasal_owner WITH LOGIN NOSUPERUSER CREATEROLE NOCREATEDB NOREPLICATION
 * NOBYPASSRLS if it does not exist, checks an existing one has exactly those
 * attributes, sets its password as a SCRAM verifier of `password` built here,
 * and grants it USAGE and CREATE on schema public. Running it again only
 * sets the password again. Returns whether the role was created. Throws
 * StoreError("STORE_BAD_INPUT") for a password that is not 64 lower-case
 * hex characters, RoleSetupError for an existing role with other attributes,
 * and StoreError("STORE_UNAVAILABLE") if the database refuses; nothing is
 * changed then.
 */
export async function bootstrapOwner(db: Db, password: string): Promise<{ created: boolean }> {
  if (!HEX_PASSWORD.test(password)) throw new StoreError("STORE_BAD_INPUT");
  const setPassword = rolePasswordSql("vasal_owner", scramVerifier(password));
  return db.transaction(async (tx) => {
    const existed = await roleExists(tx, "vasal_owner");
    await tx.query(`DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'vasal_owner') THEN
    CREATE ROLE vasal_owner WITH LOGIN NOSUPERUSER CREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$`);
    await checkAttributes(tx, "vasal_owner", OWNER_ATTRIBUTES);
    await tx.query(setPassword);
    await tx.query("GRANT USAGE, CREATE ON SCHEMA public TO vasal_owner");
    return { created: !existed };
  });
}

/**
 * Run as the owner role, after migrate. In one transaction: sends roles.sql
 * as a single query with no parameters, which pg runs with its simple
 * protocol so the file's statements go as one batch; checks vasal_app has
 * exactly the attributes the file gives it; then sets its password as a
 * SCRAM verifier of `password` built here, so the password never reaches the
 * server. Safe to run again. Returns whether vasal_app was created. Throws
 * StoreError("STORE_BAD_INPUT") for a password that is not 64 lower-case hex
 * characters, RoleSetupError for an existing vasal_app with other
 * attributes, and StoreError("STORE_UNAVAILABLE") if the file cannot be read
 * or the database refuses; nothing is changed then.
 */
export async function applyRoles(db: Db, password: string): Promise<{ created: boolean }> {
  if (!HEX_PASSWORD.test(password)) throw new StoreError("STORE_BAD_INPUT");
  const setPassword = rolePasswordSql("vasal_app", scramVerifier(password));
  let sql: string;
  try {
    sql = await readFile(ROLES_FILE, "utf8");
  } catch {
    throw new StoreError("STORE_UNAVAILABLE");
  }
  return db.transaction(async (tx) => {
    const existed = await roleExists(tx, "vasal_app");
    await tx.query(sql);
    await checkAttributes(tx, "vasal_app", APP_ATTRIBUTES);
    await tx.query(setPassword);
    return { created: !existed };
  });
}

/**
 * Opens a throwaway in-memory PGlite database with the schema applied and
 * live runs on, the same starting point as the development server, so ops
 * commands can be tried with no hosted database. Everything in it is lost
 * when the process ends. Throws StoreError("STORE_UNAVAILABLE") if PGlite
 * cannot start or the schema cannot be applied.
 */
export async function openDevDb(): Promise<Db> {
  const db = await createPgliteDb();
  try {
    await migrate(db);
    await setFlag(db, "live_runs", true);
  } catch (error) {
    await db.close().catch(() => {});
    throw error;
  }
  return db;
}
