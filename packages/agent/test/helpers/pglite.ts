import { createPgliteDb, type Db } from "../../src/store/db.js";
import { migrate } from "../../src/store/migrate.js";

/** A fresh in-memory database with the schema applied, one per test. */
export async function migratedPglite(): Promise<Db> {
  const db = await createPgliteDb();
  await migrate(db);
  return db;
}
