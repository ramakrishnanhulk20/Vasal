import { ServerError } from "../server/errors.js";
import { MAX_DOTS, type Cell } from "./trace.js";

/** The most dots one guest gets: a board guest carries at most 5 shared tags. */
export const MAX_GUEST_DOTS = 5;

// Right, down, left, up: the spiral turns clockwise on a grid whose rows run
// downward, the same way SVG's y axis runs.
const TURNS = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
] as const;

const badInput = (): ServerError => new ServerError("SRV_BAD_INPUT");

/**
 * The first `count` cells of the square spiral from (0, 0): right 1, down 1,
 * left 2, up 2, right 3, down 3, and so on. Each cell shares an edge with the
 * one before it, so any run of consecutive cells is one connected piece.
 * Throws ServerError("SRV_BAD_INPUT") unless `count` is a whole number from 0
 * to 250.
 */
export function spiralCells(count: number): Cell[] {
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_DOTS) throw badInput();
  const cells: Cell[] = [];
  if (count === 0) return cells;
  let i = 0;
  let j = 0;
  cells.push([i, j]);
  for (let leg = 0; cells.length < count; leg += 1) {
    const [di, dj] = TURNS[leg % TURNS.length]!;
    const length = Math.floor(leg / 2) + 1;
    for (let step = 0; step < length && cells.length < count; step += 1) {
      i += di;
      j += dj;
      cells.push([i, j]);
    }
  }
  return cells;
}

/**
 * Cuts the spiral into consecutive chunks, one per entry of `counts` and in
 * that order, each holding that many cells. `start` is the chunk's first
 * place along the spiral. The last cell of each chunk shares an edge with
 * the first cell of the next. Throws ServerError("SRV_BAD_INPUT") for a count
 * that is not a whole number from 1 to 5, or counts that add up to more than
 * 250.
 */
export function chunkGuests(counts: readonly number[]): Array<{ start: number; cells: Cell[] }> {
  if (!Array.isArray(counts) || counts.length > MAX_DOTS) throw badInput();
  let total = 0;
  for (const count of counts as readonly unknown[]) {
    if (!Number.isSafeInteger(count) || (count as number) < 1 || (count as number) > MAX_GUEST_DOTS) throw badInput();
    total += count as number;
  }
  const spiral = spiralCells(total);
  let start = 0;
  return counts.map((count) => {
    const chunk = { start, cells: spiral.slice(start, start + count) };
    start += count;
    return chunk;
  });
}
