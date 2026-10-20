// Covers src/kolam/layout.ts: the square spiral and how it is cut into one
// chunk per guest. It does not cover the lines drawn around those cells
// (kolam-trace.test.ts) or the finished drawing (kolam.test.ts).
import { describe, expect, it } from "vitest";
import { chunkGuests, spiralCells } from "../src/kolam/layout.js";
import { ServerError } from "../src/server/errors.js";
import { createDotGrid, type Cell } from "../src/kolam/trace.js";

function codeOf(work: () => unknown): string | undefined {
  try {
    work();
  } catch (error) {
    return error instanceof ServerError ? error.code : "NOT_A_SERVER_ERROR";
  }
  return undefined;
}

const touches = (a: Cell, b: Cell): boolean => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) === 1;

// A plain LCG, only so each test run draws the same layouts.
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

describe("spiralCells", () => {
  it("turns right 1, down 1, left 2, up 2, right 3, down 3 from (0, 0)", () => {
    expect(spiralCells(13)).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [-1, 1],
      [-1, 0],
      [-1, -1],
      [0, -1],
      [1, -1],
      [2, -1],
      [2, 0],
      [2, 1],
      [2, 2],
    ]);
    expect(spiralCells(0)).toEqual([]);
  });

  it("steps one edge at a time, never repeats a cell, and every prefix up to 250 is a grid with no pinch", () => {
    const spiral = spiralCells(250);
    expect(new Set(spiral.map((cell) => cell.join(","))).size).toBe(250);
    for (let k = 1; k < spiral.length; k += 1) expect(touches(spiral[k - 1]!, spiral[k]!), String(k)).toBe(true);
    for (let count = 1; count <= 250; count += 1) expect(createDotGrid(spiralCells(count)).cells).toHaveLength(count);
  });

  it("refuses a count outside 0 to 250", () => {
    for (const count of [-1, 251, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(codeOf(() => spiralCells(count)), String(count)).toBe("SRV_BAD_INPUT");
    }
  });
});

describe("chunkGuests", () => {
  it("cuts consecutive spiral chunks in order, with each chunk's start along the spiral", () => {
    expect(chunkGuests([2, 1, 3])).toEqual([
      {
        start: 0,
        cells: [
          [0, 0],
          [1, 0],
        ],
      },
      { start: 2, cells: [[1, 1]] },
      {
        start: 3,
        cells: [
          [0, 1],
          [-1, 1],
          [-1, 0],
        ],
      },
    ]);
    expect(chunkGuests([])).toEqual([]);
  });

  it("over 2,000 seeded layouts of 1 to 10 guests with 1 to 5 tags, gives connected chunks that touch the next by an edge, and a whole set with no pinch", () => {
    const random = seeded(2_026);
    for (let trial = 0; trial < 2_000; trial += 1) {
      const guests = 1 + Math.floor(random() * 10);
      const counts = Array.from({ length: guests }, () => 1 + Math.floor(random() * 5));
      const chunks = chunkGuests(counts);
      expect(chunks.map((chunk) => chunk.cells.length)).toEqual(counts);
      for (const [k, chunk] of chunks.entries()) {
        expect(createDotGrid(chunk.cells).cells).toHaveLength(chunk.cells.length);
        const next = chunks[k + 1];
        if (next !== undefined) expect(touches(chunk.cells.at(-1)!, next.cells[0]!)).toBe(true);
      }
      expect(createDotGrid(chunks.flatMap((chunk) => chunk.cells)).cells).toHaveLength(counts.reduce((a, b) => a + b, 0));
    }
  });

  it("refuses a count outside 1 to 5, or more than 250 dots in all", () => {
    for (const counts of [[0], [6], [2, 2.5], [Number.NaN], [-1], ["3"], Array.from({ length: 51 }, () => 5)]) {
      expect(codeOf(() => chunkGuests(counts as number[])), JSON.stringify(counts)).toBe("SRV_BAD_INPUT");
    }
    expect(chunkGuests(Array.from({ length: 50 }, () => 5))).toHaveLength(50);
  });
});
