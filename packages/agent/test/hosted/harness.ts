// Shared setup for the hosted race tests. It proves that the caps and the
// "only one wins" claims hold as atomic SQL when 50 real connections hit them
// at the same moment, on the Postgres major version Railway runs, which
// PGlite's single connection cannot show. It does not prove roles and grants
// (it runs as whatever user the URL names), behaviour under a network
// partition, or anything across more than one database.
//
// freshSchema empties Vasal's tables, so it only ever runs against a
// throwaway database: both HOSTED_TEST_DATABASE_URL and
// HOSTED_TEST_THROWAWAY=yes must be set, and it refuses a database holding
// any table schema.sql does not create or any run this file did not create.
// HOSTED_TEST_DATABASE_NETWORK=railway-private lets the races run next to a
// Railway database, where a round trip is about a millisecond; across a slow
// tunnel, 50 queued lock holders pass the 5 s statement timeout. Run the
// hosted files one at a time (vitest --no-file-parallelism): each opens 51
// connections, and two at once pass Postgres's default limit of 100.
import { readFileSync } from "node:fs";
import { createPgDb, isDbNetwork, type Db } from "../../src/store/db.js";
import { migrate } from "../../src/store/migrate.js";

const databaseUrl = process.env.HOSTED_TEST_DATABASE_URL;
const network = isDbNetwork(process.env.HOSTED_TEST_DATABASE_NETWORK) ? process.env.HOSTED_TEST_DATABASE_NETWORK : undefined;

// The only tables freshSchema may ever empty: the ones schema.sql creates.
const SCHEMA_TABLES: ReadonlySet<string> = new Set(
  [...readFileSync(new URL("../../src/store/schema.sql", import.meta.url), "utf8").matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(
    (match) => match[1] ?? "",
  ),
);

/** The throwaway database URL, or undefined unless both environment variables are set. */
export const HOSTED_URL: string | undefined =
  process.env.HOSTED_TEST_THROWAWAY === "yes" && databaseUrl !== undefined && databaseUrl !== "" ? databaseUrl : undefined;

/** How many separate connections every race uses. */
export const CONTENDERS = 50;

const REFUSAL = "refusing: this database already holds runs; point HOSTED_TEST_DATABASE_URL at a throwaway database";

const createdRuns = new Set<string>();

/** Records a run this file created, so freshSchema's guard never mistakes it for real data. Returns the id. */
export function trackRun(id: string): string {
  createdRuns.add(id);
  return id;
}

/**
 * Opens `n` separate createPgDb pools on HOSTED_URL, each warmed with SELECT 1
 * so its connection exists before any race. Throws when HOSTED_URL is unset,
 * and closes every pool it opened if any warm-up fails.
 */
export async function openContenders(n: number): Promise<Db[]> {
  if (HOSTED_URL === undefined) throw new Error("HOSTED_TEST_DATABASE_URL and HOSTED_TEST_THROWAWAY=yes are both needed");
  if (!Number.isSafeInteger(n) || n < 1) throw new Error("openContenders needs a whole number of at least 1");
  const url = HOSTED_URL;
  const dbs = Array.from({ length: n }, () => createPgDb(url, network === undefined ? {} : { network }));
  try {
    await Promise.all(dbs.map((db) => db.query("SELECT 1")));
  } catch (error) {
    await Promise.allSettled(dbs.map((db) => db.close()));
    throw error;
  }
  return dbs;
}

/**
 * Calls fn once per Db, every call started in the same tick after one shared
 * promise resolves, and waits for all of them. A rejection is kept as
 * { ok: false } in its place, so one failure never hides the other results.
 */
export async function race<T>(
  dbs: Db[],
  fn: (db: Db, i: number) => Promise<T>,
): Promise<Array<{ ok: true; value: T } | { ok: false; error: unknown }>> {
  // pg drops a connection left idle for 10 seconds, and reopening one inside
  // the race would stagger the start, so every contender is woken first.
  await Promise.all(dbs.map((db) => db.query("SELECT 1")));
  let open = (): void => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const runs = dbs.map((db, i) =>
    gate
      .then(() => fn(db, i))
      .then(
        (value): { ok: true; value: T } => ({ ok: true, value }),
        (error: unknown): { ok: false; error: unknown } => ({ ok: false, error }),
      ),
  );
  open();
  return Promise.all(runs);
}

/**
 * Gives every test the database a fresh migrate gives. First the guards,
 * which throw before changing anything: public must hold no table schema.sql
 * does not create, and when public.runs exists it must hold no run id
 * trackRun was not given. Then it applies the schema, truncates only
 * schema.sql's own tables with RESTART IDENTITY CASCADE, and applies the
 * schema once more.
 */
export async function freshSchema(admin: Db): Promise<void> {
  const { rows: tables } = await admin.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
  const strangers = tables.map((row) => row.tablename).filter((name) => !SCHEMA_TABLES.has(name));
  if (SCHEMA_TABLES.size === 0 || strangers.length > 0) {
    throw new Error("refusing: this database holds tables Vasal's schema does not create; point HOSTED_TEST_DATABASE_URL at a throwaway database");
  }
  const { rows: found } = await admin.query<{ present: boolean }>(
    "SELECT to_regclass('public.runs') IS NOT NULL AS present",
  );
  if (found[0]?.present !== false) {
    const { rows: foreign } = await admin.query("SELECT 1 FROM public.runs WHERE id::text <> ALL ($1::text[]) LIMIT 1", [
      [...createdRuns],
    ]);
    if (foreign.length > 0) throw new Error(REFUSAL);
  }

  await migrate(admin);
  // A table name cannot be a bound parameter, so Postgres quotes each one
  // itself with format('%I').
  const { rows } = await admin.query<{ names: string | null }>(
    "SELECT string_agg(format('%I.%I', schemaname, tablename), ', ') AS names FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY ($1::text[])",
    [[...SCHEMA_TABLES]],
  );
  const names = rows[0]?.names;
  if (typeof names === "string" && names !== "") await admin.query(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
  // The truncate also removes the inflight rows schema.sql seeds, which the
  // app can only update and never create, so the schema goes on again.
  await migrate(admin);
}
