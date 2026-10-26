// Covers migrate on PGlite for the brief claim status check: a fresh database
// and one made before deferred claims both end with the one check that allows
// 'deferred', and migrate runs again cleanly. It does not cover hosted
// Postgres (the hosted harness migrates there), running as the owner role
// (ops-db.test.ts), or any other table's schema.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPgliteDb, type Db } from "../src/store/db.js";
import { migrate } from "../src/store/migrate.js";

// run_brief_claims exactly as schema.sql made it before deferred claims.
const TABLE_BEFORE_DEFERRED = `CREATE TABLE run_brief_claims (
  run_id uuid NOT NULL REFERENCES runs (id),
  guest_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'failed', 'done')),
  attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 2),
  error_code text,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, guest_id)
)`;

let db: Db;

beforeEach(async () => {
  db = await createPgliteDb();
});

afterEach(async () => {
  await db.close();
});

async function checks(): Promise<string[]> {
  const { rows } = await db.query<{ name: string }>(
    "SELECT conname AS name FROM pg_constraint WHERE conrelid = 'run_brief_claims'::regclass AND contype = 'c' ORDER BY conname",
  );
  return rows.map((row) => row.name);
}

async function newRun(): Promise<string> {
  const id = randomUUID();
  await db.query("INSERT INTO runs (id, status, input, created_at) VALUES ($1::uuid, 'done', '{}'::json, now())", [id]);
  return id;
}

const insertClaim = (runId: string, status: string, code: string | null) =>
  db.query(
    `INSERT INTO run_brief_claims (run_id, guest_id, status, attempts, error_code, created_at)
     VALUES ($1::uuid, $2::uuid, $3, 1, $4, now())`,
    [runId, randomUUID(), status, code],
  );

describe("migrate and the brief claim status check", () => {
  it("gives a fresh database one status check that allows deferred, and runs again unchanged", async () => {
    await migrate(db);
    await migrate(db);

    expect(await checks()).toEqual(["run_brief_claims_attempts_check", "run_brief_claims_status_check"]);
    const runId = await newRun();
    await insertClaim(runId, "deferred", "MODEL_BUDGET");
    await expect(insertClaim(runId, "retrying", null)).rejects.toThrow();
  });

  it("moves a database made before deferred claims onto the new check, keeping its rows", async () => {
    await migrate(db);
    await db.query("DROP TABLE run_brief_claims");
    await db.query(TABLE_BEFORE_DEFERRED);
    // The name Postgres gave the old unnamed check is the one schema.sql drops.
    expect(await checks()).toEqual(["run_brief_claims_attempts_check", "run_brief_claims_status_check"]);
    const runId = await newRun();
    await insertClaim(runId, "failed", "MODEL_TIMEOUT");
    await expect(insertClaim(runId, "deferred", "MODEL_BUDGET")).rejects.toThrow();

    await migrate(db);
    await migrate(db);

    expect(await checks()).toEqual(["run_brief_claims_attempts_check", "run_brief_claims_status_check"]);
    await insertClaim(runId, "deferred", "MODEL_BUDGET");
    await expect(insertClaim(runId, "retrying", null)).rejects.toThrow();
    const { rows } = await db.query<{ status: string }>("SELECT status FROM run_brief_claims ORDER BY status");
    expect(rows).toEqual([{ status: "deferred" }, { status: "failed" }]);
  });
});
