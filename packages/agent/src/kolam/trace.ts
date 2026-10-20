import { ServerError } from "../server/errors.js";

/** A dot cell: column i and row j of the dot grid. */
export type Cell = readonly [i: number, j: number];
/** What the line does at a gate: go straight on into the neighbour's cell, or turn back around its own dot. */
export type GateState = "cross" | "bounce";
/** The edge midpoint between two dot cells that share an edge. */
export type Gate = { a: Cell; b: Cell; node: readonly [x: number, y: number] };
export type DotGrid = { cells: readonly Cell[]; gates: Gate[] };
export type TracedLine = { nodes: Array<readonly [number, number]>; cells: Cell[] };

/** The most dots one grid may hold. */
export const MAX_DOTS = 250;

// Far past any layout this server makes, and small enough that every doubled
// coordinate packs into one exact integer key below.
const MAX_COORDINATE = 1_000_000;
const KEY_OFFSET = 4_000_000;
const KEY_STRIDE = 10_000_000;
const NEIGHBOURS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;
// Where each segment's walk starts, relative to the cell's corner (2i, 2j),
// in the order L-T, T-R, R-B, B-L, walking from the first named node.
const SEGMENT_STARTS = [
  { x: 0, y: 1, dx: 1, dy: -1 },
  { x: 1, y: 0, dx: 1, dy: 1 },
  { x: 2, y: 1, dx: -1, dy: 1 },
  { x: 1, y: 2, dx: -1, dy: -1 },
] as const;

const badInput = (): ServerError => new ServerError("SRV_BAD_INPUT");
// A walk that leaves the grid or repeats a segment means the grid or the code
// is wrong, never the caller's choice of gates, so it is not a ServerError.
const walkFailed = (): Error => new Error("kolam trace broke the one-walk-per-segment rule");

function isCoordinate(value: unknown): value is number {
  return Number.isSafeInteger(value) && Math.abs(value as number) <= MAX_COORDINATE;
}

function pointKey(x: number, y: number): number {
  return (x + KEY_OFFSET) * KEY_STRIDE + (y + KEY_OFFSET);
}

function dotKey(i: number, j: number): number {
  return pointKey(2 * i + 1, 2 * j + 1);
}

/**
 * Checks a set of dot cells and lists its gates: one per pair of cells that
 * share an edge, in cell order and, for each cell, the right neighbour before
 * the one below. Cell (i, j) holds its dot at (2i+1, 2j+1); a gate's node is
 * the midpoint of the shared edge. Each cell must be a pair of whole numbers
 * no larger than 1,000,000 either way. Throws ServerError("SRV_BAD_INPUT")
 * for an empty set, a repeated or malformed cell, more than 250 cells, cells
 * that are not one edge-connected piece, or a pinch (two cells touching only
 * at a corner, with neither other cell of that 2 by 2 square present).
 */
export function createDotGrid(cells: readonly Cell[]): DotGrid {
  if (!Array.isArray(cells) || cells.length === 0 || cells.length > MAX_DOTS) throw badInput();
  const index = new Map<number, number>();
  const own: Cell[] = [];
  for (const cell of cells as readonly unknown[]) {
    if (!Array.isArray(cell) || cell.length !== 2) throw badInput();
    const [i, j] = cell as unknown[];
    if (!isCoordinate(i) || !isCoordinate(j)) throw badInput();
    const key = dotKey(i, j);
    if (index.has(key)) throw badInput();
    index.set(key, own.length);
    own.push([i, j]);
  }
  const has = (i: number, j: number): boolean => index.has(dotKey(i, j));

  const reached = new Set<number>([0]);
  const queue = [0];
  for (let head = 0; head < queue.length; head += 1) {
    const [i, j] = own[queue[head]!]!;
    for (const [di, dj] of NEIGHBOURS) {
      const next = index.get(dotKey(i + di, j + dj));
      if (next !== undefined && !reached.has(next)) {
        reached.add(next);
        queue.push(next);
      }
    }
  }
  if (reached.size !== own.length) throw badInput();

  for (const [i, j] of own) {
    if (has(i + 1, j + 1) && !has(i + 1, j) && !has(i, j + 1)) throw badInput();
    if (has(i + 1, j - 1) && !has(i + 1, j) && !has(i, j - 1)) throw badInput();
  }

  const gates: Gate[] = [];
  for (const cell of own) {
    const [i, j] = cell;
    const right = index.get(dotKey(i + 1, j));
    if (right !== undefined) gates.push({ a: cell, b: own[right]!, node: [2 * i + 2, 2 * j + 1] });
    const down = index.get(dotKey(i, j + 1));
    if (down !== undefined) gates.push({ a: cell, b: own[down]!, node: [2 * i + 1, 2 * j + 2] });
  }
  return { cells: own, gates };
}

/**
 * Traces every closed line of the mirror curve on `grid`, which must come
 * from createDotGrid. `crossing` holds the gates the line goes straight
 * through, keyed "x,y" by node; every other gate, and every border node,
 * bounces. Lines start from the first unwalked segment, taking cells in grid
 * order and each cell's segments as L-T, T-R, R-B, B-L, so the result is the
 * same on every run. In each line, nodes are in walking order and cells[k]
 * is the cell of the segment from nodes[k] to nodes[k+1], wrapping at the
 * end. Throws ServerError("SRV_BAD_INPUT") for a key that is not one of the
 * grid's gates, and a plain Error if any segment would be walked twice or
 * the walk leaves the grid.
 */
export function traceLines(grid: DotGrid, crossing: ReadonlySet<string>): TracedLine[] {
  const { cells, gates } = grid;
  const index = new Map<number, number>();
  cells.forEach(([i, j], k) => index.set(dotKey(i, j), k));
  const gateKeys = new Map<string, number>();
  for (const { node } of gates) gateKeys.set(`${node[0]},${node[1]}`, pointKey(node[0], node[1]));
  const crossed = new Set<number>();
  for (const key of crossing) {
    const point = gateKeys.get(key);
    if (point === undefined) throw badInput();
    crossed.add(point);
  }

  const used = new Uint8Array(cells.length * 4);
  const lines: TracedLine[] = [];
  let walked = 0;
  for (let c = 0; c < cells.length; c += 1) {
    for (let s = 0; s < SEGMENT_STARTS.length; s += 1) {
      if (used[c * 4 + s] === 1) continue;
      const [i, j] = cells[c]!;
      const start = SEGMENT_STARTS[s]!;
      const startX = 2 * i + start.x;
      const startY = 2 * j + start.y;
      let x = startX;
      let y = startY;
      let dx: number = start.dx;
      let dy: number = start.dy;
      const nodes: Array<readonly [number, number]> = [];
      const lineCells: Cell[] = [];
      do {
        const lowX = Math.min(x, x + dx);
        const lowY = Math.min(y, y + dy);
        const ci = Math.floor(lowX / 2);
        const cj = Math.floor(lowY / 2);
        const owner = index.get(dotKey(ci, cj));
        if (owner === undefined) throw walkFailed();
        const across = lowX - 2 * ci;
        const segment = owner * 4 + (lowY - 2 * cj === 0 ? across : 3 - across);
        if (used[segment] === 1) throw walkFailed();
        used[segment] = 1;
        walked += 1;
        nodes.push([x, y]);
        lineCells.push(cells[owner]!);
        x += dx;
        y += dy;
        const state: GateState = crossed.has(pointKey(x, y)) ? "cross" : "bounce";
        // A node on a vertical cell edge has an even x, so a bounce there
        // turns the horizontal part of the direction back.
        if (state === "bounce") {
          if (x % 2 === 0) dx = -dx;
          else dy = -dy;
        }
      } while (x !== startX || y !== startY || dx !== start.dx || dy !== start.dy);
      lines.push({ nodes, cells: lineCells });
    }
  }
  if (walked !== cells.length * 4) throw walkFailed();
  return lines;
}

/**
 * Picks the gates to cross so the curve on `grid` has exactly `trees` lines:
 * random Kruskal with union-find over the grid's gates, stopping when
 * `trees` trees remain. Each tree's line goes around exactly that tree's
 * dots. `random` must return numbers from 0 up to but not including 1.
 * Returns gate keys "x,y". Throws ServerError("SRV_BAD_INPUT") unless
 * `trees` is a whole number from 1 to the cell count, or when `random`
 * returns anything outside its range.
 */
export function spanningForest(grid: DotGrid, trees: number, random: () => number): Set<string> {
  const count = grid.cells.length;
  if (!Number.isSafeInteger(trees) || trees < 1 || trees > count) throw badInput();
  const order = [...grid.gates];
  for (let k = order.length - 1; k > 0; k -= 1) {
    const value = random();
    if (!(value >= 0 && value < 1)) throw badInput();
    const pick = Math.floor(value * (k + 1));
    const held = order[k]!;
    order[k] = order[pick]!;
    order[pick] = held;
  }

  const index = new Map<number, number>();
  grid.cells.forEach(([i, j], k) => index.set(dotKey(i, j), k));
  const parent = Array.from({ length: count }, (_, k) => k);
  const size = new Array<number>(count).fill(1);
  const find = (start: number): number => {
    let at = start;
    while (parent[at] !== at) {
      parent[at] = parent[parent[at]!]!;
      at = parent[at]!;
    }
    return at;
  };

  const crossing = new Set<string>();
  let components = count;
  for (const gate of order) {
    if (components === trees) break;
    const a = index.get(dotKey(gate.a[0], gate.a[1]));
    const b = index.get(dotKey(gate.b[0], gate.b[1]));
    if (a === undefined || b === undefined) throw walkFailed();
    let rootA = find(a);
    let rootB = find(b);
    if (rootA === rootB) continue;
    if (size[rootA]! < size[rootB]!) [rootA, rootB] = [rootB, rootA];
    parent[rootB] = rootA;
    size[rootA] = size[rootA]! + size[rootB]!;
    components -= 1;
    crossing.add(`${gate.node[0]},${gate.node[1]}`);
  }
  if (components !== trees) throw walkFailed();
  return crossing;
}
