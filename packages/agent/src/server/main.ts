import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { createAnthropicModel } from "../agent/model.js";
import { createAgentRunner } from "../agent/runner.js";
import { loadQlooConfig, type QlooConfig } from "../config.js";
import { lookupShow, searchShows } from "../feeds/lookup.js";
import { parseFeed } from "../feeds/rss.js";
import { safeFetch } from "../net/safe-fetch.js";
import { createQlooClient } from "../qloo/client.js";
import { createMeteredQloo } from "../qloo/metered.js";
import { createPgDb, createPgliteDb, type Db } from "../store/db.js";
import { StoreError } from "../store/errors.js";
import { setFlag } from "../store/flags.js";
import { reserve, setBucket } from "../store/meter.js";
import { migrate } from "../store/migrate.js";
import { createUnavailableAgent, type AgentPort } from "./agent-port.js";
import { createApp } from "./app.js";
import { resetInflight } from "./caps.js";
import { loadServerConfig, type ServerConfig } from "./config.js";
import { ServerError } from "./errors.js";
import { failInterruptedRuns } from "./runs.js";
import { createTurnstileVerifier } from "./turnstile.js";

const DEV_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
// Room for dozens of local runs. The Qloo key is shared with production, so
// a runaway local loop still stops well short of the monthly pool.
const DEV_BUCKETS: ReadonlyArray<[key: string, cap: number]> = [
  ["qloo:day", 500],
  ["qloo:month", 2_000],
  ["youtube:day", 5_000],
];
const ANTHROPIC_DAY = "anthropic:day";

function codeOf(error: unknown): string {
  return error instanceof ServerError || error instanceof StoreError ? error.code : "UNEXPECTED";
}

// Production and any configured DATABASE_URL never migrate or seed: the
// operator does that as the owner role, and the app role could not anyway.
async function openDb(config: ServerConfig): Promise<Db> {
  if (config.databaseUrl !== null) return createPgDb(config.databaseUrl);
  if (config.production) throw new ServerError("SRV_CONFIG", "DATABASE_URL");

  const db = await createPgliteDb();
  await migrate(db);
  const windowEnd = new Date(Date.now() + DEV_WINDOW_MS);
  for (const [key, cap] of [...DEV_BUCKETS, [ANTHROPIC_DAY, config.anthropicTokensPerDay] as const]) {
    await setBucket(db, { key, cap, windowEnd });
  }
  await setFlag(db, "live_runs", true);
  console.log("Using an in-memory development database. Everything in it is lost when the server stops.");
  return db;
}

function qlooSettings(): QlooConfig {
  try {
    return loadQlooConfig();
  } catch (error) {
    // loadQlooConfig's messages are fixed text naming QLOO_API_KEY or
    // QLOO_BASE_URL, never a value, so they are safe to show the operator.
    const failure = new ServerError("SRV_CONFIG");
    if (error instanceof Error) failure.message = error.message;
    throw failure;
  }
}

// The real agent needs both keys. Without either, runs fail honestly with
// AGENT_NOT_READY instead of showing anything made up.
function createAgent(db: Db, config: ServerConfig, qloo: QlooConfig): AgentPort {
  if (qloo.apiKey === undefined || config.anthropicApiKey === null) {
    const missing = [
      ...(qloo.apiKey === undefined ? ["QLOO_API_KEY"] : []),
      ...(config.anthropicApiKey === null ? ["ANTHROPIC_API_KEY"] : []),
    ];
    const verb = missing.length > 1 ? "are" : "is";
    console.log(`The agent is off because ${missing.join(" and ")} ${verb} not set, so every run fails with AGENT_NOT_READY.`);
    return createUnavailableAgent(db);
  }
  const model = createAnthropicModel({
    apiKey: config.anthropicApiKey,
    model: config.model,
    effort: config.effort,
    reserveTokens: (amount) => reserve(db, [{ key: ANTHROPIC_DAY, amount }]),
  });
  // No retries inside the client, so every Qloo attempt takes its own slot
  // from the shared meter (C5.1, C5.2).
  const client = createQlooClient({ apiKey: qloo.apiKey, baseUrl: qloo.baseUrl, maxRetries: 0 });
  const metered = createMeteredQloo({ client, db, baseUrl: qloo.baseUrl });
  console.log(`The agent is on and uses ${config.model}.`);
  return createAgentRunner({ db, model, qloo: metered, feeds: { searchShows, lookupShow, safeFetch, parseFeed } });
}

async function main(): Promise<void> {
  const config = loadServerConfig();
  const qloo = qlooSettings();
  const db = await openDb(config);
  try {
    await failInterruptedRuns(db);
    await resetInflight(db, 0);
  } catch (error) {
    await db.close().catch(() => {});
    throw error;
  }

  const app = createApp({
    db,
    config,
    verifyTurnstile: createTurnstileVerifier({ secret: config.turnstileSecret }),
    agent: createAgent(db, config, qloo),
    socketAddress: (c) => getConnInfo(c).remote.address ?? null,
  });

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`Vasal agent server listening on http://localhost:${info.port}`);
  });

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    server.close();
    // Open event streams would otherwise hold the process for up to their
    // ten-minute lifetime. Dropping them ends each stream's polling.
    if ("closeAllConnections" in server) server.closeAllConnections();
    void (async () => {
      let exitCode = 0;
      try {
        // A stream that was mid-query when its connection dropped finishes
        // that query before it stops. This query runs after it, so close()
        // never meets a query in flight, which can hang PGlite.
        await db.query("SELECT 1");
        await db.close();
      } catch (error) {
        console.error(JSON.stringify({ level: "error", route: "shutdown", code: codeOf(error) }));
        exitCode = 1;
      }
      process.exit(exitCode);
    })();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

try {
  await main();
} catch (error) {
  // ServerError and StoreError messages are fixed text that name at most a
  // variable, never a value, so they are safe to show the operator.
  const message =
    error instanceof ServerError || error instanceof StoreError ? error.message : "The agent server could not start.";
  console.error(message);
  process.exit(1);
}
