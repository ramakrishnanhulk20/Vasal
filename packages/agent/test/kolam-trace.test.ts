// Covers src/kolam/trace.ts: the dot grid checks, the mirror-curve walk and
// the spanning forest, against line counts published for kolam grids
// (Yanagisawa and Nagata 2007, Ishimoto 2007) and the weave rules for
// rectangles and diamonds. It does not cover the spiral layout
// (kolam-layout.test.ts), the drawing built from these lines (kolam.test.ts),
// or how a browser renders any of it.
import { describe, expect, it } from "vitest";
import { ServerError } from "../src/server/errors.js";
import {
  createDotGrid,
  spanningForest,
  traceLines,
  type Cell,
  type DotGrid,
  type GateState,
  type TracedLine,
} from "../src/kolam/trace.js";

function codeOf(work: () => unknown): string | undefined {
  try {
    work();
  } catch (error) {
    return error instanceof ServerError ? error.code : "NOT_A_SERVER_ERROR";
  }
  return undefined;
}

function rectangle(m: number, n: number): Cell[] {
  const cells: Cell[] = [];
  for (let j = 0; j < n; j += 1) for (let i = 0; i < m; i += 1) cells.push([i, j]);
  return cells;
}

function diamond(r: number): Cell[] {
  const cells: Cell[] = [];
  for (let j = -r; j <= r; j += 1) for (let i = -r; i <= r; i += 1) if (Math.abs(i) + Math.abs(j) <= r) cells.push([i, j]);
  return cells;
}

const keyOf = (node: readonly [number, number]): string => `${node[0]},${node[1]}`;
const allGates = (grid: DotGrid): Set<string> => new Set(grid.gates.map((gate) => keyOf(gate.node)));

function crossingFor(grid: DotGrid, mask: number): Set<string> {
  const states: GateState[] = grid.gates.map((_, bit) => (((mask >>> bit) & 1) === 1 ? "cross" : "bounce"));
  return new Set(grid.gates.filter((_, bit) => states[bit] === "cross").map((gate) => keyOf(gate.node)));
}

function histogram(grid: DotGrid): Record<number, number> {
  const counts: Record<number, number> = {};
  const segments = grid.cells.length * 4;
  for (let mask = 0; mask < 2 ** grid.gates.length; mask += 1) {
    const lines = traceLines(grid, crossingFor(grid, mask));
    expect(lines.reduce((sum, line) => sum + line.nodes.length, 0)).toBe(segments);
    counts[lines.length] = (counts[lines.length] ?? 0) + 1;
  }
  return counts;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

// A plain LCG, only so each test run shuffles the same way.
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

function treesOf(grid: DotGrid, crossing: ReadonlySet<string>): Map<string, number> {
  const parent = new Map(grid.cells.map((cell) => [keyOf(cell), keyOf(cell)]));
  const find = (key: string): string => {
    let at = key;
    while (parent.get(at) !== at) at = parent.get(at)!;
    return at;
  };
  for (const gate of grid.gates) if (crossing.has(keyOf(gate.node))) parent.set(find(keyOf(gate.a)), find(keyOf(gate.b)));
  const roots = new Map<string, number>();
  const tree = new Map<string, number>();
  for (const cell of grid.cells) {
    const root = find(keyOf(cell));
    if (!roots.has(root)) roots.set(root, roots.size);
    tree.set(keyOf(cell), roots.get(root)!);
  }
  return tree;
}

function expectOneLinePerTree(grid: DotGrid, lines: TracedLine[], crossing: ReadonlySet<string>, k: number): void {
  const tree = treesOf(grid, crossing);
  expect(new Set(tree.values()).size).toBe(k);
  expect(lines).toHaveLength(k);
  const owners = lines.map((line) => new Set(line.cells.map((cell) => tree.get(keyOf(cell)))));
  for (const owner of owners) expect(owner.size).toBe(1);
  expect(new Set(owners.map((owner) => [...owner][0])).size).toBe(k);
}

describe("createDotGrid", () => {
  it("lists gates in cell order, right before down, with the shared edge midpoint as the node", () => {
    const grid = createDotGrid([
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]);
    expect(grid.gates).toEqual([
      { a: [0, 0], b: [1, 0], node: [2, 1] },
      { a: [0, 0], b: [0, 1], node: [1, 2] },
      { a: [1, 0], b: [1, 1], node: [3, 2] },
      { a: [0, 1], b: [1, 1], node: [2, 3] },
    ]);
    expect(createDotGrid(rectangle(15, 15)).gates).toHaveLength(420);
    expect(createDotGrid(diamond(2)).gates).toHaveLength(16);
  });

  it("refuses an empty set, repeats, bad cells, more than 250 cells, a split set and a pinch", () => {
    const refused: unknown[] = [
      [],
      [
        [0, 0],
        [0, 0],
      ],
      [[0.5, 0]],
      [[0, Number.NaN]],
      [[1_000_001, 0]],
      [[0, 0, 0]],
      ["0,0"],
      "cells",
      Array.from({ length: 251 }, (_, i) => [i, 0]),
      [
        [0, 0],
        [2, 0],
      ],
      // Connected the long way round, so only the pinch can refuse them.
      [
        [0, 0],
        [0, -1],
        [1, -1],
        [2, -1],
        [2, 0],
        [2, 1],
        [1, 1],
      ],
      [
        [0, 1],
        [0, 2],
        [1, 2],
        [2, 2],
        [2, 1],
        [2, 0],
        [1, 0],
      ],
    ];
    for (const cells of refused) expect(codeOf(() => createDotGrid(cells as Cell[])), JSON.stringify(cells)).toBe("SRV_BAD_INPUT");
    expect(createDotGrid(Array.from({ length: 250 }, (_, i) => [i, 0] as const)).cells).toHaveLength(250);
    expect(
      createDotGrid([
        [0, 0],
        [1, 0],
        [1, 1],
      ]).gates,
    ).toHaveLength(2);
  });
});

describe("traceLines", () => {
  it("walks one cell as L, T, R, B and keeps starts in cell order, then L-T, T-R, R-B, B-L", () => {
    expect(traceLines(createDotGrid([[0, 0]]), new Set())).toEqual([
      { nodes: [[0, 1], [1, 0], [2, 1], [1, 2]], cells: [[0, 0], [0, 0], [0, 0], [0, 0]] },
    ]);
    const pair = createDotGrid([
      [5, -3],
      [6, -3],
    ]);
    expect(traceLines(pair, new Set()).map((line) => line.nodes[0])).toEqual([
      [10, -5],
      [12, -5],
    ]);
    const joined = traceLines(pair, new Set(["12,-5"]));
    expect(joined).toHaveLength(1);
    expect(joined[0]!.nodes).toEqual([
      [10, -5],
      [11, -6],
      [12, -5],
      [13, -4],
      [14, -5],
      [13, -6],
      [12, -5],
      [11, -4],
    ]);
    expect(joined[0]!.cells.map((cell) => cell[0])).toEqual([5, 5, 6, 6, 6, 6, 5, 5]);
  });

  it("gives 1:240 2:776 3:1128 4:1008 5:609 6:252 7:70 8:12 9:1 over all 4,096 gate states of the 3 by 3 square", () => {
    expect(histogram(createDotGrid(rectangle(3, 3)))).toEqual({ 1: 240, 2: 776, 3: 1128, 4: 1008, 5: 609, 6: 252, 7: 70, 8: 12, 9: 1 });
  });

  it("gives the published 240 one-line patterns, and the full histogram, over all 65,536 states of the 13-dot diamond", () => {
    expect(histogram(createDotGrid(diamond(2)))).toEqual({
      1: 240,
      2: 1736,
      3: 5672,
      4: 11136,
      5: 14753,
      6: 14024,
      7: 9892,
      8: 5248,
      9: 2086,
      10: 608,
      11: 124,
      12: 16,
      13: 1,
    });
  });

  it("gives gcd(m, n) lines when every gate of an m by n rectangle crosses", () => {
    for (let m = 1; m <= 7; m += 1) {
      for (let n = 1; n <= 7; n += 1) {
        const grid = createDotGrid(rectangle(m, n));
        expect(traceLines(grid, allGates(grid)), `${m} by ${n}`).toHaveLength(gcd(m, n));
      }
    }
  });

  it("gives 2(r+1)-3 lines when every gate of the diamond |i|+|j| <= r crosses", () => {
    for (let r = 1; r <= 6; r += 1) {
      const grid = createDotGrid(diamond(r));
      expect(traceLines(grid, allGates(grid)), `r = ${r}`).toHaveLength(2 * (r + 1) - 3);
    }
  });

  it("refuses a crossing key that is not one of the grid's gates", () => {
    const grid = createDotGrid(rectangle(2, 1));
    for (const key of ["0,1", "1,0", "4,1", "2, 1", "x", ""]) {
      expect(codeOf(() => traceLines(grid, new Set([key]))), key).toBe("SRV_BAD_INPUT");
    }
  });

  it("throws a plain Error, never a ServerError, when a forged grid sends the walk off its cells", () => {
    const forged: DotGrid = { cells: [[0, 0]], gates: [{ a: [0, 0], b: [1, 0], node: [2, 1] }] };
    expect(() => traceLines(forged, new Set(["2,1"]))).toThrow(Error);
    expect(codeOf(() => traceLines(forged, new Set(["2,1"])))).toBe("NOT_A_SERVER_ERROR");
  });
});

describe("spanningForest", () => {
  const shapes: Array<[string, Cell[]]> = [
    ["15 by 15", rectangle(15, 15)],
    [
      "a 40-cell L",
      [...rectangle(4, 8), ...rectangle(4, 2).map(([i, j]): Cell => [i + 4, j + 6])],
    ],
  ];

  for (const [label, cells] of shapes) {
    it(`gives exactly k lines, each inside its own tree, for k = 1, 2, 5 and 10 over 100 seeds on ${label}`, () => {
      const grid = createDotGrid(cells);
      expect(grid.cells).toHaveLength(label === "a 40-cell L" ? 40 : 225);
      for (const k of [1, 2, 5, 10]) {
        for (let seed = 1; seed <= 100; seed += 1) {
          const crossing = spanningForest(grid, k, seeded(seed * 7_919 + k));
          expect(crossing.size).toBe(grid.cells.length - k);
          expectOneLinePerTree(grid, traceLines(grid, crossing), crossing, k);
        }
      }
    });
  }

  it("gives the same gates for the same random sequence, and one ring per dot when every cell is its own tree", () => {
    const grid = createDotGrid(rectangle(6, 6));
    expect([...spanningForest(grid, 3, seeded(42))]).toEqual([...spanningForest(grid, 3, seeded(42))]);
    expect(spanningForest(grid, 36, seeded(42)).size).toBe(0);
    expect(traceLines(grid, spanningForest(grid, 36, seeded(42)))).toHaveLength(36);
  });

  it("refuses a tree count outside 1 to the cell count and a random number outside 0 to 1", () => {
    const grid = createDotGrid(rectangle(3, 3));
    for (const trees of [0, 10, 1.5, Number.NaN, -1]) {
      expect(codeOf(() => spanningForest(grid, trees, seeded(1))), String(trees)).toBe("SRV_BAD_INPUT");
    }
    for (const value of [1, -0.1, Number.NaN]) {
      expect(codeOf(() => spanningForest(grid, 1, () => value)), String(value)).toBe("SRV_BAD_INPUT");
    }
  });
});
