import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Db } from "../store/db.js";
import { ServerError } from "./errors.js";

/** The rows of the inflight table: the site's run places, and MCP's share of them. */
export type InflightSlot = "runs" | "mcp";

/**
 * The run statuses that hold an inflight place (see reconcileInflight).
 * ops health counts the places in use with the same list.
 */
export const SLOT_HOLDING_STATUSES: readonly string[] = ["queued", "running"];

// visitorKey returns a hex HMAC-SHA256. Accepting only that shape means a raw
// address can never be written to the counter table by mistake (C6.8).
const VISITOR_HASH = /^[0-9a-f]{64}$/;
const MAX_RUNS_PER_VISITOR_PER_DAY = 100;
const MAX_INFLIGHT_RUNS = 20;
const RUNS_SLOT = "runs";
const MCP_SLOT = "mcp";
// Sorted byte order, the order the rows are locked in below.
const MCP_RUN_SLOTS = [MCP_SLOT, RUNS_SLOT];
const slotRow = z.object({ slot: z.enum([MCP_SLOT, RUNS_SLOT]), n: z.number().int().min(0) });
const visitorRow = z.object({ runs: z.number().int().min(0) });
const reconciledRow = z.object({ before: z.number().int().min(0), after: z.number().int().min(0) });
// A release that is lost holds its place until a reconcile or a restart, so
// a passing database failure gets two more tries first.
const RELEASE_RETRY_PAUSES_MS = [100, 400] as const;

const badInput = (): ServerError => new ServerError("SRV_BAD_INPUT");

function checkSlot(slot: unknown): InflightSlot {
  if (slot !== RUNS_SLOT && slot !== MCP_SLOT) throw badInput();
  return slot;
}

function checkInstant(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw badInput();
  return value;
}

function checkWhole(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw badInput();
  return value;
}

async function stored<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ServerError) throw error;
    throw new ServerError("SRV_UNAVAILABLE");
  }
}

async function releasedWithRetries(work: () => Promise<unknown>): Promise<void> {
  for (const pause of RELEASE_RETRY_PAUSES_MS) {
    try {
      await stored(work);
      return;
    } catch {
      await delay(pause);
    }
  }
  await stored(work);
}

// The checks and the UTC day start both visitor functions share, so the read
// and the count always name the same row.
function visitorDay(visitorHash: unknown, cap: unknown, now: unknown): Date {
  if (typeof visitorHash !== "string" || !VISITOR_HASH.test(visitorHash)) throw badInput();
  checkWhole(cap, 1, MAX_RUNS_PER_VISITOR_PER_DAY);
  const at = checkInstant(now);
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/**
 * Counts one run for a visitor in the current UTC day, if they are still
 * under `cap` (C5.3). It is one atomic statement: insert the
 * (visitor_hash, day start) row at 1, or add 1 to it only while runs < cap,
 * so simultaneous requests can never count past the cap. Returns true when
 * the run was counted and false when the visitor is at the cap.
 * `visitorHash` must be the 64-character hex key from visitorKey, never a raw
 * address (C6.8). Throws ServerError("SRV_BAD_INPUT") for any other hash, a
 * cap outside 1 to 100 or an invalid date, and ServerError("SRV_UNAVAILABLE")
 * if the database fails, so callers refuse the run (C5.7).
 */
export async function countVisitorRun(db: Db, visitorHash: string, cap: number, now: Date = new Date()): Promise<boolean> {
  const dayStart = visitorDay(visitorHash, cap, now);

  const { rows } = await stored(() =>
    db.query(
      `INSERT INTO visitor_counters AS c (visitor_hash, window_start, runs)
       VALUES ($1, $2::timestamptz, 1)
       ON CONFLICT (visitor_hash, window_start) DO UPDATE SET runs = c.runs + 1
       WHERE c.runs < $3
       RETURNING c.runs`,
      [visitorHash, dayStart.toISOString(), cap],
    ),
  );
  return rows.length === 1;
}

/**
 * Whether a visitor has already used `cap` runs in the current UTC day, read
 * from the row countVisitorRun adds to. A plain read that changes nothing,
 * so POST /runs can refuse a visitor at the cap before taking a run place
 * (C5.8); countVisitorRun, after the place is taken, stays the gate that
 * counts. False when the visitor has no row for the day. Throws what
 * countVisitorRun throws for a bad hash, cap or date, and
 * ServerError("SRV_UNAVAILABLE") if the database fails or the row fails its
 * schema, so callers refuse the run (C5.7).
 */
export async function visitorRunsAtCap(db: Db, visitorHash: string, cap: number, now: Date = new Date()): Promise<boolean> {
  const dayStart = visitorDay(visitorHash, cap, now);
  const { rows } = await stored(() =>
    db.query("SELECT runs FROM visitor_counters WHERE visitor_hash = $1 AND window_start = $2::timestamptz", [
      visitorHash,
      dayStart.toISOString(),
    ]),
  );
  if (rows.length === 0) return false;
  const parsed = visitorRow.safeParse(rows[0]);
  if (!parsed.success) throw new ServerError("SRV_UNAVAILABLE");
  return parsed.data.runs >= cap;
}

/**
 * Takes one place from an inflight counter, the site-wide run places by
 * default (C5.8). It is one atomic UPDATE that adds 1 only while n < max, so
 * simultaneous callers can never hold more than `max`. Returns false when
 * every place is taken or the counter row is missing (fail closed, C5.7). An
 * MCP run never calls this alone: it takes both of its places through
 * acquireMcpRunSlots. Throws ServerError("SRV_BAD_INPUT") for a max outside
 * 1 to 20 or a slot other than "runs" or "mcp", and
 * ServerError("SRV_UNAVAILABLE") if the database fails.
 */
export async function acquireInflightSlot(db: Db, max: number, slot: InflightSlot = RUNS_SLOT): Promise<boolean> {
  checkWhole(max, 1, MAX_INFLIGHT_RUNS);
  const name = checkSlot(slot);
  const { rows } = await stored(() =>
    db.query("UPDATE inflight SET n = n + 1 WHERE slot = $1 AND n < $2 RETURNING n", [name, max]),
  );
  return rows.length === 1;
}

/**
 * Gives back one place on an inflight counter, the site-wide run places by
 * default. Never takes the count below 0, so an extra release cannot hand
 * out a place that was never taken. A failed decrement is tried again after
 * 100 ms and then after 400 ms. Throws ServerError("SRV_BAD_INPUT") for a
 * slot other than "runs" or "mcp" and ServerError("SRV_UNAVAILABLE") if the
 * third try fails too.
 */
export async function releaseInflightSlot(db: Db, slot: InflightSlot = RUNS_SLOT): Promise<void> {
  const name = checkSlot(slot);
  await releasedWithRetries(() => db.query("UPDATE inflight SET n = n - 1 WHERE slot = $1 AND n > 0", [name]));
}

/**
 * Takes the places one MCP run needs, both or neither, in one transaction
 * (D3.3): one of MCP's own `mcpMax` places and one of the site's `siteMax`
 * run places. The two rows are locked in the same sorted order on every call,
 * so callers queue rather than deadlock, and a website start, which locks
 * only the site row, can never wait in a cycle with it. Because MCP's share
 * must stay below the site's, MCP can never hold every place the website
 * needs. Returns false, changing neither row, when either is full or missing
 * (C5.7); the caller answers busy at once, with no queue. Throws
 * ServerError("SRV_BAD_INPUT") unless both maxima are 1 to 20 and mcpMax is
 * below siteMax, and ServerError("SRV_UNAVAILABLE") if the database fails.
 */
export async function acquireMcpRunSlots(db: Db, mcpMax = 1, siteMax: number): Promise<boolean> {
  checkWhole(mcpMax, 1, MAX_INFLIGHT_RUNS);
  checkWhole(siteMax, 1, MAX_INFLIGHT_RUNS);
  if (mcpMax >= siteMax) throw badInput();
  return stored(() =>
    db.transaction(async (tx) => {
      const { rows } = await tx.query(
        `SELECT slot, n FROM inflight WHERE slot = ANY($1::text[]) ORDER BY slot COLLATE "C" FOR UPDATE`,
        [MCP_RUN_SLOTS],
      );
      const held = new Map<string, number>();
      for (const row of rows) {
        const parsed = slotRow.safeParse(row);
        if (parsed.success) held.set(parsed.data.slot, parsed.data.n);
      }
      const mcp = held.get(MCP_SLOT);
      const site = held.get(RUNS_SLOT);
      if (mcp === undefined || site === undefined || mcp >= mcpMax || site >= siteMax) return false;
      await tx.query("UPDATE inflight SET n = n + 1 WHERE slot = ANY($1::text[])", [MCP_RUN_SLOTS]);
      return true;
    }),
  );
}

/**
 * Gives back both places an MCP run took through acquireMcpRunSlots, in one
 * transaction that locks the rows in the same order. Neither count goes
 * below 0. A failed transaction, which changed nothing, is tried again after
 * 100 ms and then after 400 ms. Throws ServerError("SRV_UNAVAILABLE") if the
 * third try fails too.
 */
export async function releaseMcpRunSlots(db: Db): Promise<void> {
  await releasedWithRetries(() =>
    db.transaction(async (tx) => {
      await tx.query(`SELECT slot FROM inflight WHERE slot = ANY($1::text[]) ORDER BY slot COLLATE "C" FOR UPDATE`, [
        MCP_RUN_SLOTS,
      ]);
      await tx.query("UPDATE inflight SET n = n - 1 WHERE slot = ANY($1::text[]) AND n > 0", [MCP_RUN_SLOTS]);
    }),
  );
}

// Each lowers its counter to the runs holding it in one statement, so a run
// that takes or gives back a place at the same moment queues on the row lock
// instead of being lost. `old` is the count as the statement found it.
const RECONCILE_RUNS_SQL = `UPDATE inflight AS i SET n = LEAST(i.n, held.n)
  FROM (SELECT n FROM inflight WHERE slot = 'runs') AS old,
       (SELECT count(*)::int AS n FROM runs WHERE status = ANY($1::text[])) AS held
  WHERE i.slot = 'runs'
  RETURNING old.n AS before, i.n AS after`;
const RECONCILE_MCP_SQL = `UPDATE inflight AS i SET n = LEAST(i.n, held.n)
  FROM (SELECT n FROM inflight WHERE slot = 'mcp') AS old,
       (SELECT count(*)::int AS n FROM runs WHERE status = ANY($1::text[]) AND surface = 'mcp') AS held
  WHERE i.slot = 'mcp'
  RETURNING old.n AS before, i.n AS after`;

async function reconciled(db: Db, text: string): Promise<{ before: number; after: number }> {
  const { rows } = await stored(() => db.query(text, [SLOT_HOLDING_STATUSES]));
  const parsed = reconciledRow.safeParse(rows[0]);
  if (rows.length !== 1 || !parsed.success) throw new ServerError("SRV_UNAVAILABLE");
  return parsed.data;
}

/**
 * Operator use (ops reconcile and ops nightly): heals places lost to a
 * release that never landed, without a restart. For each slot it sets n to
 * LEAST(n, the runs that hold that slot right now) in one statement, so it
 * only ever lowers n, never raises it.
 *
 * Who holds what, read from app.ts and mcp/tools.ts:
 * - "runs": POST /runs takes it before createRun (status queued) and gives
 *   it back once startRun settles (running, then awaiting_confirm or
 *   failed). POST /runs/:id/confirm takes it before claiming the run from
 *   awaiting_confirm to running and gives it back once continueRun settles
 *   (done or failed). find_show and book_guests take it with "mcp" for an
 *   MCP run's startRun and continueRun the same way. So it is held by every
 *   run, web or mcp, whose status is queued or running.
 * - "mcp": find_show takes it before it creates the MCP run (queued) and
 *   gives it back once the run's candidates are read; book_guests takes it
 *   before claiming the run to running and gives it back once continueRun
 *   settles. So it is held by every run with surface mcp whose status is
 *   queued or running.
 *
 * Non-goal: for a moment at each end of a run its place is held with no
 * such row: after the place is taken but before the row is created or
 * claimed, and after the run leaves running but before the release lands. A
 * reconcile inside that moment lowers n by one too many, and until the
 * next restart or reconcile the site can then hold one run more than its
 * cap. It is safest run while the site is quiet.
 *
 * Returns each counter as the statement found it and as it left it. Throws
 * ServerError("SRV_UNAVAILABLE") if the database fails or a counter row is
 * missing.
 */
export async function reconcileInflight(db: Db): Promise<{ runs: { before: number; after: number }; mcp: { before: number; after: number } }> {
  return { runs: await reconciled(db, RECONCILE_RUNS_SQL), mcp: await reconciled(db, RECONCILE_MCP_SQL) };
}

/**
 * Startup step, run after failInterruptedRuns: sets one inflight counter, the
 * site-wide run places by default, to `running`, the number this process is
 * really running (0 straight after the sweep), so places held by a process
 * that died are freed. main.ts resets "runs" and "mcp". Like the sweep, it
 * assumes one agent server process per database. Throws
 * ServerError("SRV_BAD_INPUT") for a count outside 0 to 20 or a slot other
 * than "runs" or "mcp", and ServerError("SRV_UNAVAILABLE") if the database
 * fails or the counter row is missing, so the server does not start with a
 * broken cap.
 */
export async function resetInflight(db: Db, running: number, slot: InflightSlot = RUNS_SLOT): Promise<void> {
  checkWhole(running, 0, MAX_INFLIGHT_RUNS);
  const name = checkSlot(slot);
  const { rows } = await stored(() =>
    db.query("UPDATE inflight SET n = $2 WHERE slot = $1 RETURNING n", [name, running]),
  );
  if (rows.length !== 1) throw new ServerError("SRV_UNAVAILABLE");
}
