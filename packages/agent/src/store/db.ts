import type { PGlite, Transaction } from "@electric-sql/pglite";
import ipaddr from "ipaddr.js";
import { Pool, type PoolClient, type PoolConfig, type QueryResult } from "pg";
import { StoreError } from "./errors.js";

/**
 * The one database surface every store module uses. Values only ever travel
 * as bound parameters in `params`; callers never put a value into `text`
 * (C6.6). Every driver failure surfaces as StoreError("STORE_UNAVAILABLE")
 * with no cause, because driver errors carry the query and its values.
 *
 * Inside `transaction`, run every statement on the `tx` handle, never on the
 * outer Db: PGlite has one connection and would wait on itself. Calling
 * `transaction` on a `tx` handle joins the outer transaction (no savepoints),
 * and `close` on a `tx` handle is refused.
 */
export interface Db {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const STATEMENT_TIMEOUT_MS = 5_000;
// pg waits forever for a connection by default, which would hang a run instead
// of failing it (fail closed, C5.7).
const CONNECT_TIMEOUT_MS = 5_000;
// A process frozen mid-transaction would otherwise hold meter row locks until
// its socket dies, and every other caller would queue behind it.
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 10_000;

const unavailable = (): StoreError => new StoreError("STORE_UNAVAILABLE");

async function guarded<R>(run: () => Promise<{ rows: unknown[] }>): Promise<{ rows: R[] }> {
  try {
    const result = await run();
    return { rows: result.rows as R[] };
  } catch {
    throw unavailable();
  }
}

/** A network createPgDb can be told it runs on. Each one changes the TLS rule for its own hosts only. */
export type DbNetwork = "railway-private";

const RAILWAY_PRIVATE_HOST_SUFFIX = ".railway.internal";

/** True only for a DbNetwork name, compared exactly. */
export function isDbNetwork(value: unknown): value is DbNetwork {
  return value === "railway-private";
}

function isLocalHost(hostname: string): boolean {
  if (hostname === "localhost") return true;
  try {
    return ipaddr.process(hostname).range() === "loopback";
  } catch {
    return false;
  }
}

function tlsFor(host: string, network: DbNetwork | undefined): PoolConfig["ssl"] {
  if (isLocalHost(host)) return false;
  // Railway's private network is WireGuard-encrypted between services, and
  // its Postgres certificate is signed by a CA made inside the container, so
  // full verification cannot pass there. TLS goes off only when the caller
  // names that network AND the host is one of its names; the URL alone can
  // never turn it off.
  if (network === "railway-private" && host.endsWith(RAILWAY_PRIVATE_HOST_SUFFIX)) return false;
  return { rejectUnauthorized: true };
}

// The pool is configured from explicit fields, never from `connectionString`:
// pg lets the parsed string override explicit options, so `?sslmode=disable`
// or `?host=` in the URL could otherwise switch TLS off or move the target.
// Query parameters in the URL are therefore ignored on purpose.
/**
 * Turns a postgres URL into the pool settings createPgDb uses. TLS is off for
 * localhost and loopback addresses, off for a host ending in
 * .railway.internal when `network` is "railway-private", and on with
 * certificate checks for everything else. Throws
 * StoreError("STORE_BAD_INPUT") for a string that is not a postgres URL with a
 * host, or a network that is not a DbNetwork; the message never contains the
 * string.
 */
export function poolConfigFrom(connectionString: string, network?: DbNetwork): PoolConfig {
  if (network !== undefined && !isDbNetwork(network)) throw new StoreError("STORE_BAD_INPUT");
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new StoreError("STORE_BAD_INPUT");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new StoreError("STORE_BAD_INPUT");
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const port = url.port === "" ? 5432 : Number(url.port);
  if (host === "" || !Number.isInteger(port)) throw new StoreError("STORE_BAD_INPUT");

  let user: string;
  let password: string;
  let database: string;
  try {
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  } catch {
    throw new StoreError("STORE_BAD_INPUT");
  }
  // pg fills an empty user from the PGUSER environment variable, and tools
  // such as `railway run` set PGUSER to the database superuser. A URL with no
  // user could then connect with full power, so it is refused instead.
  if (user === "") throw new StoreError("STORE_BAD_INPUT");

  return {
    host,
    port,
    user,
    password,
    database,
    ssl: tlsFor(host, network),
    statement_timeout: STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  };
}

function pgClientDb(client: PoolClient): Db {
  const self: Db = {
    query: <R>(text: string, params?: unknown[]) =>
      guarded<R>(() => client.query(text, params) as Promise<QueryResult>),
    transaction: (fn) => fn(self),
    close: () => Promise.reject(new StoreError("STORE_BAD_INPUT")),
  };
  return self;
}

/**
 * Opens a pg pool for hosted Postgres. TLS with certificate checks is required
 * unless the host is localhost or a loopback address, or `opts.network` is
 * "railway-private" and the host ends in .railway.internal (see
 * poolConfigFrom). The network only ever comes from `opts`, never from the
 * URL. Each connection starts with statement_timeout 5000 ms, a 5 s connect
 * timeout and a 10 s idle in transaction timeout. A query with no params is
 * sent with pg's simple protocol, so it may hold several statements. Throws
 * StoreError("STORE_BAD_INPUT") if the string is not a postgres URL with a
 * host or the network is unknown; the message never contains the string.
 */
export function createPgDb(connectionString: string, opts: { network?: DbNetwork } = {}): Db {
  const pool = new Pool(poolConfigFrom(connectionString, opts.network));
  // pg emits idle client failures on the pool, and an "error" event with no
  // listener exits the whole process. The next query reports the failure.
  pool.on("error", () => {});

  return {
    query: <R>(text: string, params?: unknown[]) =>
      guarded<R>(() => pool.query(text, params) as Promise<QueryResult>),

    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      let client: PoolClient;
      try {
        client = await pool.connect();
      } catch {
        throw unavailable();
      }
      let discard = false;
      try {
        await guarded(() => client.query("BEGIN"));
        const result = await fn(pgClientDb(client));
        await guarded(() => client.query("COMMIT"));
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          discard = true;
        }
        throw error;
      } finally {
        client.release(discard);
      }
    },

    async close(): Promise<void> {
      try {
        await pool.end();
      } catch {
        throw unavailable();
      }
    },
  };
}

function pgliteTxDb(tx: Transaction): Db {
  const self: Db = {
    query: <R>(text: string, params?: unknown[]) => guarded<R>(() => tx.query(text, params)),
    transaction: (fn) => fn(self),
    close: () => Promise.reject(new StoreError("STORE_BAD_INPUT")),
  };
  return self;
}

/**
 * Opens an in-memory PGlite database for tests and local development. It runs
 * one connection, so concurrent callers are serialised rather than raced.
 * Throws StoreError("STORE_UNAVAILABLE") if PGlite cannot start.
 */
export async function createPgliteDb(): Promise<Db> {
  let pg: PGlite;
  try {
    // Loaded on demand because PGlite is a dev dependency: a production
    // install without it must still be able to import this module.
    const { PGlite } = await import("@electric-sql/pglite");
    pg = await PGlite.create();
  } catch {
    throw unavailable();
  }

  return {
    query: <R>(text: string, params?: unknown[]) => guarded<R>(() => pg.query(text, params)),

    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      // PGlite rolls back and rethrows whatever fn threw. Only failures of its
      // own BEGIN or COMMIT are driver errors that need hiding.
      let thrownByFn: { error: unknown } | undefined;
      try {
        return await pg.transaction(async (tx) => {
          try {
            return await fn(pgliteTxDb(tx));
          } catch (error) {
            thrownByFn = { error };
            throw error;
          }
        });
      } catch (error) {
        if (thrownByFn) throw thrownByFn.error;
        throw unavailable();
      }
    },

    async close(): Promise<void> {
      try {
        await pg.close();
      } catch {
        throw unavailable();
      }
    },
  };
}
