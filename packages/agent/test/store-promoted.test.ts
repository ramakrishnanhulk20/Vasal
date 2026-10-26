// Covers the showcase lock in schema.sql on PGlite, with the tables owned by
// an ordinary owner role and vasal_app made by roles.sql: the app role
// cannot insert, update or delete any row of a promoted run in the six run
// tables (SQLSTATE P0001), the same writes go through on a run that is not
// promoted, the owner can still change a promoted run, a temporary table
// cannot stand in for the showcase, and migrate stays re-runnable. It does
// not cover hosted Postgres (the hosted harness migrates there), the store
// functions that make these writes (server-runs.test.ts), the routes that
// refuse a promoted run before the database is reached (server-app.test.ts),
// or TRUNCATE, which no row trigger sees and the app role is not granted.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/store/db.js";
import { migrate } from "../src/store/migrate.js";

const ROLES_FILE = new URL("../src/store/roles.sql", import.meta.url);
const REFUSED = "refused";
const MESSAGE = "A run on the showcase is read-only to the app role.";
const RUN_TABLES = ["runs", "run_events", "run_candidates", "run_board", "run_briefs", "run_brief_claims"];

type Write = { label: string; text: string; params: unknown[] };

let pg: PGlite;
let db: Db;

// The store's own PGlite Db hides every driver error, SQLSTATE included, so
// migrate runs through this one, which passes errors on unchanged.
function rawDb(conn: PGlite | Transaction): Db {
  const self: Db = {
    query: async <R>(text: string, params?: unknown[]) => ({ rows: (await conn.query<R>(text, params)).rows }),
    transaction: <T>(fn: (tx: Db) => Promise<T>) =>
      "transaction" in conn ? conn.transaction((tx) => fn(rawDb(tx))) : fn(self),
    close: () => Promise.reject(new Error("not closed here")),
  };
  return self;
}

async function as<T>(role: "vasal_app" | "vasal_owner", work: () => Promise<T>): Promise<T> {
  await pg.query(`SET ROLE ${role}`);
  try {
    return await work();
  } finally {
    await pg.query("RESET ROLE");
  }
}

beforeEach(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  pg = await PGlite.create();
  db = rawDb(pg);
  // An ordinary owner, as in production, so no write below passes for being
  // made by a superuser.
  await pg.exec("CREATE ROLE vasal_owner WITH NOLOGIN CREATEROLE; GRANT CREATE ON SCHEMA public TO vasal_owner;");
  const roles = await readFile(ROLES_FILE, "utf8");
  await as("vasal_owner", async () => {
    await migrate(db);
    await pg.exec(roles);
  });
});

afterEach(async () => {
  await pg.close();
});

// Every write a run's rows can take, for one run. Updates touch only the
// columns roles.sql lets the app move on runs and run_brief_claims, and
// deletes go children first, because they point at the run.
function writesFor(runId: string): { inserts: Write[]; updates: Write[]; deletes: Write[] } {
  const candidate = randomUUID();
  const guest = randomUUID();
  const write = (label: string, text: string, params: unknown[] = [runId]): Write => ({ label, text, params });
  return {
    inserts: [
      write("insert runs", "INSERT INTO runs (id, status, input, created_at) VALUES ($1::uuid, 'done', '{}'::json, now())"),
      write(
        "insert run_events",
        "INSERT INTO run_events (run_id, seq, event, data, created_at) VALUES ($1::uuid, 1, 'done', '{}'::json, now())",
      ),
      write(
        "insert run_candidates",
        "INSERT INTO run_candidates (run_id, candidate_id, rank, data) VALUES ($1::uuid, $2::uuid, 1, '{}'::json)",
        [runId, candidate],
      ),
      write("insert run_board", "INSERT INTO run_board (run_id, guest_id, rank, data) VALUES ($1::uuid, $2::uuid, 1, '{}'::json)", [
        runId,
        guest,
      ]),
      write(
        "insert run_briefs",
        "INSERT INTO run_briefs (run_id, guest_id, data, created_at) VALUES ($1::uuid, $2::uuid, '{}'::json, now())",
        [runId, guest],
      ),
      write(
        "insert run_brief_claims",
        `INSERT INTO run_brief_claims (run_id, guest_id, status, attempts, error_code, created_at)
         VALUES ($1::uuid, $2::uuid, 'done', 1, NULL, now())`,
        [runId, guest],
      ),
    ],
    updates: [
      write("update runs", "UPDATE runs SET status = 'failed', error_code = 'TEST_CODE', finished_at = now() WHERE id = $1::uuid"),
      write("update run_events", "UPDATE run_events SET event = 'failed' WHERE run_id = $1::uuid"),
      write("update run_candidates", "UPDATE run_candidates SET rank = 2 WHERE run_id = $1::uuid"),
      write("update run_board", "UPDATE run_board SET rank = 2 WHERE run_id = $1::uuid"),
      write("update run_briefs", `UPDATE run_briefs SET data = '{"edited":true}'::json WHERE run_id = $1::uuid`),
      write(
        "update run_brief_claims",
        "UPDATE run_brief_claims SET status = 'failed', error_code = 'MODEL_TIMEOUT' WHERE run_id = $1::uuid",
      ),
    ],
    deletes: [
      write("delete run_events", "DELETE FROM run_events WHERE run_id = $1::uuid"),
      write("delete run_candidates", "DELETE FROM run_candidates WHERE run_id = $1::uuid"),
      write("delete run_board", "DELETE FROM run_board WHERE run_id = $1::uuid"),
      write("delete run_briefs", "DELETE FROM run_briefs WHERE run_id = $1::uuid"),
      write("delete run_brief_claims", "DELETE FROM run_brief_claims WHERE run_id = $1::uuid"),
      write("delete runs", "DELETE FROM runs WHERE id = $1::uuid"),
    ],
  };
}

const allOf = (writes: ReturnType<typeof writesFor>): Write[] => [...writes.inserts, ...writes.updates, ...writes.deletes];

// "refused" only for the trigger's own code and fixed message, so a refusal
// by a grant, a key or a check shows up as itself.
async function outcomeOf(write: Write): Promise<string> {
  try {
    const result = await pg.query(write.text, write.params);
    return `rows ${result.affectedRows ?? 0}`;
  } catch (error) {
    const { code, message } = error as { code?: string; message?: string };
    return code === "P0001" && message === MESSAGE ? REFUSED : `${code ?? "no code"} ${message ?? ""}`;
  }
}

async function outcomesOf(writes: Write[]): Promise<Array<[string, string]>> {
  const outcomes: Array<[string, string]> = [];
  for (const write of writes) outcomes.push([write.label, await outcomeOf(write)]);
  return outcomes;
}

async function runAll(writes: Write[]): Promise<void> {
  for (const write of writes) await pg.query(write.text, write.params);
}

const promote = (runId: string, position: number) =>
  as("vasal_owner", () =>
    pg.query("INSERT INTO showcase_runs (run_id, position, promoted_at) VALUES ($1::uuid, $2, now())", [runId, position]),
  );

// roles.sql grants no DELETE on any run table and UPDATE on only a few
// columns, so under it most of these writes would stop at the grant before
// the trigger ran. With every grant the trigger has to refuse on its own, as
// it must if a grant is ever widened by mistake.
const grantAppEverything = () =>
  as("vasal_owner", () => pg.exec(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${RUN_TABLES.join(", ")} TO vasal_app`));

async function rowsOf(runId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of RUN_TABLES) {
    const key = table === "runs" ? "id" : "run_id";
    const { rows } = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${key} = $1::uuid`, [runId]);
    counts[table] = rows[0]!.n;
  }
  return counts;
}

const oneEach = Object.fromEntries(RUN_TABLES.map((table) => [table, 1]));

describe("the showcase lock on the app role (C6.6)", () => {
  it("refuses the app role every insert, update and delete on a promoted run's rows, even with every grant", async () => {
    await grantAppEverything();
    const shown = randomUUID();
    const writes = writesFor(shown);
    await as("vasal_app", () => runAll(writes.inserts));
    await promote(shown, 1);

    const outcomes = await as("vasal_app", () => outcomesOf(allOf(writes)));

    expect(outcomes).toEqual(allOf(writes).map((write) => [write.label, REFUSED]));
    expect(await rowsOf(shown)).toEqual(oneEach);
    const { rows } = await pg.query<{ status: string }>("SELECT status FROM runs WHERE id = $1::uuid", [shown]);
    expect(rows).toEqual([{ status: "done" }]);
  });

  it("refuses moving a row off a promoted run or onto one", async () => {
    await grantAppEverything();
    const shown = randomUUID();
    const other = writesFor(randomUUID());
    const spare = writesFor(randomUUID());
    await as("vasal_app", async () => {
      await runAll(writesFor(shown).inserts);
      await runAll([other.inserts[0]!, other.inserts[3]!, spare.inserts[0]!]);
    });
    await promote(shown, 1);
    const move = (label: string, from: string, to: string): Write => ({
      label,
      text: "UPDATE run_board SET run_id = $2::uuid WHERE run_id = $1::uuid",
      params: [from, to],
    });
    const [otherId, spareId] = [other.inserts[0]!.params[0] as string, spare.inserts[0]!.params[0] as string];

    expect(
      await as("vasal_app", () =>
        outcomesOf([move("off", shown, otherId), move("onto", otherId, shown), move("between two others", otherId, spareId)]),
      ),
    ).toEqual([
      ["off", REFUSED],
      ["onto", REFUSED],
      ["between two others", "rows 1"],
    ]);
  });

  it("lets the app role make the same writes on a run that is not promoted", async () => {
    await grantAppEverything();
    const shown = randomUUID();
    await as("vasal_owner", () => runAll(writesFor(shown).inserts));
    await promote(shown, 1);
    const writes = writesFor(randomUUID());

    const outcomes = await as("vasal_app", () => outcomesOf(allOf(writes)));

    expect(outcomes).toEqual(allOf(writes).map((write) => [write.label, "rows 1"]));
  });

  it("under roles.sql's own grants lets the app fill a run, then refuses it the writes it is granted once the run is promoted", async () => {
    const shown = randomUUID();
    const writes = writesFor(shown);
    const granted = [writes.updates[0]!, writes.updates[5]!];

    await as("vasal_app", async () => {
      await runAll(writes.inserts);
      await runAll(granted);
    });
    await promote(shown, 1);

    expect(await as("vasal_app", () => outcomesOf([...writes.inserts, ...granted]))).toEqual(
      [...writes.inserts, ...granted].map((write) => [write.label, REFUSED]),
    );
  });

  it("lets the owner still change a promoted run", async () => {
    const shown = randomUUID();
    const writes = writesFor(shown);
    await as("vasal_app", () => runAll(writes.inserts));
    await promote(shown, 1);

    const outcomes = await as("vasal_owner", () => outcomesOf(writes.updates));

    expect(outcomes).toEqual(writes.updates.map((write) => [write.label, "rows 1"]));
  });

  it("does not let a temporary table called showcase_runs stand in for the showcase", async () => {
    const shown = randomUUID();
    const writes = writesFor(shown);
    await as("vasal_app", () => runAll(writes.inserts));
    await promote(shown, 1);

    const [shadowed, outcome] = await as("vasal_app", async () => {
      await pg.exec("CREATE TEMP TABLE showcase_runs (run_id uuid)");
      // The app's own unqualified read now finds the empty stand-in.
      const { rows } = await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM showcase_runs");
      return [rows[0]!.n, await outcomeOf(writes.updates[0]!)] as const;
    });

    expect(shadowed).toBe(0);
    expect(outcome).toBe(REFUSED);
  });

  it("runs the schema again twice with one trigger on each run table, still refusing", async () => {
    const shown = randomUUID();
    const writes = writesFor(shown);
    await as("vasal_app", () => runAll(writes.inserts));
    await promote(shown, 1);

    await as("vasal_owner", async () => {
      await migrate(db);
      await migrate(db);
    });

    const { rows: triggers } = await pg.query<{ relname: string }>(
      `SELECT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE t.tgname = 'refuse_promoted_write' AND NOT t.tgisinternal ORDER BY c.relname`,
    );
    expect(triggers.map((row) => row.relname)).toEqual([...RUN_TABLES].sort());
    const { rows: functions } = await pg.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'refuse_promoted_write'",
    );
    expect(functions).toEqual([{ n: 1 }]);
    expect(await as("vasal_app", () => outcomeOf(writes.updates[0]!))).toBe(REFUSED);
    expect(await rowsOf(shown)).toEqual(oneEach);
  });
});
