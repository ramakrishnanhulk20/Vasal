import type { Db } from "./db.js";
import { StoreError } from "./errors.js";

const LIVE_RUNS = "live_runs";
const FLAG_NAME = /^[a-z][a-z0-9_]{0,62}$/;

/**
 * The kill switch. True only when the app_flags row `live_runs` exists and
 * holds boolean true. A missing row, any other value, or any failure at all
 * returns false, so a database that cannot be read keeps live runs off
 * (C5.7). Never throws.
 */
export async function liveRunsEnabled(db: Db): Promise<boolean> {
  try {
    const { rows } = await db.query("SELECT value FROM app_flags WHERE name = $1", [LIVE_RUNS]);
    return rows.length === 1 && rows[0]?.["value"] === true;
  } catch {
    return false;
  }
}

/**
 * For operator scripts only. Creates or updates one flag. The app role
 * vasal_app holds only SELECT on app_flags, so a web or agent process cannot
 * flip the kill switch through this or any other path (C6.6). Throws
 * StoreError("STORE_BAD_INPUT") unless `name` is 1 to 63 lower case letters,
 * digits or underscores starting with a letter and `value` is a boolean, and
 * StoreError("STORE_UNAVAILABLE") if the database fails.
 */
export async function setFlag(db: Db, name: string, value: boolean): Promise<void> {
  if (typeof name !== "string" || !FLAG_NAME.test(name) || typeof value !== "boolean") {
    throw new StoreError("STORE_BAD_INPUT");
  }
  await db.query(
    "INSERT INTO app_flags (name, value) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET value = excluded.value",
    [name, value],
  );
}
