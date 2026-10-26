import { z } from "zod";
import {
  getBriefClaim,
  getRun,
  listShowcase,
  MAX_SHOWCASE_POSITION,
  parseBoardGuest,
  SHOWCASE_GUESTS,
  showcaseView,
  type RunStatus,
  type ShowcaseRun,
  type StoredBoardGuest,
} from "../server/runs.js";
import type { Db } from "../store/db.js";

export type PromoteErrorCode =
  | "PROMOTE_BAD_RUN_ID"
  | "PROMOTE_BAD_POSITION"
  | "PROMOTE_NOT_FOUND"
  | "PROMOTE_NOT_DONE"
  | "PROMOTE_BOARD_TOO_SMALL"
  | "PROMOTE_BOARD_UNREADABLE"
  | "PROMOTE_BRIEFS_MISSING"
  | "PROMOTE_POSITION_TAKEN"
  | "PROMOTE_NOT_PROMOTED";

const MESSAGES: Record<PromoteErrorCode, string> = {
  PROMOTE_BAD_RUN_ID: "A run id is a lower-case UUID, written exactly as the server issued it.",
  PROMOTE_BAD_POSITION: `The position must be a whole number from 1 to ${MAX_SHOWCASE_POSITION}.`,
  PROMOTE_NOT_FOUND: "No readable run has that id.",
  PROMOTE_NOT_DONE: "Only a run that finished as done can go on the home page.",
  PROMOTE_BOARD_TOO_SMALL: `Only a run whose board has at least ${SHOWCASE_GUESTS} guests can go on the home page.`,
  PROMOTE_BOARD_UNREADABLE: `The run's top ${SHOWCASE_GUESTS} guests do not all read back cleanly as one show's board, so the home page would not show it.`,
  PROMOTE_BRIEFS_MISSING:
    "Every board guest needs a written brief first: run ops briefs on this run with --yes, read every brief it prints, then promote.",
  PROMOTE_POSITION_TAKEN: "Another run holds that position. Unpromote it first, or pick a free position.",
  PROMOTE_NOT_PROMOTED: "That run is not on the home page.",
};

/**
 * Thrown when the operator asks for something the showcase refuses. The
 * message is fixed text chosen by code and never repeats an input.
 */
export class PromoteError extends Error {
  override readonly name = "PromoteError";
  readonly code: PromoteErrorCode;

  constructor(code: PromoteErrorCode) {
    super(MESSAGES[code]);
    this.code = code;
  }
}

/**
 * A brief exactly as the agent runner stores it: writeBrief's fields in
 * agent/brief.ts plus how many links and emails were removed from the draft.
 * Its text comes from the model, so a terminal prints it only after
 * sanitising.
 */
export type StoredBrief = z.output<typeof storedBrief>;
export type BoardPreviewRow = { id: string; rank: number; guest: StoredBoardGuest | null; brief: StoredBrief | null };
export type RunPreview = {
  runId: string;
  status: RunStatus;
  showName: string | null;
  board: BoardPreviewRow[];
  refusal: PromoteErrorCode | null;
};
export type PromotedRun = { runId: string; position: number; promotedAt: Date };
/**
 * Where one board guest's brief stands. "none" has never been claimed, or
 * its claim was deferred by a budget, and "retry" failed on its first
 * attempt, so the briefs command may write both;
 * "failed" used both attempts, "pending" is held by a writer, and
 * "unreadable" is a row, claim or brief that does not read back (C6.5), so
 * none of those three can be written.
 */
export type BriefState =
  | { kind: "written"; brief: StoredBrief }
  | { kind: "none" }
  | { kind: "retry"; code: string | null }
  | { kind: "failed"; code: string | null }
  | { kind: "pending" }
  | { kind: "unreadable" };
export type GuestBrief = { id: string; rank: number; name: string | null; state: BriefState };
export type RunBriefs = { runId: string; status: RunStatus; showName: string | null; guests: GuestBrief[] };

const MAX_BOARD_ROWS = 50;
// putBrief's own cap on a stored brief (MAX_BRIEF_JSON in server/runs.ts).
const MAX_BRIEF_TEXT = 65_536;
// QUESTION_COUNT in agent/brief.ts: every brief the runner stores has exactly this many.
const BRIEF_QUESTIONS = 5;
const uuid = z.uuid();
const instant = z
  .union([z.date(), z.string()])
  .transform((value) => new Date(value))
  .pipe(z.date());
const previewRow = z.object({ id: z.string().max(64), rank: z.number().int(), data: z.unknown() });
// Strict, so a brief with a field this file would not print counts as
// missing rather than reaching the home page unread.
const storedBrief = z.strictObject({
  why: z.string(),
  angle: z.string(),
  questions: z.array(z.string()).length(BRIEF_QUESTIONS),
  pitch_subject: z.string(),
  pitch_body: z.string(),
  removed: z.strictObject({ links: z.number().int().min(0), emails: z.number().int().min(0) }),
});
const briefRow = z.object({
  id: z.string().max(64),
  data: z
    .string()
    .max(MAX_BRIEF_TEXT)
    .transform((text, ctx): unknown => {
      try {
        return JSON.parse(text);
      } catch {
        ctx.addIssue({ code: "custom", message: "stored text is not JSON" });
        return z.NEVER;
      }
    })
    .pipe(storedBrief),
});
const promotedRow = z.object({
  run_id: z.string().refine((value) => uuid.safeParse(value).success),
  position: z.number().int().min(1).max(MAX_SHOWCASE_POSITION),
  promoted_at: instant,
});
const freedRow = z.object({ position: z.number().int().min(1).max(MAX_SHOWCASE_POSITION) });

// The same exact-string rule the run store uses, so an id is only ever the
// spelling the server issued (C6.2).
function checkRunId(value: unknown): string {
  if (typeof value !== "string" || value !== value.toLowerCase() || !uuid.safeParse(value).success) {
    throw new PromoteError("PROMOTE_BAD_RUN_ID");
  }
  return value;
}

/**
 * Returns `value` when it is a showcase position, a whole number from 1 to
 * 12, and throws PromoteError("PROMOTE_BAD_POSITION") otherwise.
 */
export function checkPosition(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_SHOWCASE_POSITION) {
    throw new PromoteError("PROMOTE_BAD_POSITION");
  }
  return value;
}

function refusalFor(status: RunStatus, board: BoardPreviewRow[]): PromoteErrorCode | null {
  if (status !== "done") return "PROMOTE_NOT_DONE";
  if (board.length < SHOWCASE_GUESTS) return "PROMOTE_BOARD_TOO_SMALL";
  const rows = board.map((row) => (row.guest === null ? null : { id: row.id, guest: row.guest }));
  if (showcaseView(status, rows) === null) return "PROMOTE_BOARD_UNREADABLE";
  // A visitor on a promoted run can only read briefs, never write one, so a
  // guest without a brief would stay unopenable for good (C6.3).
  return board.some((row) => row.brief === null) ? "PROMOTE_BRIEFS_MISSING" : null;
}

/**
 * Operator use, on the owner connection. Reads a run for the operator to look
 * at before promoting it: its status, its show name (from the first board
 * guest that reads back, or null), its whole board from rank 1 down with
 * null in place of any row that fails its schema (C6.5), each row's stored
 * brief, or null when there is none or it does not read back as a brief,
 * and the refusal promoteRun would give, or null when it may go on the home
 * page. The refusal uses showcaseView, the same rule the home page applies,
 * and then needs a brief for every board row. Changes nothing. Throws
 * PromoteError("PROMOTE_BAD_RUN_ID") for an id that is not a lower-case
 * UUID, PromoteError("PROMOTE_NOT_FOUND") when no run row with that id reads
 * back, and StoreError or ServerError if the database fails.
 */
export async function previewRun(db: Db, runId: string): Promise<RunPreview> {
  const id = checkRunId(runId);
  const run = await getRun(db, id);
  if (run === null) throw new PromoteError("PROMOTE_NOT_FOUND");
  const { rows } = await db.query(
    `SELECT guest_id::text AS id, rank, data::text AS data FROM run_board
     WHERE run_id = $1::uuid ORDER BY rank, guest_id LIMIT $2`,
    [id, MAX_BOARD_ROWS],
  );
  // putBrief stores briefs only for guests on the board, so a board's worth
  // of rows holds every brief the run can have.
  const stored = await db.query(
    "SELECT guest_id::text AS id, data::text AS data FROM run_briefs WHERE run_id = $1::uuid LIMIT $2",
    [id, MAX_BOARD_ROWS],
  );
  const briefs = new Map<string, StoredBrief>();
  for (const row of stored.rows) {
    const parsed = briefRow.safeParse(row);
    if (parsed.success) briefs.set(parsed.data.id, parsed.data.data);
  }
  const board = rows.map((row, index): BoardPreviewRow => {
    const place = previewRow.safeParse(row);
    return place.success
      ? { id: place.data.id, rank: place.data.rank, guest: parseBoardGuest(place.data.data), brief: briefs.get(place.data.id) ?? null }
      : { id: "", rank: index + 1, guest: null, brief: null };
  });
  const showName = board.find((row) => row.guest !== null)?.guest?.showName ?? null;
  return { runId: id, status: run.status, showName, board, refusal: refusalFor(run.status, board) };
}

async function briefStateOf(db: Db, runId: string, row: BoardPreviewRow): Promise<BriefState> {
  if (row.brief !== null) return { kind: "written", brief: row.brief };
  // The runner reads a guest through the same schema before writing, so a
  // row that fails it could never get a brief.
  if (row.guest === null) return { kind: "unreadable" };
  const claim = await getBriefClaim(db, runId, row.id);
  // A budget's refusal spent no attempt, and claimBrief takes a deferred
  // claim again just as it takes a new one.
  if (claim === null || claim.status === "deferred") return { kind: "none" };
  if (claim.status === "pending") return { kind: "pending" };
  if (claim.status === "failed") return claim.attempts === 1 ? { kind: "retry", code: claim.errorCode } : { kind: "failed", code: claim.errorCode };
  return { kind: "unreadable" };
}

/**
 * Operator use, on the owner connection. Reads where every board guest's
 * brief stands, from rank 1 down, through previewRun's board and briefs and
 * each unwritten guest's claim (getBriefClaim). A guest whose brief is stored
 * and reads back is written whatever its claim says, because the brief is
 * what a visitor is served. Changes nothing. Throws as previewRun does.
 */
export async function readBriefs(db: Db, runId: string): Promise<RunBriefs> {
  const preview = await previewRun(db, runId);
  const guests: GuestBrief[] = [];
  for (const row of preview.board) {
    guests.push({ id: row.id, rank: row.rank, name: row.guest?.name ?? null, state: await briefStateOf(db, preview.runId, row) });
  }
  return { runId: preview.runId, status: preview.status, showName: preview.showName, guests };
}

/** True for the brief states the briefs command may claim and write: never claimed or deferred, or failed on the first attempt. */
export function isWritable(state: BriefState): boolean {
  return state.kind === "none" || state.kind === "retry";
}

/**
 * True when `runId` has a showcase row, whether or not the home page shows
 * it. Only reads, so the app role may call it. Throws
 * PromoteError("PROMOTE_BAD_RUN_ID") for an id that is not a lower-case UUID
 * and StoreError if the database fails, so a caller that cannot tell stops.
 */
export async function isPromoted(db: Db, runId: string): Promise<boolean> {
  const id = checkRunId(runId);
  const { rows } = await db.query("SELECT 1 AS promoted FROM showcase_runs WHERE run_id = $1::uuid", [id]);
  return rows.length > 0;
}

/**
 * Operator use only: needs the owner connection, because the app role may
 * only read showcase_runs (C6.3, C6.6). Puts a run on the home page at
 * `position` (1 to 12), in one transaction that locks the showcase against
 * other promotions while it checks and writes; the site's reads are not
 * blocked. A run already promoted moves to the new position. Before writing
 * it applies previewRun's refusal, so only a done run with at least 3 board
 * guests whose top 3 read back as one show, and a brief for every board
 * guest, goes up, and after writing it
 * reads the showcase back through listShowcase and undoes the change unless
 * the run shows at that position. Throws PromoteError with
 * PROMOTE_BAD_RUN_ID, PROMOTE_BAD_POSITION, PROMOTE_NOT_FOUND,
 * PROMOTE_NOT_DONE, PROMOTE_BOARD_TOO_SMALL, PROMOTE_BOARD_UNREADABLE,
 * PROMOTE_BRIEFS_MISSING when any board row has no stored brief that reads
 * back, or PROMOTE_POSITION_TAKEN when another run holds the position (it is
 * never pushed off silently), and StoreError or ServerError if the database
 * fails. Nothing changes when it throws.
 */
export async function promoteRun(db: Db, runId: string, position: number): Promise<void> {
  const id = checkRunId(runId);
  const place = checkPosition(position);
  await db.transaction(async (tx) => {
    await tx.query("LOCK TABLE showcase_runs IN SHARE ROW EXCLUSIVE MODE");
    const preview = await previewRun(tx, id);
    if (preview.refusal !== null) throw new PromoteError(preview.refusal);
    const held = await tx.query<{ run_id: string }>("SELECT run_id::text AS run_id FROM showcase_runs WHERE position = $1", [place]);
    const holder = held.rows[0]?.run_id;
    if (holder !== undefined && holder !== id) throw new PromoteError("PROMOTE_POSITION_TAKEN");
    await tx.query(
      `INSERT INTO showcase_runs (run_id, position, promoted_at) VALUES ($1::uuid, $2, now())
       ON CONFLICT (run_id) DO UPDATE SET position = EXCLUDED.position, promoted_at = EXCLUDED.promoted_at`,
      [id, place],
    );
    const shown = await listShowcase(tx);
    if (!shown.some((run) => run.runId === id && run.position === place)) throw new PromoteError("PROMOTE_BOARD_UNREADABLE");
  });
}

/**
 * Operator use only, on the owner connection (C6.3). Takes a run off the home
 * page and returns the position it held. Throws
 * PromoteError("PROMOTE_BAD_RUN_ID") for an id that is not a lower-case
 * UUID, PromoteError("PROMOTE_NOT_PROMOTED") when the run is not promoted
 * (nothing changes), and StoreError if the database fails.
 */
export async function unpromoteRun(db: Db, runId: string): Promise<number> {
  const id = checkRunId(runId);
  const { rows } = await db.query("DELETE FROM showcase_runs WHERE run_id = $1::uuid RETURNING position", [id]);
  const freed = freedRow.safeParse(rows[0]);
  if (rows.length !== 1 || !freed.success) throw new PromoteError("PROMOTE_NOT_PROMOTED");
  return freed.data.position;
}

/**
 * Lists every promoted run by position with when it was promoted, whether
 * or not the home page currently shows it. A row that fails its schema is
 * skipped (C6.5). Only reads. Throws StoreError if the database fails.
 */
export async function listPromoted(db: Db): Promise<PromotedRun[]> {
  const { rows } = await db.query(
    "SELECT run_id::text AS run_id, position, promoted_at FROM showcase_runs ORDER BY position LIMIT $1",
    [MAX_SHOWCASE_POSITION],
  );
  return rows.flatMap((row) => {
    const parsed = promotedRow.safeParse(row);
    return parsed.success ? [{ runId: parsed.data.run_id, position: parsed.data.position, promotedAt: parsed.data.promoted_at }] : [];
  });
}

// Show and guest names come from Qloo and angles from the model. Control
// characters (an escape starts a terminal command) and direction controls
// are replaced, so that text cannot drive the operator's terminal or read
// differently from what is stored.
const UNPRINTABLE = /[\p{Cc}\p{Bidi_Control}]/gu;
const printable = (text: string): string => text.replace(UNPRINTABLE, "�");
const utc = (date: Date) => `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;

function guestLines(row: BoardPreviewRow): string[] {
  const rank = `${row.rank}.`.padStart(4);
  if (row.guest === null) return [`  ${rank} (this row does not read back cleanly)`];
  const { guest } = row;
  const facts = [
    guest.fitKnown ? `fit ${guest.fit}` : "fit unknown",
    `reach ${guest.reach}`,
    `trend ${guest.rising.state}`,
    ...(guest.bringsNew === null ? [] : [`brings ${guest.bringsNew.label}`]),
  ];
  return [
    `  ${rank} ${printable(guest.name)}`,
    `       ${printable(facts.join(", "))}`,
    ...(guest.sharedTags.length === 0 ? [] : [`       shared tastes: ${printable(guest.sharedTags.join(", "))}`]),
    `       angle: ${printable(guest.angle)}`,
    `       brief: ${row.brief === null ? "not written" : "written"}`,
  ];
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

// Model text may hold line breaks, so each line is sanitised on its own and
// indented under its label instead of being joined into one.
const textLines = (text: string, indent: string): string[] => text.split("\n").map((line) => `${indent}${printable(line)}`);

function briefLines(brief: StoredBrief): string[] {
  const field = "        ";
  return [
    `${field}Why: ${printable(brief.why)}`,
    `${field}Angle: ${printable(brief.angle)}`,
    `${field}Questions:`,
    ...brief.questions.map((question, index) => `${field}  ${index + 1}. ${printable(question)}`),
    `${field}Pitch subject: ${printable(brief.pitch_subject)}`,
    `${field}Pitch body:`,
    ...textLines(brief.pitch_body, `${field}  `),
    `${field}Removed from the draft: ${plural(brief.removed.links, "link", "links")} and ${plural(brief.removed.emails, "email address", "email addresses")}.`,
  ];
}

// The codes come from getBriefClaim, which reads back only upper-case codes.
function missingReason(state: Exclude<BriefState, { kind: "written" }>): string {
  switch (state.kind) {
    case "none":
      return "no brief yet.";
    case "retry":
      return `failed once with ${state.code ?? "no code"}, so it has one attempt left.`;
    case "failed":
      return `failed on both attempts, last with ${state.code ?? "no code"}, so this run can never get its brief.`;
    case "pending":
      return "a writer holds its claim. If nothing is writing it, a restart of the agent server frees it.";
    case "unreadable":
      return "its board row, claim or brief does not read back cleanly, so no brief can be written for it.";
  }
}

/**
 * Renders a run's briefs as plain lines for the operator to read before
 * promoting it (C6.3), with any control or direction character in stored
 * text replaced. A header counts the written briefs. With `full`, every board
 * guest follows in rank order: a written brief in full, each field under its
 * label, and an unwritten one with why it is missing. Without it only the
 * unwritten guests follow. A run that is not done gets one line saying so.
 */
export function formatBriefs(briefs: RunBriefs, opts: { full: boolean }): string[] {
  if (briefs.status !== "done") return [`Run ${briefs.runId} is ${briefs.status}, and only a done run's board gets briefs.`];
  const written = briefs.guests.filter((guest) => guest.state.kind === "written").length;
  const show = briefs.showName === null ? "an unknown show" : printable(briefs.showName);
  const lines = [`Briefs for run ${briefs.runId}, ${show}: ${written} of ${plural(briefs.guests.length, "guest has", "guests have")} a written brief.`];
  for (const guest of briefs.guests) {
    const head = `   ${`${guest.rank}.`.padStart(4)} ${guest.name === null ? "(this row does not read back cleanly)" : printable(guest.name)}`;
    if (guest.state.kind === "written") {
      if (opts.full) lines.push(head, ...briefLines(guest.state.brief));
    } else {
      lines.push(`${head}: ${missingReason(guest.state)}`);
    }
  }
  return lines;
}

/** Renders a run preview as short plain lines for the terminal, with any control character in stored text replaced. */
export function formatPreview(preview: RunPreview): string[] {
  const count = preview.board.length;
  const lines = [
    `Run ${preview.runId}`,
    `  Status: ${preview.status}`,
    `  Show: ${preview.showName === null ? "unknown" : printable(preview.showName)}`,
    count === 0 ? "  Board: none" : `  Board, ${count} ${count === 1 ? "guest" : "guests"} from rank 1 down:`,
    ...preview.board.flatMap(guestLines),
  ];
  lines.push(
    preview.refusal === null
      ? `  The home page would show the first ${SHOWCASE_GUESTS}.`
      : `  This run cannot go on the home page. ${MESSAGES[preview.refusal]}`,
  );
  return lines;
}

/**
 * Renders the promoted runs as short plain lines for the terminal, marking
 * any the home page does not show (from `shown`, the listShowcase result).
 */
export function formatPromoted(promoted: PromotedRun[], shown: ShowcaseRun[]): string[] {
  if (promoted.length === 0) return ["Nothing is promoted, so the home page shows no example runs."];
  const visible = new Map(shown.map((run) => [run.runId, run]));
  const lines = [`Promoted runs, ${promoted.length} of ${MAX_SHOWCASE_POSITION} positions used:`];
  for (const run of promoted) {
    const view = visible.get(run.runId);
    const place = `${run.position}.`.padStart(4);
    if (view === undefined || view.position !== run.position) {
      lines.push(`  ${place} ${run.runId}  not shown: the run is not done or its top guests do not read back cleanly`);
      continue;
    }
    lines.push(`  ${place} ${run.runId}  ${printable(view.showName)}, promoted ${utc(run.promotedAt)}`);
    lines.push(`       ${printable(view.guests.map((guest) => guest.name).join(", "))}`);
  }
  return lines;
}
