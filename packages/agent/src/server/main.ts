import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { fileURLToPath } from "node:url";
import { createAnthropicModel, type ModelClient } from "../agent/model.js";
import { createAgentRunner, reserveSurfaceTokens, SURFACE_BUDGETS, waitForSurfaceQlooSlot } from "../agent/runner.js";
import { loadQlooConfig, type QlooConfig } from "../config.js";
import { lookupShow, searchShows } from "../feeds/lookup.js";
import { parseFeed } from "../feeds/rss.js";
import { MCP_ENABLED_FLAG } from "../mcp/tokens.js";
import { resetTokenInflight } from "../mcp/usage.js";
import { safeFetch } from "../net/safe-fetch.js";
import { loadPolicy, profileFor } from "../ops/policy.js";
import { createQlooClient } from "../qloo/client.js";
import { createMeteredQloo } from "../qloo/metered.js";
import { createPgDb, createPgliteDb, type Db } from "../store/db.js";
import { StoreError } from "../store/errors.js";
import { setFlag } from "../store/flags.js";
import { setBucket, waitForQlooSlot } from "../store/meter.js";
import { migrate } from "../store/migrate.js";
import { recordQuota } from "../store/quota.js";
import { createUnavailableAgent, type AgentPort } from "./agent-port.js";
import { createApp } from "./app.js";
import { resetInflight } from "./caps.js";
import { loadServerConfig, type ServerConfig } from "./config.js";
import { ServerError } from "./errors.js";
import { failInterruptedRuns, failStaleBriefClaims, type RunSurface } from "./runs.js";
import { createTurnstileVerifier } from "./turnstile.js";

const POLICY_FILE = fileURLToPath(new URL("../../scripts/budget-policy.json", import.meta.url));
const DEV_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
// One agent server process owns the database (the same assumption
// failInterruptedRuns makes), so at start-up no brief can be in progress and
// every pending claim belongs to a process that is gone.
const STALE_BRIEF_CLAIM_MS = 0;
// Room for dozens of local runs. The Qloo key is shared with production, so
// a runaway local loop still stops well short of the monthly pool.
const DEV_BUCKETS: ReadonlyArray<[key: string, cap: number]> = [
  ["qloo:day", 500],
  ["qloo:month", 2_000],
  ["youtube:day", 5_000],
];
const ANTHROPIC_DAY = "anthropic:day";
// The hosted server takes 8 of Qloo's 10 calls a second. An in-memory
// database meters only this process, so a local server on the shared key
// holds itself to the 2 the hosted meter leaves free (C9.2).
const DEV_DB_PER_SECOND_CAP = 2;

function codeOf(error: unknown): string {
  return error instanceof ServerError || error instanceof StoreError ? error.code : "UNEXPECTED";
}

// Every bucket the budget policy names is created, so each surface's share
// exists in development as it would after the operator's daily roll. The
// profile for today is used, or the latest one once the policy runs out. The
// dev caps above then replace the policy's for the shared Qloo and YouTube
// buckets, and every bucket gets the long dev window instead of a day or a
// month, so a dev server left running does not lock itself out at midnight.
async function seedDevBudgets(db: Db, config: ServerConfig): Promise<void> {
  const policy = await loadPolicy(POLICY_FILE);
  const now = new Date();
  const latest = policy.profiles.reduce((last, profile) => (profile.to > last.to ? profile : last));
  const caps = new Map((profileFor(policy, now) ?? latest).buckets.map((bucket) => [bucket.key, bucket.cap]));
  for (const [key, cap] of [...DEV_BUCKETS, [ANTHROPIC_DAY, config.anthropicTokensPerDay] as const]) caps.set(key, cap);
  const windowEnd = new Date(now.getTime() + DEV_WINDOW_MS);
  for (const [key, cap] of caps) await setBucket(db, { key, cap, windowEnd });
}

// Production and any configured DATABASE_URL never migrate or seed: the
// operator does that as the owner role, and the app role could not anyway.
async function openDb(config: ServerConfig): Promise<Db> {
  if (config.databaseUrl !== null) {
    return createPgDb(config.databaseUrl, config.databaseNetwork === null ? {} : { network: config.databaseNetwork });
  }
  if (config.production) throw new ServerError("SRV_CONFIG", "DATABASE_URL");

  const db = await createPgliteDb();
  await migrate(db);
  await seedDevBudgets(db, config);
  await setFlag(db, "live_runs", true);
  await setFlag(db, MCP_ENABLED_FLAG, true);
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
  const { anthropicApiKey } = config;
  // One model and one metered Qloo client per surface, each charging only its
  // own buckets. The runner picks the pair from the run's stored surface (D3.2).
  const modelFor = (surface: RunSurface): ModelClient =>
    createAnthropicModel({
      apiKey: anthropicApiKey,
      model: config.model,
      effort: config.effort,
      reserveTokens: (amount) => reserveSurfaceTokens(db, surface, amount),
    });
  // No retries inside the client, so every Qloo attempt takes its own slot
  // from the shared meter (C5.1, C5.2).
  const client = createQlooClient({ apiKey: qloo.apiKey, baseUrl: qloo.baseUrl, maxRetries: 0, onQuota: (quota) => recordQuota(db, quota) });
  // openDb gives the in-memory database exactly when DATABASE_URL is unset.
  const inMemory = config.databaseUrl === null;
  const slotFor =
    (surface: RunSurface) =>
    (target: Db, signal?: AbortSignal): Promise<boolean> => {
      if (!inMemory) return waitForSurfaceQlooSlot(target, surface, signal);
      const budget = SURFACE_BUDGETS[surface];
      return waitForQlooSlot(target, {
        dayKey: budget.qlooDayKey,
        extraKeys: [...budget.qlooExtraKeys],
        perSecondCap: DEV_DB_PER_SECOND_CAP,
        ...(signal === undefined ? {} : { signal }),
      });
    };
  const meteredFor = (surface: RunSurface) => createMeteredQloo({ client, db, baseUrl: qloo.baseUrl, waitForSlot: slotFor(surface) });
  const models: Record<RunSurface, ModelClient> = { web: modelFor("web"), mcp: modelFor("mcp") };
  const qloos = { web: meteredFor("web"), mcp: meteredFor("mcp") };
  console.log(`The agent is on and uses ${config.model}.`);
  return createAgentRunner({
    db,
    qlooFor: (surface) => qloos[surface],
    // The harness behind find_person spends through the same surface's meter
    // and cache as every other Qloo call of that run.
    harnessFor: (surface) => qloos[surface],
    modelFor: (surface) => models[surface],
    feeds: { searchShows, lookupShow, safeFetch, parseFeed },
    trends: config.trends,
  });
}

async function main(): Promise<void> {
  const config = loadServerConfig();
  const qloo = qlooSettings();
  const db = await openDb(config);
  try {
    await failInterruptedRuns(db);
    await failStaleBriefClaims(db, STALE_BRIEF_CLAIM_MS);
    await resetInflight(db, 0);
    await resetInflight(db, 0, "mcp");
    await resetTokenInflight(db);
  } catch (error) {
    await db.close().catch(() => {});
    throw error;
  }

  const app = createApp({
    db,
    config,
    // The same URL parser that produced appOrigin gives the hostname, so a
    // human check counts only when it was solved on that site (C5.9).
    verifyTurnstile: createTurnstileVerifier({
      secret: config.turnstileSecret,
      expectedHostname: new URL(config.appOrigin).hostname,
    }),
    agent: createAgent(db, config, qloo),
    socketAddress: (c) => getConnInfo(c).remote.address ?? null,
  });

  // Set rather than inherited (D2.5): a client gets 20 seconds for its headers
  // and 30 for the whole request, and the check runs every 5 seconds, so a
  // slow sender is cut off within half a minute. These bound only reading
  // the request, so a ten-minute event stream is unaffected.
  const serverOptions = { headersTimeout: 20_000, requestTimeout: 30_000, keepAliveTimeout: 5_000, connectionsCheckingInterval: 5_000 };
  const server = serve({ fetch: app.fetch, port: config.port, serverOptions }, (info) => {
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
        // Railway kills the process 15 seconds after SIGTERM. Runs and briefs
        // in flight get 12 of them and closing the database the rest; one
        // still going after that is failed by the next start's sweeps.
        const stillRunning = await app.drain(12_000);
        console.log(JSON.stringify({ level: "info", route: "shutdown", stillRunning }));
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
