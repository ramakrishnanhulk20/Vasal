import { readFile } from "node:fs/promises";
import type { Db } from "./db.js";
import { StoreError } from "./errors.js";

const SCHEMA_FILE = new URL("./schema.sql", import.meta.url);

// A quoted string, a dollar-quoted function body, or a semicolon. Matching the
// quoted parts whole means a semicolon inside one is never taken as the end
// of a statement.
const STATEMENT_PARTS = /'(?:[^']|'')*'|\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$|;/g;

// The extended query protocol that bound parameters need runs one statement
// per call, so the file is split here. Comment lines are dropped first, so a
// quote or semicolon in a comment never counts. This only works because
// schema.sql is our own file: it has no comment after code on the same line,
// which would be kept and could hold a stray quote.
function statementsOf(sql: string): string[] {
  const text = sql
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  const statements: string[] = [];
  let start = 0;
  for (const part of text.matchAll(STATEMENT_PARTS)) {
    if (part[0] !== ";") continue;
    statements.push(text.slice(start, part.index));
    start = part.index + 1;
  }
  statements.push(text.slice(start));
  return statements.map((statement) => statement.trim()).filter((statement) => statement !== "");
}

/**
 * Applies schema.sql in one transaction. Safe to run repeatedly: tables use
 * CREATE ... IF NOT EXISTS, seed rows use ON CONFLICT DO NOTHING, a check
 * that changed is dropped if it exists and added again, and the showcase
 * trigger function is replaced and each of its triggers dropped and made
 * again. Needs a role that can create tables,
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
