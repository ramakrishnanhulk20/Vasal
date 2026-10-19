import { z } from "zod";
import {
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
  | "PROMOTE_POSITION_TAKEN"
  | "PROMOTE_NOT_PROMOTED";

const MESSAGES: Record<PromoteErrorCode, string> = {
  PROMOTE_BAD_RUN_ID: "A run id is a lower-case UUID, written exactly as the server issued it.",
  PROMOTE_BAD_POSITION: `The position must be a whole number from 1 to ${MAX_SHOWCASE_POSITION}.`,
  PROMOTE_NOT_FOUND: "No readable run has that id.",
  PROMOTE_NOT_DONE: "Only a run that finished as done can go on the home page.",
  PROMOTE_BOARD_TOO_SMALL: `Only a run whose board has at least ${SHOWCASE_GUESTS} guests can go on the home page.`,
  PROMOTE_BOARD_UNREADABLE: `The run's top ${SHOWCASE_GUESTS} guests do not all read back cleanly as one show's board, so the home page would not show it.`,
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

export type BoardPreviewRow = { id: string; rank: number; guest: StoredBoardGuest | null };
export type RunPreview = {
  runId: string;
  status: RunStatus;
  showName: string | null;
  board: BoardPreviewRow[];
  refusal: PromoteErrorCode | null;
};
export type PromotedRun = { runId: string; position: number; promotedAt: Date };

const MAX_BOARD_ROWS = 50;
const uuid = z.uuid();
const instant = z
  .union([z.date(), z.string()])
  .transform((value) => new Date(value))
  .pipe(z.date());
const previewRow = z.object({ id: z.string().max(64), rank: z.number().int(), data: z.unknown() });
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
  return showcaseView(status, rows) === null ? "PROMOTE_BOARD_UNREADABLE" : null;
}

/**
 * Operator use, on the owner connection. Reads a run for the operator to look
 * at before promoting it: its status, its show name (from the first board
 * guest that reads back, or null), its whole board from rank 1 down with
 * null in place of any row that fails its schema (C6.5), and the refusal
 * promoteRun would give, or null when it may go on the home page. The
 * refusal uses showcaseView, the same rule the home page applies. Changes
 * nothing. Throws PromoteError("PROMOTE_BAD_RUN_ID") for an id that is not a
 * lower-case UUID, PromoteError("PROMOTE_NOT_FOUND") when no run row with
 * that id reads back, and StoreError or ServerError if the database fails.
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
  const board = rows.map((row, index): BoardPreviewRow => {
    const place = previewRow.safeParse(row);
    return place.success
      ? { id: place.data.id, rank: place.data.rank, guest: parseBoardGuest(place.data.data) }
      : { id: "", rank: index + 1, guest: null };
  });
  const showName = board.find((row) => row.guest !== null)?.guest?.showName ?? null;
  return { runId: id, status: run.status, showName, board, refusal: refusalFor(run.status, board) };
}

/**
 * Operator use only: needs the owner connection, because the app role may
 * only read showcase_runs (C6.3, C6.6). Puts a run on the home page at
 * `position` (1 to 12), in one transaction that locks the showcase against
 * other promotions while it checks and writes; the site's reads are not
 * blocked. A run already promoted moves to the new position. Before writing
 * it applies previewRun's refusal, so only a done run with at least 3 board
 * guests whose top 3 read back as one show goes up, and after writing it
 * reads the showcase back through listShowcase and undoes the change unless
 * the run shows at that position. Throws PromoteError with
 * PROMOTE_BAD_RUN_ID, PROMOTE_BAD_POSITION, PROMOTE_NOT_FOUND,
 * PROMOTE_NOT_DONE, PROMOTE_BOARD_TOO_SMALL, PROMOTE_BOARD_UNREADABLE, or
 * PROMOTE_POSITION_TAKEN when another run holds the position (it is never
 * pushed off silently), and StoreError or ServerError if the database fails.
 * Nothing changes when it throws.
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
  ];
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
