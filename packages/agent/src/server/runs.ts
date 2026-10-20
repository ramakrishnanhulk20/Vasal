import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db } from "../store/db.js";
import { ServerError } from "./errors.js";
import { RUN_EVENTS, type RunEventName } from "./sse.js";

export { RUN_EVENTS, type RunEventName } from "./sse.js";

export type RunStatus = "queued" | "awaiting_confirm" | "running" | "done" | "failed";
export type RunInput = { show: string; exclude: string[] };
/** Which share a run spends from: the website's or MCP's (D3.2). */
export type RunSurface = "web" | "mcp";
/** Recorded on the run when it is created and read back by the runner, never inferred from a request (D3.2, D4.1). */
export type RunOrigin = { surface: "web" } | { surface: "mcp"; tokenId: string };
export type RunRecord = {
  id: string;
  status: RunStatus;
  input: RunInput;
  errorCode: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  surface: RunSurface;
  tokenId: string | null;
};

const RUN_STATUSES = ["queued", "awaiting_confirm", "running", "done", "failed"] as const satisfies readonly RunStatus[];
const RUN_SURFACES = ["web", "mcp"] as const satisfies readonly RunSurface[];
const WEB: RunOrigin = { surface: "web" };
// A day is far past any candidate's life; the cap only stops a mistaken
// caller from making every candidate valid forever.
const MAX_CANDIDATE_AGE_MS = 24 * 60 * 60 * 1_000;
const RUN_COLUMNS =
  "id::text AS id, status, input::text AS input, error_code, created_at, finished_at, surface, token_id::text AS token_id";
const TERMINAL_STATUSES: ReadonlySet<string> = new Set<RunStatus>(["done", "failed"]);
const TERMINAL_EVENTS: ReadonlySet<string> = new Set<RunEventName>(["done", "failed"]);

const MAX_SHOW_LENGTH = 300;
const MAX_EXCLUSIONS = 25;
const MAX_EXCLUSION_LENGTH = 100;
// Every input character could be escaped to six JSON characters, plus quotes
// and commas, so the stored text always fits under this.
const MAX_INPUT_JSON = 32_768;
const MAX_EVENT_JSON = 16_384;
const MAX_EVENTS_PER_RUN = 500;
const MAX_ITEM_JSON = 16_384;
// A brief is model prose of up to about 4,000 tokens plus computed fields.
const MAX_BRIEF_JSON = 65_536;
const MAX_CANDIDATES = 10;
const MAX_BOARD_GUESTS = 50;
const DEFAULT_EVENT_PAGE = 100;
const MAX_EVENT_PAGE = 500;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SERVER_RESTART = "SERVER_RESTART";

const badInput = (): ServerError => new ServerError("SRV_BAD_INPUT");
const overLimit = (): ServerError => new ServerError("SRV_LIMIT");
const notFound = (): ServerError => new ServerError("SRV_NOT_FOUND");

const uuid = z.uuid();

// Postgres prints a uuid in lower case. Accepting only that form makes every
// id an exact string match on what the server issued, never a looser cast
// of some other spelling (C6.2).
function isId(value: unknown): value is string {
  return typeof value === "string" && value === value.toLowerCase() && uuid.safeParse(value).success;
}

function checkId(value: unknown): string {
  if (!isId(value)) throw badInput();
  return value;
}

function checkInstant(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw badInput();
  return value;
}

// Over a size cap is SRV_LIMIT; something JSON cannot hold is SRV_BAD_INPUT.
function jsonText(value: unknown, maxLength: number): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    throw badInput();
  }
  if (typeof text !== "string") throw badInput();
  if (text.length > maxLength) throw overLimit();
  return text;
}

// Each json column is read back as text and must pass the same limit it was
// written under, then parse, before anything uses it (C6.5).
function storedJson(maxLength: number) {
  return z
    .string()
    .max(maxLength)
    .transform((text, ctx): unknown => {
      try {
        return JSON.parse(text);
      } catch {
        ctx.addIssue({ code: "custom", message: "stored text is not JSON" });
        return z.NEVER;
      }
    });
}

const instant = z
  .union([z.date(), z.string()])
  .transform((value) => new Date(value))
  .pipe(z.date());

const runInputSchema = z.strictObject({
  show: z.string().min(1).max(MAX_SHOW_LENGTH),
  exclude: z.array(z.string().min(1).max(MAX_EXCLUSION_LENGTH)).max(MAX_EXCLUSIONS),
});

const runRow = z
  .object({
    id: z.string().refine(isId),
    status: z.enum(RUN_STATUSES),
    input: storedJson(MAX_INPUT_JSON).pipe(runInputSchema),
    error_code: z.string().regex(ERROR_CODE).nullable(),
    created_at: instant,
    finished_at: instant.nullable(),
    surface: z.enum(RUN_SURFACES),
    token_id: z.string().refine(isId).nullable(),
  })
  // A row in a state the code never writes reads as missing.
  .refine((row) => TERMINAL_STATUSES.has(row.status) === (row.finished_at !== null))
  .refine((row) => row.error_code === null || row.status === "failed")
  .refine((row) => (row.surface === "mcp") === (row.token_id !== null));

function recordOf(row: z.output<typeof runRow>): RunRecord {
  return {
    id: row.id,
    status: row.status,
    input: row.input,
    errorCode: row.error_code,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    surface: row.surface,
    tokenId: row.token_id,
  };
}

function checkOrigin(origin: unknown): { surface: RunSurface; tokenId: string | null } {
  if (typeof origin !== "object" || origin === null) throw badInput();
  const { surface, tokenId } = origin as { surface?: unknown; tokenId?: unknown };
  if (surface === "web" && tokenId === undefined) return { surface, tokenId: null };
  if (surface === "mcp" && isId(tokenId)) return { surface, tokenId };
  throw badInput();
}

const eventRow = z.object({
  seq: z.number().int().min(1).max(MAX_EVENTS_PER_RUN),
  event: z.enum(RUN_EVENTS),
  data: storedJson(MAX_EVENT_JSON),
});

const count = z
  .union([z.number(), z.string().regex(/^\d+$/)])
  .transform(Number)
  .pipe(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER));

// Driver errors become one fixed code. ServerErrors thrown on purpose inside
// a transaction pass through unchanged.
async function stored<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ServerError) throw error;
    throw new ServerError("SRV_UNAVAILABLE");
  }
}

async function countOf(tx: Db, text: string, params: unknown[]): Promise<number> {
  const { rows } = await tx.query(text, params);
  const parsed = count.safeParse(rows[0]?.["n"]);
  if (!parsed.success) throw new ServerError("SRV_UNAVAILABLE");
  return parsed.data;
}

// Every writer that numbers or caps rows for a run takes this lock first, so
// on hosted Postgres two writers to one run queue instead of both reading the
// same count. NO KEY UPDATE still lets other tables' foreign keys reference
// the row meanwhile.
async function lockRun(tx: Db, runId: string): Promise<void> {
  const { rows } = await tx.query("SELECT id FROM runs WHERE id = $1::uuid FOR NO KEY UPDATE", [runId]);
  if (rows.length !== 1) throw notFound();
}

async function readData(db: Db, text: string, params: string[], maxLength: number): Promise<unknown | null> {
  const { rows } = await stored(() => db.query(text, params));
  const parsed = z.object({ data: storedJson(maxLength) }).safeParse(rows[0]);
  return parsed.success ? parsed.data.data : null;
}

/**
 * Creates a queued run and returns its id, a fresh crypto.randomUUID (122
 * random bits, never sequential, C6.1). `input` must be exactly
 * { show, exclude } with a show of 1 to 300 code points and at most 25
 * exclusions of 1 to 100 code points each. zod counts these lengths in code
 * points, the same way app.ts and mcp/tools.ts count the show, and checks
 * the text as given, so the caller normalises first. `origin` is stored
 * with the run and decides which share every later spend comes from
 * (D3.2): { surface: "web" }, the default, or
 * { surface: "mcp", tokenId } with the id of the key row that asked for it
 * (D4.1), never the key. Throws ServerError("SRV_BAD_INPUT") for any other
 * input, origin or an invalid date, and ServerError("SRV_UNAVAILABLE") if
 * the database fails, including for a tokenId with no key row.
 */
export async function createRun(db: Db, input: RunInput, now: Date = new Date(), origin: RunOrigin = WEB): Promise<string> {
  const parsed = runInputSchema.safeParse(input);
  if (!parsed.success) throw badInput();
  checkInstant(now);
  const { surface, tokenId } = checkOrigin(origin);
  const id = randomUUID();
  await stored(() =>
    db.query(
      `INSERT INTO runs (id, status, input, error_code, created_at, finished_at, surface, token_id)
       VALUES ($1::uuid, 'queued', $2::text::json, NULL, $3::timestamptz, NULL, $4, $5::uuid)`,
      [id, JSON.stringify(parsed.data), now.toISOString(), surface, tokenId],
    ),
  );
  return id;
}

/**
 * Reads one run, with the surface and key row id it was created with.
 * Returns null, without querying, for anything that is not a lower-case
 * UUID, and null when the run is missing or its row fails the run schema
 * (C6.5). Throws ServerError("SRV_UNAVAILABLE") if the database fails, so an
 * outage is never mistaken for a missing run.
 */
export async function getRun(db: Db, id: string): Promise<RunRecord | null> {
  if (!isId(id)) return null;
  const { rows } = await stored(() => db.query(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = $1::uuid`, [id]));
  const parsed = runRow.safeParse(rows[0]);
  return parsed.success ? recordOf(parsed.data) : null;
}

/**
 * Reads a run only for the key that made it (D4.1): both ids must be
 * lower-case UUIDs, the run must be an MCP run, and its stored key row id
 * must equal `tokenId` exactly. A website run, another key's run, an unknown
 * id or a row that fails the run schema all give null, the same answer, so a
 * caller cannot tell "not yours" from "does not exist". Throws
 * ServerError("SRV_UNAVAILABLE") if the database fails.
 */
export async function getRunForToken(db: Db, runId: string, tokenId: string): Promise<RunRecord | null> {
  if (!isId(runId) || !isId(tokenId)) return null;
  const { rows } = await stored(() =>
    db.query(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = $1::uuid AND surface = 'mcp' AND token_id = $2::uuid`, [
      runId,
      tokenId,
    ]),
  );
  const parsed = runRow.safeParse(rows[0]);
  if (!parsed.success || parsed.data.surface !== "mcp" || parsed.data.token_id !== tokenId) return null;
  return recordOf(parsed.data);
}

const tokenCandidateRow = z.object({ run_id: z.string().refine(isId), data: storedJson(MAX_ITEM_JSON) });

/**
 * Finds a candidate for the key whose run it belongs to (D4.1). Matched by
 * the exact candidate id the server issued, on an MCP run whose key row id
 * equals `tokenId`, and only while that run was created less than
 * `maxAgeMs` before `now`. The run is made a moment before its candidates,
 * so this ends a candidate's life slightly early, never late. Anything else
 * (another key's candidate, a website run's, an expired one, an id never
 * issued, a row that fails its schema, or an id that is not a lower-case
 * UUID) gives null. Returns the run id with the stored candidate. Throws
 * ServerError("SRV_BAD_INPUT") for a maxAgeMs outside 1 to 86,400,000 or an
 * invalid date, and ServerError("SRV_UNAVAILABLE") if the database fails.
 */
export async function getCandidateForToken(
  db: Db,
  candidateId: string,
  tokenId: string,
  maxAgeMs: number,
  now: Date = new Date(),
): Promise<{ runId: string; data: unknown } | null> {
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > MAX_CANDIDATE_AGE_MS) throw badInput();
  checkInstant(now);
  if (!isId(candidateId) || !isId(tokenId)) return null;
  const { rows } = await stored(() =>
    db.query(
      `SELECT c.run_id::text AS run_id, c.data::text AS data
       FROM run_candidates c JOIN runs r ON r.id = c.run_id
       WHERE c.candidate_id = $1::uuid AND r.surface = 'mcp' AND r.token_id = $2::uuid AND r.created_at > $3::timestamptz
       LIMIT 2`,
      [candidateId, tokenId, new Date(now.getTime() - maxAgeMs).toISOString()],
    ),
  );
  // Ids are random, so two rows would mean something wrote them on purpose.
  if (rows.length !== 1) return null;
  const parsed = tokenCandidateRow.safeParse(rows[0]);
  return parsed.success ? { runId: parsed.data.run_id, data: parsed.data.data } : null;
}

/**
 * Moves an open run (queued, awaiting_confirm or running) to `status`.
 * Moving to done or failed sets finished_at to `now`, and after that the run
 * never changes again. `errorCode` is allowed only with failed and must be an
 * upper-case code such as QLOO_LIMIT, never free text. Throws
 * ServerError("SRV_BAD_INPUT") for a bad id, status, code or date,
 * ServerError("SRV_NOT_FOUND") when no open run has that id (missing, or
 * already done or failed; nothing changes), and ServerError("SRV_UNAVAILABLE")
 * if the database fails.
 */
export async function setRunStatus(
  db: Db,
  id: string,
  status: RunStatus,
  errorCode?: string,
  now: Date = new Date(),
): Promise<void> {
  const runId = checkId(id);
  if (typeof status !== "string" || !(RUN_STATUSES as readonly string[]).includes(status)) throw badInput();
  if (errorCode !== undefined && (status !== "failed" || typeof errorCode !== "string" || !ERROR_CODE.test(errorCode))) {
    throw badInput();
  }
  checkInstant(now);

  const { rows } = await stored(() =>
    db.query(
      `UPDATE runs SET status = $2, error_code = $3, finished_at = $4::timestamptz
       WHERE id = $1::uuid AND status IN ('queued', 'awaiting_confirm', 'running')
       RETURNING id`,
      [runId, status, errorCode ?? null, TERMINAL_STATUSES.has(status) ? now.toISOString() : null],
    ),
  );
  if (rows.length !== 1) throw notFound();
}

/**
 * Appends one event to a run and returns its seq, which is the previous
 * highest seq plus 1, worked out inside one transaction that holds the run's
 * lock. `data` must serialise to at most 16,384 JSON characters. A run holds
 * at most 500 events, and the 500th slot is kept for a done or failed event so
 * a run that reaches the cap can still be ended (C6.7, C6.4). Throws
 * ServerError("SRV_BAD_INPUT") for a bad id, event name, date or data JSON
 * cannot hold, ServerError("SRV_LIMIT") when the data is too large or the run
 * is full, ServerError("SRV_NOT_FOUND") for an unknown run, and
 * ServerError("SRV_UNAVAILABLE") if the database fails.
 */
export async function appendEvent(
  db: Db,
  runId: string,
  event: RunEventName,
  data: unknown,
  now: Date = new Date(),
): Promise<number> {
  const id = checkId(runId);
  if (typeof event !== "string" || !(RUN_EVENTS as readonly string[]).includes(event)) throw badInput();
  checkInstant(now);
  const text = jsonText(data, MAX_EVENT_JSON);
  const slotsNeeded = TERMINAL_EVENTS.has(event) ? 1 : 2;

  return stored(() =>
    db.transaction(async (tx) => {
      await lockRun(tx, id);
      const last = await countOf(tx, "SELECT coalesce(max(seq), 0) AS n FROM run_events WHERE run_id = $1::uuid", [id]);
      if (last + slotsNeeded > MAX_EVENTS_PER_RUN) throw overLimit();
      const seq = last + 1;
      await tx.query(
        `INSERT INTO run_events (run_id, seq, event, data, created_at)
         VALUES ($1::uuid, $2, $3, $4::text::json, $5::timestamptz)`,
        [id, seq, event, text, now.toISOString()],
      );
      return seq;
    }),
  );
}

/**
 * Ends an open run (queued, awaiting_confirm or running) as done or failed
 * and appends its final event, both in one transaction that holds the run's
 * lock, so a run is never seen finished without its last event or the other
 * way round (C6.4). `event.name` must equal `status`, and its data must
 * serialise to at most 16,384 JSON characters. `errorCode` is allowed only
 * with failed and must be an upper-case code, never free text. finished_at
 * is set to `now`. Like the restart sweep, a run whose 500 event slots are
 * already used still ends, without an extra event. Throws
 * ServerError("SRV_BAD_INPUT") for a bad id, status, event, code or date,
 * ServerError("SRV_LIMIT") for event data that is too large,
 * ServerError("SRV_NOT_FOUND") when no open run has that id (nothing
 * changes), and ServerError("SRV_UNAVAILABLE") if the database fails.
 */
export async function finishRun(
  db: Db,
  runId: string,
  status: "done" | "failed",
  event: { name: "done" | "failed"; data: unknown },
  errorCode?: string,
  now: Date = new Date(),
): Promise<void> {
  const id = checkId(runId);
  if (status !== "done" && status !== "failed") throw badInput();
  if (typeof event !== "object" || event === null || event.name !== status) throw badInput();
  if (errorCode !== undefined && (status !== "failed" || typeof errorCode !== "string" || !ERROR_CODE.test(errorCode))) {
    throw badInput();
  }
  checkInstant(now);
  const text = jsonText(event.data, MAX_EVENT_JSON);

  await stored(() =>
    db.transaction(async (tx) => {
      await lockRun(tx, id);
      const { rows } = await tx.query(
        `UPDATE runs SET status = $2, error_code = $3, finished_at = $4::timestamptz
         WHERE id = $1::uuid AND status IN ('queued', 'awaiting_confirm', 'running')
         RETURNING id`,
        [id, status, errorCode ?? null, now.toISOString()],
      );
      if (rows.length !== 1) throw notFound();
      const last = await countOf(tx, "SELECT coalesce(max(seq), 0) AS n FROM run_events WHERE run_id = $1::uuid", [id]);
      if (last >= MAX_EVENTS_PER_RUN) return;
      await tx.query(
        `INSERT INTO run_events (run_id, seq, event, data, created_at)
         VALUES ($1::uuid, $2, $3, $4::text::json, $5::timestamptz)`,
        [id, last + 1, event.name, text, now.toISOString()],
      );
    }),
  );
}

/**
 * Lists a run's events with seq greater than `afterSeq`, oldest first, at
 * most `limit` of them (default 100, 1 to 500). A stored row that fails the
 * event schema is skipped as missing (C6.5). Throws
 * ServerError("SRV_BAD_INPUT") for a bad run id, an afterSeq that is not a
 * non-negative safe integer, or a limit outside 1 to 500, and
 * ServerError("SRV_UNAVAILABLE") if the database fails. An unknown run gives
 * an empty list.
 */
export async function listEventsAfter(
  db: Db,
  runId: string,
  afterSeq: number,
  limit: number = DEFAULT_EVENT_PAGE,
): Promise<Array<{ seq: number; event: RunEventName; data: unknown }>> {
  const id = checkId(runId);
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw badInput();
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENT_PAGE) throw badInput();

  const { rows } = await stored(() =>
    db.query(
      `SELECT seq, event, data::text AS data FROM run_events
       WHERE run_id = $1::uuid AND seq > $2 ORDER BY seq LIMIT $3`,
      [id, afterSeq, limit],
    ),
  );
  const events: Array<{ seq: number; event: RunEventName; data: unknown }> = [];
  for (const row of rows) {
    const parsed = eventRow.safeParse(row);
    if (parsed.success) events.push(parsed.data);
  }
  return events;
}

async function putItems(
  db: Db,
  runId: string,
  items: unknown[],
  max: number,
  table: "run_candidates" | "run_board",
): Promise<string[]> {
  const id = checkId(runId);
  if (!Array.isArray(items)) throw badInput();
  if (items.length > max) throw overLimit();
  const texts = items.map((item) => jsonText(item, MAX_ITEM_JSON));
  const ids = texts.map(() => randomUUID());

  // The table name comes only from the fixed union above, never from a value.
  const existing =
    table === "run_candidates"
      ? "SELECT count(*)::int AS n FROM run_candidates WHERE run_id = $1::uuid"
      : "SELECT count(*)::int AS n FROM run_board WHERE run_id = $1::uuid";
  const insert =
    table === "run_candidates"
      ? `INSERT INTO run_candidates (run_id, candidate_id, rank, data)
         SELECT $1::uuid, item.id::uuid, item.rank, item.data::json
         FROM unnest($2::text[], $3::text[]) WITH ORDINALITY AS item(id, data, rank)`
      : `INSERT INTO run_board (run_id, guest_id, rank, data)
         SELECT $1::uuid, item.id::uuid, item.rank, item.data::json
         FROM unnest($2::text[], $3::text[]) WITH ORDINALITY AS item(id, data, rank)`;

  await stored(() =>
    db.transaction(async (tx) => {
      await lockRun(tx, id);
      if ((await countOf(tx, existing, [id])) > 0) throw overLimit();
      if (ids.length > 0) await tx.query(insert, [id, ids, texts]);
    }),
  );
  return ids;
}

/**
 * Stores the show candidates offered for a run, ranked 1 to n in the order
 * given, and returns one fresh crypto.randomUUID per candidate, in that
 * order. The confirm step may later act
 * only on one of these ids (C6.2). A run gets one candidate list of at most
 * 10, each serialising to at most 16,384 JSON characters. Throws
 * ServerError("SRV_BAD_INPUT") for a bad id or data JSON cannot hold,
 * ServerError("SRV_LIMIT") for too many or too large candidates or a run that
 * already has a list, ServerError("SRV_NOT_FOUND") for an unknown run, and
 * ServerError("SRV_UNAVAILABLE") if the database fails.
 */
export async function putCandidates(db: Db, runId: string, candidates: unknown[]): Promise<string[]> {
  return putItems(db, runId, candidates, MAX_CANDIDATES, "run_candidates");
}

/**
 * Returns a candidate only when both the run id and the candidate id match
 * exactly what putCandidates issued for that run (C6.2). A candidate id from
 * another run, an id never issued, anything that is not a lower-case UUID, or
 * a stored row that fails its schema gives null. Throws
 * ServerError("SRV_UNAVAILABLE") if the database fails.
 */
export async function getCandidate(db: Db, runId: string, candidateId: string): Promise<unknown | null> {
  if (!isId(runId) || !isId(candidateId)) return null;
  return readData(
    db,
    "SELECT data::text AS data FROM run_candidates WHERE run_id = $1::uuid AND candidate_id = $2::uuid",
    [runId, candidateId],
    MAX_ITEM_JSON,
  );
}

/**
 * Stores a run's ranked board, ranks 1 to n in the order given, and returns
 * one fresh guest id per guest in that order. A run gets one board of at most
 * 50 guests, each serialising to at most 16,384 JSON characters. Throws as
 * putCandidates does.
 */
export async function putBoard(db: Db, runId: string, guests: unknown[]): Promise<string[]> {
  return putItems(db, runId, guests, MAX_BOARD_GUESTS, "run_board");
}

/**
 * Returns a board guest only when both ids match what putBoard issued for
 * that run (C6.2), and null otherwise, as getCandidate does.
 */
export async function getBoardGuest(db: Db, runId: string, guestId: string): Promise<unknown | null> {
  if (!isId(runId) || !isId(guestId)) return null;
  return readData(
    db,
    "SELECT data::text AS data FROM run_board WHERE run_id = $1::uuid AND guest_id = $2::uuid",
    [runId, guestId],
    MAX_ITEM_JSON,
  );
}

/**
 * Returns the stored brief for a guest on a run, or null when there is none,
 * either id is not a lower-case UUID, or the row fails its schema. Throws
 * ServerError("SRV_UNAVAILABLE") if the database fails.
 */
export async function getBrief(db: Db, runId: string, guestId: string): Promise<unknown | null> {
  if (!isId(runId) || !isId(guestId)) return null;
  return readData(
    db,
    "SELECT data::text AS data FROM run_briefs WHERE run_id = $1::uuid AND guest_id = $2::uuid",
    [runId, guestId],
    MAX_BRIEF_JSON,
  );
}

/**
 * Stores the one brief for a guest on a run (C5.8). Returns true when it was
 * stored and false when that guest already has a brief, which is kept
 * unchanged; the insert is a single statement, so two writers cannot both
 * win. The guest must be on the run's stored board (C6.2). `brief` must
 * serialise to at most 65,536 JSON characters. Throws
 * ServerError("SRV_BAD_INPUT") for a bad id, date or data JSON cannot hold,
 * ServerError("SRV_LIMIT") for a brief that is too large,
 * ServerError("SRV_NOT_FOUND") when the guest is not on that run's board, and
 * ServerError("SRV_UNAVAILABLE") if the database fails.
 */
export async function putBrief(
  db: Db,
  runId: string,
  guestId: string,
  brief: unknown,
  now: Date = new Date(),
): Promise<boolean> {
  const id = checkId(runId);
  const guest = checkId(guestId);
  checkInstant(now);
  const text = jsonText(brief, MAX_BRIEF_JSON);

  return stored(async () => {
    const onBoard = await db.query("SELECT 1 FROM run_board WHERE run_id = $1::uuid AND guest_id = $2::uuid", [
      id,
      guest,
    ]);
    if (onBoard.rows.length !== 1) throw notFound();
    const { rows } = await db.query(
      `INSERT INTO run_briefs (run_id, guest_id, data, created_at)
       VALUES ($1::uuid, $2::uuid, $3::text::json, $4::timestamptz)
       ON CONFLICT (run_id, guest_id) DO NOTHING
       RETURNING guest_id`,
      [id, guest, text, now.toISOString()],
    );
    return rows.length === 1;
  });
}

/**
 * Startup step: marks every queued, awaiting_confirm or running run as failed
 * with error code SERVER_RESTART and finished_at `now`, and appends a failed
 * event to each, all in one statement, so no run is left looking alive after
 * the process that ran it died (C6.4). A run whose 500 event slots are all
 * used already ended with a terminal event and gets no extra one. Done and
 * failed runs are left alone. Returns how many runs were failed. Assumes one
 * agent server process per database: a second live process would have its
 * runs failed too. Throws ServerError("SRV_BAD_INPUT") for an invalid date
 * and ServerError("SRV_UNAVAILABLE") if the database fails.
 */
export async function failInterruptedRuns(db: Db, now: Date = new Date()): Promise<number> {
  checkInstant(now);
  // A data-modifying WITH clause always runs to completion, and the INSERT
  // takes its run ids straight from the UPDATE, so the two cannot disagree.
  return stored(() =>
    db.transaction((tx) =>
      countOf(
        tx,
        `WITH stopped AS (
           UPDATE runs SET status = 'failed', error_code = $1, finished_at = $2::timestamptz
           WHERE status IN ('queued', 'awaiting_confirm', 'running')
           RETURNING id
         ),
         numbered AS (
           SELECT stopped.id,
                  coalesce((SELECT max(e.seq) FROM run_events e WHERE e.run_id = stopped.id), 0) AS last
           FROM stopped
         ),
         noted AS (
           INSERT INTO run_events (run_id, seq, event, data, created_at)
           SELECT numbered.id, numbered.last + 1, 'failed', $3::text::json, $2::timestamptz
           FROM numbered WHERE numbered.last < $4
           RETURNING run_id
         )
         SELECT count(*)::int AS n FROM stopped`,
        [SERVER_RESTART, now.toISOString(), JSON.stringify({ code: SERVER_RESTART }), MAX_EVENTS_PER_RUN],
      ),
    ),
  );
}

const itemRow = z.object({
  id: z.string().refine(isId),
  data: storedJson(MAX_ITEM_JSON),
});

async function listItems(
  db: Db,
  text: string,
  runId: string,
  max: number,
): Promise<Array<{ id: string; data: unknown }>> {
  if (!isId(runId)) return [];
  const { rows } = await stored(() => db.query(text, [runId, max]));
  const items: Array<{ id: string; data: unknown }> = [];
  for (const row of rows) {
    const parsed = itemRow.safeParse(row);
    if (parsed.success) items.push(parsed.data);
  }
  return items;
}

/**
 * Lists the show candidates stored for a run as [{ id, data }] from rank 1
 * down, which is the order putCandidates was given, at most 10. A row that
 * fails its schema is skipped as missing (C6.5). Anything that is not a
 * lower-case UUID, or an unknown run, gives an empty list without error.
 * Throws ServerError("SRV_UNAVAILABLE") if the database fails.
 */
export async function listCandidates(db: Db, runId: string): Promise<Array<{ id: string; data: unknown }>> {
  return listItems(
    db,
    `SELECT candidate_id::text AS id, data::text AS data FROM run_candidates
     WHERE run_id = $1::uuid ORDER BY rank LIMIT $2`,
    runId,
    MAX_CANDIDATES,
  );
}

/**
 * Lists a run's board as [{ id, data }] from rank 1 down, at most 50. Skips
 * rows that fail their schema and returns an empty list for a bad or
 * unknown run id, as listCandidates does. Throws
 * ServerError("SRV_UNAVAILABLE") if the database fails.
 */
export async function listBoard(db: Db, runId: string): Promise<Array<{ id: string; data: unknown }>> {
  return listItems(
    db,
    `SELECT guest_id::text AS id, data::text AS data FROM run_board
     WHERE run_id = $1::uuid ORDER BY rank LIMIT $2`,
    runId,
    MAX_BOARD_GUESTS,
  );
}

/**
 * Moves a run from `from` to `to` only if it is in `from` right now, in one
 * UPDATE ... WHERE status = from, so of two simultaneous callers exactly one
 * wins (C6.2: a second confirm cannot start a second continuation). Returns
 * true when this call moved the run and false when it was not in `from` or
 * does not exist. Moving to done or failed sets finished_at to `now`. Throws
 * ServerError("SRV_BAD_INPUT") for a bad id or date, a status outside the
 * five, a `from` that is done or failed (finished runs never change), or
 * `from` equal to `to`, and ServerError("SRV_UNAVAILABLE") if the database
 * fails.
 */
export async function claimRunStatus(
  db: Db,
  runId: string,
  from: RunStatus,
  to: RunStatus,
  now: Date = new Date(),
): Promise<boolean> {
  const id = checkId(runId);
  const statuses = RUN_STATUSES as readonly string[];
  if (typeof from !== "string" || !statuses.includes(from) || TERMINAL_STATUSES.has(from)) throw badInput();
  if (typeof to !== "string" || !statuses.includes(to) || to === from) throw badInput();
  checkInstant(now);

  const { rows } = await stored(() =>
    db.query(
      `UPDATE runs SET status = $3, finished_at = $4::timestamptz
       WHERE id = $1::uuid AND status = $2
       RETURNING id`,
      [id, from, to, TERMINAL_STATUSES.has(to) ? now.toISOString() : null],
    ),
  );
  return rows.length === 1;
}

export type BriefClaimStatus = "pending" | "failed" | "done";
export type BriefClaim = { status: BriefClaimStatus; attempts: 1 | 2; errorCode: string | null };

const MAX_BRIEF_ATTEMPTS = 2;

// Only failed claims carry a code, and it is always a fixed upper-case code.
const briefClaimRow = z
  .object({
    status: z.enum(["pending", "failed", "done"]),
    attempts: z.union([z.literal(1), z.literal(MAX_BRIEF_ATTEMPTS)]),
    error_code: z.string().regex(ERROR_CODE).nullable(),
  })
  .refine((row) => (row.status === "failed") === (row.error_code !== null));

/**
 * Claims the brief a guest may get on a run, before any model call (C5.8).
 * Inside one transaction that holds the run's row lock it checks the guest
 * is on the run's stored board (C6.2), then reads that guest's claim:
 * - none: "limit" if the run already has `maxPerRun` claims, otherwise it
 *   inserts a pending claim with attempts 1 and returns "claimed";
 * - pending or done: "exists";
 * - failed after 1 attempt: one UPDATE moves it to pending with attempts 2
 *   and created_at `now`, only WHERE status = 'failed' AND attempts = 1, and
 *   returns "claimed"; the retry reuses the claim, so it does not count
 *   against the limit;
 * - failed after 2 attempts: "failed".
 * A claim row that fails its schema counts as "exists", so it never leads to
 * a model call (C6.5). Two requests at once queue on the lock and give one
 * "claimed". Throws ServerError("SRV_BAD_INPUT") for a bad id or date or a
 * maxPerRun outside 1 to 50, ServerError("SRV_NOT_FOUND") for an unknown run
 * or a guest not on its board, and ServerError("SRV_UNAVAILABLE") if the
 * database fails.
 */
export async function claimBrief(
  db: Db,
  runId: string,
  guestId: string,
  maxPerRun: number,
  now: Date = new Date(),
): Promise<"claimed" | "exists" | "limit" | "failed"> {
  const id = checkId(runId);
  const guest = checkId(guestId);
  if (!Number.isSafeInteger(maxPerRun) || maxPerRun < 1 || maxPerRun > MAX_BOARD_GUESTS) throw badInput();
  checkInstant(now);

  return stored(() =>
    db.transaction(async (tx): Promise<"claimed" | "exists" | "limit" | "failed"> => {
      await lockRun(tx, id);
      const onBoard = await tx.query("SELECT 1 FROM run_board WHERE run_id = $1::uuid AND guest_id = $2::uuid", [
        id,
        guest,
      ]);
      if (onBoard.rows.length !== 1) throw notFound();
      const held = await tx.query(
        "SELECT status, attempts, error_code FROM run_brief_claims WHERE run_id = $1::uuid AND guest_id = $2::uuid",
        [id, guest],
      );
      if (held.rows.length === 1) {
        const claim = briefClaimRow.safeParse(held.rows[0]);
        if (!claim.success || claim.data.status !== "failed") return "exists";
        if (claim.data.attempts === MAX_BRIEF_ATTEMPTS) return "failed";
        // created_at is when the current attempt was claimed, so a stale sweep
        // with a threshold never fails a retry that has just started.
        const retried = await tx.query(
          `UPDATE run_brief_claims SET status = 'pending', attempts = 2, error_code = NULL, created_at = $3::timestamptz
           WHERE run_id = $1::uuid AND guest_id = $2::uuid AND status = 'failed' AND attempts = 1
           RETURNING guest_id`,
          [id, guest, now.toISOString()],
        );
        return retried.rows.length === 1 ? "claimed" : "exists";
      }
      const claims = await countOf(tx, "SELECT count(*)::int AS n FROM run_brief_claims WHERE run_id = $1::uuid", [id]);
      if (claims >= maxPerRun) return "limit";
      const { rows } = await tx.query(
        `INSERT INTO run_brief_claims (run_id, guest_id, status, attempts, error_code, created_at)
         VALUES ($1::uuid, $2::uuid, 'pending', 1, NULL, $3::timestamptz)
         ON CONFLICT (run_id, guest_id) DO NOTHING
         RETURNING guest_id`,
        [id, guest, now.toISOString()],
      );
      return rows.length === 1 ? "claimed" : "exists";
    }),
  );
}

/**
 * Reads a guest's brief claim on a run: its status, attempts (1 or 2) and,
 * for a failed claim only, its error code. Returns null without querying for
 * anything that is not a lower-case UUID, and null when there is no claim or
 * the row fails its schema (C6.5). Changes nothing. Throws
 * ServerError("SRV_UNAVAILABLE") if the database fails.
 */
export async function getBriefClaim(db: Db, runId: string, guestId: string): Promise<BriefClaim | null> {
  if (!isId(runId) || !isId(guestId)) return null;
  const { rows } = await stored(() =>
    db.query(
      "SELECT status, attempts, error_code FROM run_brief_claims WHERE run_id = $1::uuid AND guest_id = $2::uuid",
      [runId, guestId],
    ),
  );
  const parsed = briefClaimRow.safeParse(rows[0]);
  if (!parsed.success) return null;
  return { status: parsed.data.status, attempts: parsed.data.attempts, errorCode: parsed.data.error_code };
}

/**
 * Marks a guest's pending brief claim done, after its brief is stored.
 * Returns true when a pending claim moved and false when there was none to
 * move (no claim, or already done or failed), in which case nothing changes.
 * A done claim never changes again. Throws ServerError("SRV_BAD_INPUT") for
 * a bad id and ServerError("SRV_UNAVAILABLE") if the database fails.
 */
export async function markBriefDone(db: Db, runId: string, guestId: string): Promise<boolean> {
  const id = checkId(runId);
  const guest = checkId(guestId);
  const { rows } = await stored(() =>
    db.query(
      `UPDATE run_brief_claims SET status = 'done', error_code = NULL
       WHERE run_id = $1::uuid AND guest_id = $2::uuid AND status = 'pending'
       RETURNING guest_id`,
      [id, guest],
    ),
  );
  return rows.length === 1;
}

/**
 * Marks a guest's pending brief claim failed with `code`, which must be an
 * upper-case code such as MODEL_TIMEOUT, never free text (C3.6). Returns true
 * when a pending claim moved and false when there was none to move, in which
 * case nothing changes. The claim's attempts are left as they are, so
 * claimBrief allows exactly one retry. Throws ServerError("SRV_BAD_INPUT") for
 * a bad id or code and ServerError("SRV_UNAVAILABLE") if the database fails.
 */
export async function markBriefFailed(db: Db, runId: string, guestId: string, code: string): Promise<boolean> {
  const id = checkId(runId);
  const guest = checkId(guestId);
  if (typeof code !== "string" || !ERROR_CODE.test(code)) throw badInput();
  const { rows } = await stored(() =>
    db.query(
      `UPDATE run_brief_claims SET status = 'failed', error_code = $3
       WHERE run_id = $1::uuid AND guest_id = $2::uuid AND status = 'pending'
       RETURNING guest_id`,
      [id, guest, code],
    ),
  );
  return rows.length === 1;
}

/**
 * Startup step: marks every pending brief claim whose current attempt was
 * claimed more than `olderThanMs` before `now` (a retry counts from its own
 * claim, not the first attempt's) as failed with SERVER_RESTART, in one
 * statement, so a brief whose writer died with the last process is never
 * left pending (C6.4). Attempts are left as they are, so a first attempt
 * may still be retried once. Claims created at or after the cutoff, and done
 * or failed claims, are left alone. Returns how many claims were failed.
 * Throws ServerError("SRV_BAD_INPUT") for an olderThanMs that is not a
 * non-negative safe integer or a date (or cutoff) that is not valid, and
 * ServerError("SRV_UNAVAILABLE") if the database fails.
 */
export async function failStaleBriefClaims(db: Db, olderThanMs: number, now: Date = new Date()): Promise<number> {
  if (!Number.isSafeInteger(olderThanMs) || olderThanMs < 0) throw badInput();
  checkInstant(now);
  const cutoff = checkInstant(new Date(now.getTime() - olderThanMs));
  return stored(() =>
    countOf(
      db,
      `WITH stopped AS (
         UPDATE run_brief_claims SET status = 'failed', error_code = $1
         WHERE status = 'pending' AND created_at < $2::timestamptz
         RETURNING 1
       )
       SELECT count(*)::int AS n FROM stopped`,
      [SERVER_RESTART, cutoff.toISOString()],
    ),
  );
}

/** The highest place on the home page; the table's check holds the same bound. */
export const MAX_SHOWCASE_POSITION = 12;
/** How many guests the home page shows per run, and so the smallest board it accepts. */
export const SHOWCASE_GUESTS = 3;
const QLOO_ID = /^[A-Za-z0-9-]{8,64}$/;

// A board guest exactly as the agent runner stores it, under the limits the
// runner reads it back with for a brief (BoardRow in agent/runner.ts). A row
// that could not reach a brief cannot reach the home page either (C6.5).
const boardGuest = z.strictObject({
  personId: z.string().regex(QLOO_ID),
  name: z.string().min(1).max(200),
  fit: z.number(),
  fitKnown: z.boolean(),
  fitRank: z.number().int().min(1),
  reach: z.enum(["household name", "well known", "bookable"]),
  rising: z.strictObject({ state: z.enum(["rising", "steady", "falling", "unknown"]), points: z.number().nullable() }),
  bringsNew: z.strictObject({ segment: z.string().max(100), label: z.string().max(100), gap: z.number() }).nullable(),
  sharedTags: z.array(z.string().max(200)).max(5),
  angle: z.string().max(400),
  showName: z.string().min(1).max(200),
});
const storedBoardGuest = storedJson(MAX_ITEM_JSON).pipe(boardGuest);

export type StoredBoardGuest = z.output<typeof boardGuest>;
export type ShowcaseGuest = {
  id: string;
  name: string;
  fit: number;
  fitKnown: boolean;
  reach: string;
  rising: string;
  bringsNew: string | null;
};
export type ShowcaseRun = { runId: string; position: number; showName: string; finishedAt: Date; guests: ShowcaseGuest[] };

/**
 * Parses one stored board row's data, read as text, into the guest the agent
 * runner wrote. Gives null for anything else, including text over 16,384
 * characters or a field outside the runner's limits (C6.5). Never throws.
 */
export function parseBoardGuest(text: unknown): StoredBoardGuest | null {
  const parsed = storedBoardGuest.safeParse(text);
  return parsed.success ? parsed.data : null;
}

/**
 * What the home page shows for one run: its show name and its first 3 board
 * guests. `board` is the run's board from rank 1 down (at least its first 3
 * rows), with null in place of a row that failed its schema. Returns null
 * unless `status` is done, the board has at least 3 rows, the first 3 all
 * parsed, and they name the same show. A damaged or unfinished run is never
 * shown, and a lower guest never moves up to fill a gap (C6.4, C6.5). Pure.
 */
export function showcaseView(
  status: RunStatus,
  board: ReadonlyArray<{ id: string; guest: StoredBoardGuest } | null>,
): { showName: string; guests: ShowcaseGuest[] } | null {
  if (status !== "done") return null;
  const top: Array<{ id: string; guest: StoredBoardGuest }> = [];
  for (const item of board.slice(0, SHOWCASE_GUESTS)) {
    if (item === null) return null;
    top.push(item);
  }
  const [first] = top;
  if (first === undefined || top.length < SHOWCASE_GUESTS) return null;
  const { showName } = first.guest;
  if (top.some((item) => item.guest.showName !== showName)) return null;
  return {
    showName,
    guests: top.map(({ id, guest }) => ({
      id,
      name: guest.name,
      fit: guest.fit,
      fitKnown: guest.fitKnown,
      reach: guest.reach,
      rising: guest.rising.state,
      bringsNew: guest.bringsNew?.label ?? null,
    })),
  };
}

const showcasePlace = z.object({ position: z.number().int().min(1).max(MAX_SHOWCASE_POSITION) });
const boardRunId = z.object({ run_id: z.string().refine(isId) });
const showcaseBoardRow = z.object({ id: z.string().refine(isId), data: storedBoardGuest });

/**
 * Lists the runs the operator promoted to the home page, by position, each
 * with its show name, finish time and first 3 board guests in rank order
 * (C6.3). A promoted run is listed only when its showcase row, its run row
 * and its first 3 board rows all pass their schemas and showcaseView accepts
 * it; any other promoted run is skipped (C6.4, C6.5). Two SELECTs read at
 * most 12 runs and 36 board rows, so it calls nothing upstream, changes
 * nothing (C5.4), and the app role may run it. Throws
 * ServerError("SRV_UNAVAILABLE") if the database fails.
 */
export async function listShowcase(db: Db): Promise<ShowcaseRun[]> {
  const promoted = await stored(() =>
    db.query(
      `SELECT s.position, r.id::text AS id, r.status, r.input::text AS input, r.error_code, r.created_at, r.finished_at,
              r.surface, r.token_id::text AS token_id
       FROM showcase_runs s JOIN runs r ON r.id = s.run_id
       ORDER BY s.position LIMIT $1`,
      [MAX_SHOWCASE_POSITION],
    ),
  );
  const runs: Array<{ id: string; position: number; status: RunStatus; finishedAt: Date }> = [];
  for (const row of promoted.rows) {
    const place = showcasePlace.safeParse(row);
    const run = runRow.safeParse(row);
    if (!place.success || !run.success || run.data.finished_at === null) continue;
    runs.push({ id: run.data.id, position: place.data.position, status: run.data.status, finishedAt: run.data.finished_at });
  }
  if (runs.length === 0) return [];

  const { rows } = await stored(() =>
    db.query(
      `SELECT ranked.run_id::text AS run_id, ranked.guest_id::text AS id, ranked.data::text AS data
       FROM (
         SELECT run_id, guest_id, data, row_number() OVER (PARTITION BY run_id ORDER BY rank, guest_id) AS place
         FROM run_board WHERE run_id = ANY ($1::uuid[])
       ) ranked
       WHERE ranked.place <= $2
       ORDER BY ranked.run_id, ranked.place`,
      [runs.map((run) => run.id), SHOWCASE_GUESTS],
    ),
  );
  // A row that fails stays in its place as null, so showcaseView refuses the
  // run instead of showing the next guest in its slot.
  const boards = new Map<string, Array<{ id: string; guest: StoredBoardGuest } | null>>();
  for (const row of rows) {
    const owner = boardRunId.safeParse(row);
    if (!owner.success) continue;
    const item = showcaseBoardRow.safeParse(row);
    const board = boards.get(owner.data.run_id) ?? [];
    board.push(item.success ? { id: item.data.id, guest: item.data.data } : null);
    boards.set(owner.data.run_id, board);
  }

  const shown: ShowcaseRun[] = [];
  for (const run of runs) {
    const view = showcaseView(run.status, boards.get(run.id) ?? []);
    if (view === null) continue;
    shown.push({ runId: run.id, position: run.position, showName: view.showName, finishedAt: run.finishedAt, guests: view.guests });
  }
  return shown;
}
