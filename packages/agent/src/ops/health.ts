import { z } from "zod";
import { mcpEnabled } from "../mcp/tokens.js";
import type { Db } from "../store/db.js";
import { liveRunsEnabled } from "../store/flags.js";

export type BucketHealth = {
  key: string;
  used: number;
  cap: number;
  // A cap of 0 refuses everything, so it reads as 100.
  percentUsed: number;
  windowEnd: string;
  windowEnded: boolean;
};

/**
 * What the operator sees each day. Every value comes from the database or a
 * fixed sentence; nothing here can hold a connection string, a key or an
 * error message from the driver. A part that could not be read is null and
 * named in `problems`.
 */
export type HealthReport = {
  checkedAt: string;
  databaseReachable: boolean;
  buckets: BucketHealth[] | null;
  liveRuns: boolean | null;
  mcp: boolean | null;
  // Live means not revoked and not past its expiry on the database clock,
  // the same test a request must pass.
  agentKeys: { live: number; revoked: number } | null;
  runsLast24h: Record<string, number> | null;
  inflight: number | null;
  mcpInflight: number | null;
  cacheRows: number | null;
  problems: string[];
};

const DAY_MS = 24 * 60 * 60 * 1_000;
// meter.ts creates these on demand and drops them seconds later; each ends
// two seconds after it starts, so listing them would only show noise.
const SECOND_BUCKET_PREFIX = "qloo:second:";
const INFLIGHT_SLOT = "runs";
const MCP_INFLIGHT_SLOT = "mcp";
const MAX_BUCKET_ROWS = 200;

// pg returns bigint columns as digit strings and PGlite as numbers (C6.5).
const count = z
  .union([z.number(), z.string().regex(/^\d+$/), z.bigint()])
  .transform(Number)
  .pipe(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER));
const instant = z
  .union([z.date(), z.string()])
  .transform((value) => new Date(value))
  .pipe(z.date());
const BucketRow = z.object({ key: z.string().min(1).max(200), cap: count, used: count, window_end: instant });
const StatusRow = z.object({ status: z.string().regex(/^[a-z_]{1,40}$/), n: count });
const CountRow = z.object({ n: count });
const KeyCountRow = z.object({ live: count, revoked: count });

const utc = (date: Date) => `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
const grouped = new Intl.NumberFormat("en-US");

async function readOrNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

async function readBuckets(db: Db, now: Date): Promise<BucketHealth[]> {
  const { rows } = await db.query(
    `SELECT key, cap, used, window_end FROM usage_buckets
     WHERE NOT starts_with(key, $1) ORDER BY key COLLATE "C" LIMIT $2`,
    [SECOND_BUCKET_PREFIX, MAX_BUCKET_ROWS],
  );
  return rows.map((row) => {
    const bucket = BucketRow.parse(row);
    return {
      key: bucket.key,
      used: bucket.used,
      cap: bucket.cap,
      percentUsed: bucket.cap === 0 ? 100 : Math.round((bucket.used / bucket.cap) * 1_000) / 10,
      windowEnd: bucket.window_end.toISOString(),
      windowEnded: bucket.window_end.getTime() <= now.getTime(),
    };
  });
}

async function readRuns(db: Db, now: Date): Promise<Record<string, number>> {
  const { rows } = await db.query(
    `SELECT status, count(*)::int AS n FROM runs
     WHERE created_at > $1::timestamptz GROUP BY status ORDER BY status COLLATE "C"`,
    [new Date(now.getTime() - DAY_MS).toISOString()],
  );
  return Object.fromEntries(rows.map((row) => {
    const parsed = StatusRow.parse(row);
    return [parsed.status, parsed.n];
  }));
}

async function readCount(db: Db, text: string, params: unknown[]): Promise<number> {
  const { rows } = await db.query(text, params);
  return CountRow.parse(rows[0]).n;
}

async function readAgentKeys(db: Db): Promise<{ live: number; revoked: number }> {
  const { rows } = await db.query(
    `SELECT count(*) FILTER (WHERE NOT revoked AND expires_at > now())::int AS live,
            count(*) FILTER (WHERE revoked)::int AS revoked
     FROM mcp_tokens`,
  );
  return KeyCountRow.parse(rows[0]);
}

function bucketProblems(buckets: BucketHealth[]): string[] {
  if (buckets.length === 0) return ["No budget buckets are set, so every metered call is refused. Run the budgets command."];
  const problems: string[] = [];
  for (const bucket of buckets) {
    if (bucket.windowEnded) {
      problems.push(`${bucket.key}: its window ended at ${utc(new Date(bucket.windowEnd))}, so it refuses every call until the budgets are rolled.`);
    } else if (bucket.cap === 0) {
      problems.push(`${bucket.key}: its cap is 0, so it refuses every call.`);
    } else if (bucket.used * 5 >= bucket.cap * 4) {
      problems.push(`${bucket.key}: ${bucket.percentUsed}% used (${grouped.format(bucket.used)} of ${grouped.format(bucket.cap)}).`);
    }
  }
  return problems;
}

/**
 * Reads the state an operator checks each day: every budget bucket except the
 * short-lived per-second ones, with used, cap, percent used and window end;
 * the live_runs flag; the mcp_enabled flag; how many agent keys are live and
 * how many revoked (counts only, never an id or a hash); runs created in the
 * 24 hours before `now`, by status; the in-progress run counts for the site
 * and for MCP; and the number of cached Qloo answers. Each row read passes a
 * schema first (C6.5).
 *
 * `problems` lists, in plain sentences: the database being unreachable; any
 * part that could not be read; no buckets at all; a bucket whose window has
 * ended at or before `now` (it fails closed, C5.7); a bucket with cap 0; a
 * bucket at or over 80 percent of its cap; and live runs being off. MCP
 * being off is reported but is not a problem, because the operator may keep
 * it off on purpose. Only SELECTs run, so either role can call it. An
 * invalid `now` falls back to the clock. Never throws, and the report never
 * holds a connection string, a key or a driver message.
 */
export async function healthReport(db: Db, now: Date): Promise<HealthReport> {
  const checkedAt = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  const report: HealthReport = {
    checkedAt: checkedAt.toISOString(),
    databaseReachable: false,
    buckets: null,
    liveRuns: null,
    mcp: null,
    agentKeys: null,
    runsLast24h: null,
    inflight: null,
    mcpInflight: null,
    cacheRows: null,
    problems: [],
  };

  const reachable = await readOrNull(async () => CountRow.parse((await db.query("SELECT 1 AS n")).rows[0]).n === 1);
  if (reachable !== true) {
    report.problems.push("The database could not be reached, so no run can start and no metered call can go out.");
    return report;
  }
  report.databaseReachable = true;

  report.buckets = await readOrNull(() => readBuckets(db, checkedAt));
  report.liveRuns = await liveRunsEnabled(db);
  report.mcp = await mcpEnabled(db);
  report.agentKeys = await readOrNull(() => readAgentKeys(db));
  report.runsLast24h = await readOrNull(() => readRuns(db, checkedAt));
  report.inflight = await readOrNull(() => readCount(db, "SELECT n FROM inflight WHERE slot = $1", [INFLIGHT_SLOT]));
  report.mcpInflight = await readOrNull(() => readCount(db, "SELECT n FROM inflight WHERE slot = $1", [MCP_INFLIGHT_SLOT]));
  report.cacheRows = await readOrNull(() => readCount(db, "SELECT count(*)::int AS n FROM qloo_cache", []));

  if (report.buckets === null) report.problems.push("The budget buckets could not be read.");
  else report.problems.push(...bucketProblems(report.buckets));
  if (!report.liveRuns) report.problems.push("Live runs are off, so the site shows saved runs only.");
  if (report.agentKeys === null) report.problems.push("The agent key table could not be read.");
  if (report.runsLast24h === null) report.problems.push("The runs table could not be read.");
  if (report.inflight === null) report.problems.push("The in-progress run counter could not be read, so no run can start.");
  if (report.mcpInflight === null) report.problems.push("The MCP in-progress run counter could not be read, so no MCP run can start.");
  if (report.cacheRows === null) report.problems.push("The Qloo cache could not be read.");
  return report;
}

/** Renders a health report as short plain lines for the terminal. */
export function formatHealth(report: HealthReport): string[] {
  const lines = [`Health at ${utc(new Date(report.checkedAt))}`, `  Database: ${report.databaseReachable ? "reachable" : "not reachable"}`];
  if (report.databaseReachable) {
    lines.push(`  Live runs: ${report.liveRuns ? "on" : "off"}`);
    lines.push(`  MCP: ${report.mcp ? "on" : "off, so no agent key is issued and every MCP request is refused"}`);
    const keys = report.agentKeys;
    lines.push(`  Agent keys: ${keys === null ? "unknown" : `${grouped.format(keys.live)} live, ${grouped.format(keys.revoked)} revoked`}`);
    const runs = report.runsLast24h;
    const runText =
      runs === null ? "unknown" : Object.keys(runs).length === 0 ? "none" : Object.entries(runs).map(([status, n]) => `${status} ${n}`).join(", ");
    lines.push(`  Runs started in the last 24 hours: ${runText}`);
    lines.push(`  Runs in progress: ${report.inflight ?? "unknown"}`);
    lines.push(`  MCP runs in progress: ${report.mcpInflight ?? "unknown"}`);
    lines.push(`  Cached Qloo answers: ${report.cacheRows === null ? "unknown" : grouped.format(report.cacheRows)}`);
    const buckets = report.buckets ?? [];
    lines.push(report.buckets === null ? "  Budgets: unknown" : buckets.length === 0 ? "  Budgets: none" : "  Budgets:");
    for (const bucket of buckets) {
      lines.push(
        `    ${bucket.key.padEnd(18)} ${`${grouped.format(bucket.used)} of ${grouped.format(bucket.cap)}`.padEnd(22)} ${`${bucket.percentUsed}%`.padEnd(7)} window ends ${utc(new Date(bucket.windowEnd))}`,
      );
    }
  }
  if (report.problems.length === 0) lines.push("No problems.");
  else lines.push("Problems:", ...report.problems.map((problem) => `  - ${problem}`));
  return lines;
}
