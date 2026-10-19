import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPgDb, createPgliteDb, type Db } from "../store/db.js";
import { setFlag } from "../store/flags.js";
import { migrate } from "../store/migrate.js";

const REPO_ROOT_ENV_FILE = fileURLToPath(new URL("../../../../.env", import.meta.url));

/** Thrown when a setting an ops command needs is missing. The message names the variable, never a value. */
export class OpsConfigError extends Error {
  override readonly name = "OpsConfigError";
}

/**
 * Loads the repo-root .env into process.env when the file exists. Values
 * already set in the environment win over the file.
 */
export function loadRepoEnv(): void {
  if (existsSync(REPO_ROOT_ENV_FILE)) process.loadEnvFile(REPO_ROOT_ENV_FILE);
}

/**
 * Opens the database owner connection from OWNER_DATABASE_URL with
 * createPgDb, for the jobs the app role vasal_app is not allowed to do:
 * migrating, setting caps and flags, and pruning (C6.6). When `env` is the
 * real process environment, the repo-root .env is loaded first. Throws
 * OpsConfigError when OWNER_DATABASE_URL is unset or blank; DATABASE_URL is
 * never used in its place, because that is the app role. Throws
 * StoreError("STORE_BAD_INPUT") for a string that is not a postgres URL with
 * a host, and that error never repeats the string.
 */
export function openOwnerDb(env: NodeJS.ProcessEnv = process.env): Db {
  if (env === process.env) loadRepoEnv();
  const url = env["OWNER_DATABASE_URL"];
  if (typeof url !== "string" || url.trim() === "") {
    throw new OpsConfigError(
      "OWNER_DATABASE_URL is not set. Put the database owner's connection string in .env, or use --dev for a throwaway local database.",
    );
  }
  return createPgDb(url.trim());
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
