import type { Db } from "../store/db.js";
import { ServerError } from "./errors.js";

// visitorKey returns a hex HMAC-SHA256. Accepting only that shape means a raw
// address can never be written to the counter table by mistake (C6.8).
const VISITOR_HASH = /^[0-9a-f]{64}$/;
const MAX_RUNS_PER_VISITOR_PER_DAY = 100;
const MAX_INFLIGHT_RUNS = 20;
const RUNS_SLOT = "runs";

const badInput = (): ServerError => new ServerError("SRV_BAD_INPUT");

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
  if (typeof visitorHash !== "string" || !VISITOR_HASH.test(visitorHash)) throw badInput();
  checkWhole(cap, 1, MAX_RUNS_PER_VISITOR_PER_DAY);
  checkInstant(now);
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

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
 * Takes one of the site-wide in-progress run slots (C5.8). It is one atomic
 * UPDATE that adds 1 only while n < max, so simultaneous callers can never
 * hold more than `max` slots. Returns false when every slot is taken or the
 * counter row is missing (fail closed, C5.7). Throws
 * ServerError("SRV_BAD_INPUT") for a max outside 1 to 20 and
 * ServerError("SRV_UNAVAILABLE") if the database fails.
 */
export async function acquireInflightSlot(db: Db, max: number): Promise<boolean> {
  checkWhole(max, 1, MAX_INFLIGHT_RUNS);
  const { rows } = await stored(() =>
    db.query("UPDATE inflight SET n = n + 1 WHERE slot = $1 AND n < $2 RETURNING n", [RUNS_SLOT, max]),
  );
  return rows.length === 1;
}

/**
 * Gives back one in-progress run slot. Never takes the count below 0, so an
 * extra release cannot hand out a slot that was never taken. Throws
 * ServerError("SRV_UNAVAILABLE") if the database fails.
 */
export async function releaseInflightSlot(db: Db): Promise<void> {
  await stored(() => db.query("UPDATE inflight SET n = n - 1 WHERE slot = $1 AND n > 0", [RUNS_SLOT]));
}

/**
 * Startup step, run after failInterruptedRuns: sets the in-progress count to
 * `running`, the number of runs this process is really running (0 straight
 * after the sweep), so slots held by a process that died are freed. Like the
 * sweep, it assumes one agent server process per database. Throws
 * ServerError("SRV_BAD_INPUT") for a count outside 0 to 20, and
 * ServerError("SRV_UNAVAILABLE") if the database fails or the counter row is
 * missing, so the server does not start with a broken cap.
 */
export async function resetInflight(db: Db, running: number): Promise<void> {
  checkWhole(running, 0, MAX_INFLIGHT_RUNS);
  const { rows } = await stored(() =>
    db.query("UPDATE inflight SET n = $2 WHERE slot = $1 RETURNING n", [RUNS_SLOT, running]),
  );
  if (rows.length !== 1) throw new ServerError("SRV_UNAVAILABLE");
}
