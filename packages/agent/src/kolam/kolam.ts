import { createHash } from "node:crypto";
import { chunkGuests, MAX_GUEST_DOTS } from "./layout.js";
import { createDotGrid, spanningForest, traceLines, type Cell, type TracedLine } from "./trace.js";

export type KolamGuest = { guestId: string; fitRank: number; tagCount: number };
export type KolamPoint = readonly [x: number, y: number];
export type KolamDot = { x: number; y: number; guestId: string; tagIndex: number };
export type KolamRing = { guestId: string; points: KolamPoint[]; d: string };
export type KolamStretch = { guestId: string; d: string };
export type Kolam = {
  version: 1;
  viewBox: readonly [minX: number, minY: number, width: number, height: number];
  dots: KolamDot[];
  rings: KolamRing[];
  joined: KolamStretch[];
};

type GridPoint = readonly [number, number];
type Drawn = { guestId: string; fitRank: number; tagCount: number };

const MAX_DRAWN = 20;
// A board holds at most 50 guests; this only bounds the sort for a stray caller.
const MAX_GUESTS_READ = 1_000;
// A run id is a 36-character UUID; this only bounds hashing a stray value.
const MAX_RUN_ID_LENGTH = 64;
// The only id form the board store issues. Holding guest ids to it keeps
// every string in a kolam either a server id or path data (C3.9).
const GUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const broken = (): Error => new Error("kolam construction broke one of its own rules");

// mulberry32 (Tommy Ettinger), in 32-bit integer maths so the sequence is the
// same on every platform.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let z = Math.imul(state ^ (state >>> 15), state | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function seedOf(runId: string): number {
  return createHash("sha256").update(runId, "utf8").digest().readUInt32BE(0);
}

const cellKey = ([i, j]: Cell): string => `${i},${j}`;
const nodeKey = ([x, y]: GridPoint): string => `${x},${y}`;

function byIdOrder(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

// Any guest outside its shape refuses the whole drawing rather than drawing
// a different board from the one the page lists.
function readGuests(guests: readonly unknown[]): Drawn[] | null {
  const seen = new Set<string>();
  const drawn: Drawn[] = [];
  for (const guest of guests) {
    if (typeof guest !== "object" || guest === null) return null;
    const { guestId, fitRank, tagCount } = guest as Record<string, unknown>;
    if (typeof guestId !== "string" || !GUEST_ID.test(guestId) || seen.has(guestId)) return null;
    if (typeof fitRank !== "number" || !Number.isFinite(fitRank)) return null;
    if (typeof tagCount !== "number" || !Number.isSafeInteger(tagCount)) return null;
    seen.add(guestId);
    if (tagCount >= 1) drawn.push({ guestId, fitRank, tagCount: Math.min(tagCount, MAX_GUEST_DOTS) });
  }
  drawn.sort((a, b) => (a.fitRank === b.fitRank ? byIdOrder(a.guestId, b.guestId) : a.fitRank < b.fitRank ? -1 : 1));
  return drawn.slice(0, MAX_DRAWN);
}

function num(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  if (!Number.isFinite(rounded)) throw broken();
  return String(rounded);
}

const point = ([x, y]: GridPoint): string => `${num(x)} ${num(y)}`;
const midpoint = (a: GridPoint, b: GridPoint): GridPoint => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

// Every corner is a quadratic curve whose control point is the node, joining
// the midpoints of the two segments that meet there. Through a cross node the
// three points are in line, so the curve is straight there.
function ringPath(nodes: readonly GridPoint[]): string {
  const at = (k: number): GridPoint => nodes[k % nodes.length]!;
  const parts = [`M ${point(midpoint(at(nodes.length - 1), at(0)))}`];
  for (let k = 0; k < nodes.length; k += 1) parts.push(`Q ${point(at(k))} ${point(midpoint(at(k), at(k + 1)))}`);
  parts.push("Z");
  return parts.join(" ");
}

// From cross node `start` to cross node `end` (which may wrap to 0). The
// line is straight through both ends, so cutting there loses nothing.
function stretchPath(nodes: readonly GridPoint[], start: number, end: number): string {
  const at = (k: number): GridPoint => nodes[k % nodes.length]!;
  const parts = [`M ${point(at(start))}`, `L ${point(midpoint(at(start), at(start + 1)))}`];
  for (let k = start + 1; k < end; k += 1) parts.push(`Q ${point(at(k))} ${point(midpoint(at(k), at(k + 1)))}`);
  parts.push(`L ${point(at(end))}`);
  return parts.join(" ");
}

function startAtSmallest(nodes: readonly GridPoint[]): GridPoint[] {
  let best = 0;
  for (let k = 1; k < nodes.length; k += 1) {
    const [x, y] = nodes[k]!;
    const [bx, by] = nodes[best]!;
    if (y < by || (y === by && x < bx)) best = k;
  }
  return [...nodes.slice(best), ...nodes.slice(0, best)];
}

function draw(runId: unknown, guests: unknown): Kolam | null {
  if (typeof runId !== "string" || runId.length === 0 || runId.length > MAX_RUN_ID_LENGTH) return null;
  if (!Array.isArray(guests) || guests.length > MAX_GUESTS_READ) return null;
  const drawn = readGuests(guests);
  if (drawn === null || drawn.length === 0) return null;

  const random = mulberry32(seedOf(runId));
  const chunks = chunkGuests(drawn.map((guest) => guest.tagCount));
  const grid = createDotGrid(chunks.flatMap((chunk) => chunk.cells));
  const ownerOf = new Map<string, number>();
  chunks.forEach((chunk, g) => chunk.cells.forEach((cell) => ownerOf.set(cellKey(cell), g)));
  const owner = (cell: Cell): number => {
    const g = ownerOf.get(cellKey(cell));
    if (g === undefined) throw broken();
    return g;
  };

  const trees = new Set<string>();
  for (const chunk of chunks) {
    for (const key of spanningForest(createDotGrid(chunk.cells), 1, random)) trees.add(key);
  }

  const ringLines = traceLines(grid, trees);
  if (ringLines.length !== drawn.length) throw broken();
  const ringOf: Array<TracedLine | undefined> = drawn.map(() => undefined);
  for (const line of ringLines) {
    const g = owner(line.cells[0]!);
    if (line.cells.some((cell) => owner(cell) !== g) || ringOf[g] !== undefined) throw broken();
    ringOf[g] = line;
  }
  const rings: KolamRing[] = drawn.map((guest, g) => {
    const nodes = startAtSmallest(ringOf[g]!.nodes);
    return { guestId: guest.guestId, points: nodes.map(([x, y]): KolamPoint => [x, y]), d: ringPath(nodes) };
  });

  // Consecutive chunks share an edge, so one more crossing per pair joins
  // every tree into one, and the curve into one line.
  const joins = new Set(trees);
  for (let g = 1; g < chunks.length; g += 1) {
    const last = chunks[g - 1]!.cells.at(-1)!;
    const first = chunks[g]!.cells[0]!;
    joins.add(`${last[0] + first[0] + 1},${last[1] + first[1] + 1}`);
  }
  const joinedLines = traceLines(grid, joins);
  if (joinedLines.length !== 1) throw broken();
  const line = joinedLines[0]!;
  const length = line.nodes.length;

  let joined: KolamStretch[];
  if (drawn.length === 1) {
    joined = [{ guestId: drawn[0]!.guestId, d: ringPath(line.nodes) }];
  } else {
    const owners = line.cells.map(owner);
    // The one place the walk enters the first guest from the second, so the
    // first stretch is the whole of the strongest guest.
    const begin = owners.findIndex((g, k) => g === 0 && owners[(k + length - 1) % length] !== 0);
    if (begin < 0) throw broken();
    const nodes = [...line.nodes.slice(begin), ...line.nodes.slice(0, begin)];
    const runOwners = [...owners.slice(begin), ...owners.slice(0, begin)];
    const starts = runOwners.flatMap((g, k) => (k === 0 || g !== runOwners[k - 1] ? [k] : []));
    joined = starts.map((start, r) => {
      const end = starts[r + 1] ?? length;
      if (!joins.has(nodeKey(nodes[start]!))) throw broken();
      return { guestId: drawn[runOwners[start]!]!.guestId, d: stretchPath(nodes, start, end) };
    });
  }

  const dots: KolamDot[] = chunks.flatMap((chunk, g) =>
    chunk.cells.map(([i, j], k) => ({ x: 2 * i + 1, y: 2 * j + 1, guestId: drawn[g]!.guestId, tagIndex: k })),
  );
  const xs = grid.cells.map(([i]) => i);
  const ys = grid.cells.map(([, j]) => j);
  const minX = 2 * Math.min(...xs);
  const minY = 2 * Math.min(...ys);
  const maxX = 2 * Math.max(...xs) + 2;
  const maxY = 2 * Math.max(...ys) + 2;

  return {
    version: 1,
    viewBox: [minX - 1, minY - 1, maxX - minX + 2, maxY - minY + 2],
    dots,
    rings,
    joined,
  };
}

/**
 * The kolam for one finished run: one dot per shared tag, one closed ring per
 * guest around that guest's dots, and the same drawing joined into one line
 * cut into stretches by guest. Only guests with a tagCount of 1 or more are
 * drawn (above 5 counts as 5), sorted by fitRank then guestId, at most 20.
 * The layout is a square spiral from the strongest guest outward, and each
 * guest's ring follows a spanning tree of that guest's cells. The shape comes
 * from the board. The seed, the first 4 bytes of SHA-256(runId) through
 * mulberry32, only makes the rare spare choice repeatable: a spiral chunk
 * offers one only when it holds all four centre cells, so at most the first
 * guest's ring can differ between runs with the same board. The seed never
 * carries data. Path data uses doubled grid coordinates, numbers with at most one
 * decimal place. Every string in the result is a guestId or path data (C3.9).
 * Returns null when no guest is drawn, when runId is not a string of 1 to 64
 * characters, when any guest has a guestId that is not a lower-case UUID or
 * is repeated, a fitRank that is not finite, or a tagCount that is not a
 * whole number, and on any internal failure. Never throws.
 */
export function kolamFor(runId: string, guests: readonly KolamGuest[]): Kolam | null {
  try {
    return draw(runId, guests);
  } catch {
    // The run page and the home page work without a kolam, so no failure
    // here may reach the route that asked for one.
    return null;
  }
}
