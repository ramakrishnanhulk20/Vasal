import { readFile } from "node:fs/promises";
import type { Db } from "./db.js";
import { StoreError } from "./errors.js";

const SCHEMA_FILE = new URL("./schema.sql", import.meta.url);

// The extended query protocol that bound parameters need runs one statement
// per call, so the file is split here. This only works because schema.sql is
// our own file: it has no semicolons inside strings, bodies or comments
// once the comment lines are dropped.
function statementsOf(sql: string): string[] {
  return sql
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");
}

/**
 * Applies schema.sql in one transaction. Safe to run repeatedly: every
 * statement is CREATE ... IF NOT EXISTS. Needs a role that can create tables,
 * so in production the operator runs it as the database owner, not as
 * vasal_app. Throws StoreError("STORE_UNAVAILABLE") if the file cannot be read
 * or any statement fails, in which case nothing is applied.
 */
export async function migrate(db: Db): Promise<void> {
  let sql: string;
  try {
    sql = await readFile(SCHEMA_FILE, "utf8");
  } catch {
    throw new StoreError("STORE_UNAVAILABLE");
  }
  const statements = statementsOf(sql);
  await db.transaction(async (tx) => {
    for (const statement of statements) {
      await tx.query(statement);
    }
  });
}
