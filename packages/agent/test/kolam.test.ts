// Covers kolamFor in src/kolam/kolam.ts: the exact path data for small
// drawings, a rebuild of the rings from SHA-256 and mulberry32, and the
// shape rules (one ring per guest, one joined line, every segment once, only
// ids and path data as text) over many seeded boards. It does not cover the
// routes that send a kolam (server-app.test.ts), how a browser draws the
// paths, or speed.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

const failure = vi.hoisted(() => ({ trace: false }));
vi.mock("../src/kolam/trace.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/kolam/trace.js")>();
  return {
    ...actual,
    traceLines: (...args: Parameters<typeof actual.traceLines>) => {
      if (failure.trace) throw new Error("forced trace failure");
      return actual.traceLines(...args);
    },
  };
});

import { kolamFor, type Kolam, type KolamGuest } from "../src/kolam/kolam.js";
import { chunkGuests } from "../src/kolam/layout.js";
import { createDotGrid, spanningForest, traceLines } from "../src/kolam/trace.js";

const RUN = "11111111-2222-4333-8444-555555555555";
const OTHER_RUN = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const board = (tags: readonly number[]): KolamGuest[] => tags.map((tagCount, k) => ({ guestId: id(k + 1), fitRank: k + 1, tagCount }));

type Point = readonly [number, number];
const keyOf = ([x, y]: Point): string => `${x},${y}`;
const mid = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

// The reference the drawing must match: Tommy Ettinger's mulberry32. Its
// first outputs below come from a separate Python port with explicit
// unsigned 32-bit wrapping.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let z = Math.imul(state ^ (state >>> 15), state | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// A plain LCG, only so each test run draws the same boards.
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

// Reads back the corner nodes of one path. A ring ends in Z and its nodes are
// the Q control points; a stretch also has its two cut nodes at the ends.
// Every midpoint written in the path is checked against its two nodes.
function nodesOf(d: string): { nodes: Point[]; closed: boolean } {
  expect(d).toMatch(/^[MLQZ0-9. -]+$/);
  const tokens = d.split(" ");
  const commands: Array<{ command: string; values: number[] }> = [];
  for (let k = 0; k < tokens.length; ) {
    const command = tokens[k]!;
    const count = command === "Q" ? 4 : command === "Z" ? 0 : 2;
    const values = tokens.slice(k + 1, k + 1 + count).map(Number);
    for (const value of values) expect(Number.isFinite(value)).toBe(true);
    commands.push({ command, values });
    k += 1 + count;
  }
  const at = (values: number[], k: number): Point => [values[k]!, values[k + 1]!];
  const closed = commands.at(-1)?.command === "Z";
  const quads = commands.filter((entry) => entry.command === "Q");
  if (closed) {
    const nodes = quads.map((entry) => at(entry.values, 0));
    expect(at(commands[0]!.values, 0)).toEqual(mid(nodes.at(-1)!, nodes[0]!));
    quads.forEach((entry, k) => expect(at(entry.values, 2)).toEqual(mid(nodes[k]!, nodes[(k + 1) % nodes.length]!)));
    return { nodes, closed };
  }
  const nodes = [at(commands[0]!.values, 0), ...quads.map((entry) => at(entry.values, 0)), at(commands.at(-1)!.values, 0)];
  expect(at(commands[1]!.values, 0)).toEqual(mid(nodes[0]!, nodes[1]!));
  quads.forEach((entry, k) => expect(at(entry.values, 2)).toEqual(mid(nodes[k + 1]!, nodes[k + 2]!)));
  return { nodes, closed };
}

function segmentsOf(d: string): string[] {
  const { nodes, closed } = nodesOf(d);
  const pairs: string[] = [];
  const last = closed ? nodes.length : nodes.length - 1;
  for (let k = 0; k < last; k += 1) {
    const a = nodes[k]!;
    const b = nodes[(k + 1) % nodes.length]!;
    expect(Math.abs(a[0] - b[0])).toBe(1);
    expect(Math.abs(a[1] - b[1])).toBe(1);
    pairs.push([keyOf(a), keyOf(b)].sort().join("|"));
  }
  return pairs;
}

// The dot whose cell holds a segment, from the segment's midpoint.
function dotOfSegment(segment: string): string {
  const [a, b] = segment.split("|").map((key) => key.split(",").map(Number) as unknown as Point);
  const [mx, my] = mid(a!, b!);
  return `${2 * Math.floor(mx / 2) + 1},${2 * Math.floor(my / 2) + 1}`;
}

function everyString(value: unknown, found: string[] = []): string[] {
  if (typeof value === "string") found.push(value);
  else if (Array.isArray(value)) for (const item of value) everyString(item, found);
  else if (typeof value === "object" && value !== null) for (const item of Object.values(value)) everyString(item, found);
  return found;
}

function everyNumber(value: unknown, found: number[] = []): number[] {
  if (typeof value === "number") found.push(value);
  else if (Array.isArray(value)) for (const item of value) everyNumber(item, found);
  else if (typeof value === "object" && value !== null) for (const item of Object.values(value)) everyNumber(item, found);
  return found;
}

function expectWellFormed(kolam: Kolam, guests: readonly KolamGuest[]): void {
  const drawnIds = guests
    .filter((guest) => guest.tagCount >= 1)
    .sort((a, b) => a.fitRank - b.fitRank || (a.guestId < b.guestId ? -1 : 1))
    .slice(0, 20)
    .map((guest) => guest.guestId);
  const tagsOf = new Map(guests.map((guest) => [guest.guestId, Math.min(guest.tagCount, 5)]));

  expect(kolam.version).toBe(1);
  expect(kolam.rings.map((ring) => ring.guestId)).toEqual(drawnIds);
  expect(new Set(kolam.joined.map((stretch) => stretch.guestId))).toEqual(new Set(drawnIds));
  expect(kolam.dots).toHaveLength(drawnIds.reduce((sum, guestId) => sum + tagsOf.get(guestId)!, 0));
  for (const guest of guests) {
    if (!drawnIds.includes(guest.guestId)) expect(JSON.stringify(kolam)).not.toContain(guest.guestId);
  }

  const ownerOfDot = new Map(kolam.dots.map((dot) => [`${dot.x},${dot.y}`, dot.guestId]));
  expect(ownerOfDot.size).toBe(kolam.dots.length);
  for (const guestId of drawnIds) {
    const indexes = kolam.dots.filter((dot) => dot.guestId === guestId).map((dot) => dot.tagIndex);
    expect(indexes).toEqual(Array.from({ length: tagsOf.get(guestId)! }, (_, k) => k));
  }
  const allSegments = new Set<string>();
  for (const dot of kolam.dots) {
    const [x, y] = [dot.x, dot.y];
    const corners: Point[] = [
      [x - 1, y],
      [x, y - 1],
      [x + 1, y],
      [x, y + 1],
    ];
    corners.forEach((corner, k) => allSegments.add([keyOf(corner), keyOf(corners[(k + 1) % 4]!)].sort().join("|")));
  }

  const ringSegments: string[] = [];
  for (const ring of kolam.rings) {
    const segments = segmentsOf(ring.d);
    expect(segments).toHaveLength(4 * tagsOf.get(ring.guestId)!);
    for (const segment of segments) expect(ownerOfDot.get(dotOfSegment(segment))).toBe(ring.guestId);
    ringSegments.push(...segments);
    expect(nodesOf(ring.d).nodes).toEqual(ring.points.map(([x, y]) => [x, y]));
    const [first, ...rest] = ring.points;
    for (const [x, y] of rest) expect(y > first![1] || (y === first![1] && x > first![0])).toBe(true);
  }
  expect(new Set(ringSegments)).toEqual(allSegments);
  expect(ringSegments).toHaveLength(allSegments.size);

  const joinedSegments = kolam.joined.flatMap((stretch) => {
    const segments = segmentsOf(stretch.d);
    for (const segment of segments) expect(ownerOfDot.get(dotOfSegment(segment))).toBe(stretch.guestId);
    return segments;
  });
  expect(joinedSegments).toHaveLength(allSegments.size);
  expect(new Set(joinedSegments)).toEqual(allSegments);
  if (drawnIds.length > 1) {
    expect(kolam.joined).toHaveLength(2 * drawnIds.length - 2);
    expect(kolam.joined[0]!.guestId).toBe(drawnIds[0]);
    kolam.joined.forEach((stretch, r) => {
      const next = kolam.joined[(r + 1) % kolam.joined.length]!;
      expect(next.guestId).not.toBe(stretch.guestId);
      expect(nodesOf(stretch.d).nodes.at(-1)).toEqual(nodesOf(next.d).nodes[0]);
    });
  } else {
    expect(kolam.joined).toHaveLength(1);
  }

  const [minX, minY, width, height] = kolam.viewBox;
  const points: Point[] = [
    ...kolam.dots.map((dot): Point => [dot.x, dot.y]),
    ...kolam.rings.flatMap((ring) => ring.points),
    ...[...kolam.rings, ...kolam.joined].flatMap((path) => nodesOf(path.d).nodes),
  ];
  for (const [x, y] of points) {
    expect(x).toBeGreaterThan(minX);
    expect(y).toBeGreaterThan(minY);
    expect(x).toBeLessThan(minX + width);
    expect(y).toBeLessThan(minY + height);
  }
  expect(Math.min(...points.map(([x]) => x))).toBe(minX + 1);
  expect(Math.max(...points.map(([, y]) => y))).toBe(minY + height - 1);
  for (const value of everyNumber(kolam)) expect(Number.isFinite(value)).toBe(true);
  for (const text of everyString(kolam)) {
    if (!drawnIds.includes(text)) expect(text).toMatch(/^M [0-9. -]+ [LQ][LQZ0-9. -]*$/);
  }
}

describe("kolamFor: exact drawings", () => {
  it("draws one guest with one tag as one ring around one dot", () => {
    expect(kolamFor(RUN, [{ guestId: id(1), fitRank: 1, tagCount: 1 }])).toEqual({
      version: 1,
      viewBox: [-1, -1, 4, 4],
      dots: [{ x: 1, y: 1, guestId: id(1), tagIndex: 0 }],
      rings: [
        {
          guestId: id(1),
          points: [
            [1, 0],
            [2, 1],
            [1, 2],
            [0, 1],
          ],
          d: "M 0.5 0.5 Q 1 0 1.5 0.5 Q 2 1 1.5 1.5 Q 1 2 0.5 1.5 Q 0 1 0.5 0.5 Z",
        },
      ],
      joined: [{ guestId: id(1), d: "M 0.5 1.5 Q 0 1 0.5 0.5 Q 1 0 1.5 0.5 Q 2 1 1.5 1.5 Q 1 2 0.5 1.5 Z" }],
    });
  });

  it("joins two guests at the gate they share and cuts the line there, strongest guest first", () => {
    const kolam = kolamFor(RUN, [
      { guestId: id(2), fitRank: 2, tagCount: 1 },
      { guestId: id(1), fitRank: 1, tagCount: 1 },
    ]);
    expect(kolam?.viewBox).toEqual([-1, -1, 6, 4]);
    expect(kolam?.rings.map((ring) => ring.d)).toEqual([
      "M 0.5 0.5 Q 1 0 1.5 0.5 Q 2 1 1.5 1.5 Q 1 2 0.5 1.5 Q 0 1 0.5 0.5 Z",
      "M 2.5 0.5 Q 3 0 3.5 0.5 Q 4 1 3.5 1.5 Q 3 2 2.5 1.5 Q 2 1 2.5 0.5 Z",
    ]);
    expect(kolam?.joined).toEqual([
      { guestId: id(1), d: "M 2 1 L 1.5 1.5 Q 1 2 0.5 1.5 Q 0 1 0.5 0.5 Q 1 0 1.5 0.5 L 2 1" },
      { guestId: id(2), d: "M 2 1 L 2.5 1.5 Q 3 2 3.5 1.5 Q 4 1 3.5 0.5 Q 3 0 2.5 0.5 L 2 1" },
    ]);
  });

  it("matches a rebuild of the rings from SHA-256 of the run id, mulberry32 and one spanning tree per spiral chunk", () => {
    const seed = createHash("sha256").update(RUN).digest().readUInt32BE(0);
    expect(seed).toBe(3_477_882_674);
    const check = mulberry32(seed);
    expect([check(), check(), check()].map((value) => value * 4_294_967_296)).toEqual([921_981_992, 1_453_074_919, 2_877_374_633]);

    const tags = [3, 5, 1, 4, 2, 5];
    const kolam = kolamFor(RUN, board(tags))!;
    const random = mulberry32(seed);
    const chunks = chunkGuests(tags);
    const trees = new Set(chunks.flatMap((chunk) => [...spanningForest(createDotGrid(chunk.cells), 1, random)]));
    const lines = traceLines(createDotGrid(chunks.flatMap((chunk) => chunk.cells)), trees);
    const expected = chunks.map((chunk) => {
      const inChunk = new Set(chunk.cells.map((cell) => cell.join(",")));
      const line = lines.find((candidate) => inChunk.has(candidate.cells[0]!.join(",")))!;
      const smallest = line.nodes.reduce((best, node, k) => {
        const held = line.nodes[best]!;
        return node[1] < held[1] || (node[1] === held[1] && node[0] < held[0]) ? k : best;
      }, 0);
      return [...line.nodes.slice(smallest), ...line.nodes.slice(0, smallest)];
    });
    expect(kolam.rings.map((ring) => ring.points)).toEqual(expected);
  });
});

describe("kolamFor: shape rules", () => {
  it("gives identical JSON for the same run id and board", () => {
    const guests = board([5, 4, 5, 3, 2, 5, 4, 3, 5, 2]);
    const first = JSON.stringify(kolamFor(RUN, guests));
    expect(JSON.stringify(kolamFor(RUN, guests.map((guest) => ({ ...guest }))))).toBe(first);
    expect(JSON.stringify(kolamFor(RUN, [...guests].reverse()))).toBe(first);
  });

  it("follows the board: a changed tag count or guest order changes rings or dots, and a changed run id alone moves nothing but the first chunk", () => {
    const tags = [5, 4, 5, 3, 2, 5, 4, 3, 5, 2];
    const guests = board(tags);
    const shapeOf = (kolam: Kolam | null) => JSON.stringify({ rings: kolam?.rings, dots: kolam?.dots });
    const base = kolamFor(RUN, guests);

    const fewerTags = guests.map((guest, k) => (k === 3 ? { ...guest, tagCount: 1 } : guest));
    const swapped = guests.map((guest, k) => (k === 1 ? { ...guest, fitRank: 3 } : k === 2 ? { ...guest, fitRank: 2 } : guest));
    expect(shapeOf(kolamFor(RUN, fewerTags))).not.toBe(shapeOf(base));
    expect(shapeOf(kolamFor(RUN, swapped))).not.toBe(shapeOf(base));

    // The first chunk holds the four centre cells, its one spare gate is the
    // seed's only choice, and a different run id may or may not pick another.
    const firstRings = new Set<string>();
    for (let k = 0; k < 50; k += 1) {
      const other = kolamFor(`run-${k}`, guests)!;
      expect(other.viewBox).toEqual(base!.viewBox);
      expect(other.dots).toEqual(base!.dots);
      expect(other.rings.slice(1)).toEqual(base!.rings.slice(1));
      const later = (kolam: Kolam) => kolam.joined.filter((stretch) => stretch.guestId !== id(1));
      expect(later(other)).toEqual(later(base!));
      firstRings.add(other.rings[0]!.d);
    }
    expect(firstRings.size).toBeGreaterThan(1);
    expect(firstRings.size).toBeLessThanOrEqual(4);

    const noSpare = board([3, 5, 5, 4]);
    const fixed = JSON.stringify(kolamFor(RUN, noSpare));
    for (const runId of [OTHER_RUN, "run-b", RUN.toUpperCase()]) expect(JSON.stringify(kolamFor(runId, noSpare))).toBe(fixed);
  });

  it("counts 10 dots and 3 rings for 3 guests, and 30 dots and 10 rings for 10, with 2 stretches per guest less 2", () => {
    const small = board([5, 3, 2]);
    const large = board([5, 5, 4, 4, 3, 3, 2, 2, 1, 1]);
    const three = kolamFor(RUN, small)!;
    const ten = kolamFor(RUN, large)!;
    expect([three.dots.length, three.rings.length, three.joined.length]).toEqual([10, 3, 4]);
    expect([ten.dots.length, ten.rings.length, ten.joined.length]).toEqual([30, 10, 18]);
    expectWellFormed(three, small);
    expectWellFormed(ten, large);
  });

  it("leaves out guests with no tags, counts more than 5 tags as 5, and draws only the first 20 by fitRank then guestId", () => {
    const guests: KolamGuest[] = [
      { guestId: id(1), fitRank: 3, tagCount: 0 },
      { guestId: id(2), fitRank: 1, tagCount: 9 },
      { guestId: id(3), fitRank: 2, tagCount: -4 },
      { guestId: id(5), fitRank: 2, tagCount: 2 },
      { guestId: id(4), fitRank: 2, tagCount: 1 },
    ];
    const kolam = kolamFor(RUN, guests)!;
    expect(kolam.rings.map((ring) => ring.guestId)).toEqual([id(2), id(4), id(5)]);
    expect(kolam.dots.filter((dot) => dot.guestId === id(2))).toHaveLength(5);
    expect(JSON.stringify(kolam)).not.toContain(id(1));
    expect(JSON.stringify(kolam)).not.toContain(id(3));
    expectWellFormed(kolam, guests);

    const many = Array.from({ length: 25 }, (_, k): KolamGuest => ({ guestId: id(k + 1), fitRank: 25 - k, tagCount: 5 }));
    const capped = kolamFor(RUN, many)!;
    expect(capped.rings.map((ring) => ring.guestId)).toEqual(Array.from({ length: 20 }, (_, k) => id(25 - k)));
    expectWellFormed(capped, many);
  });

  it("over 300 seeded boards of 1 to 25 guests, keeps every rule: one ring per guest, one line in stretches, every segment once, the viewBox, finite numbers and no text but ids", () => {
    const random = seeded(7);
    for (let trial = 0; trial < 300; trial += 1) {
      const count = 1 + Math.floor(random() * 25);
      const guests = Array.from({ length: count }, (_, k): KolamGuest => ({
        guestId: id(1 + Math.floor(random() * 1_000_000) * 100 + k),
        fitRank: 1 + Math.floor(random() * 30),
        tagCount: Math.floor(random() * 9) - 1,
      }));
      const kolam = kolamFor(`run-${trial}`, guests);
      if (guests.every((guest) => guest.tagCount < 1)) {
        expect(kolam).toBeNull();
        continue;
      }
      expect(kolam, `trial ${trial}`).not.toBeNull();
      expectWellFormed(kolam!, guests);
    }
  });

  it("stays under 40 KB of JSON for 20 guests with 5 tags each", () => {
    const kolam = kolamFor(RUN, board(Array.from({ length: 20 }, () => 5)))!;
    expect(kolam.dots).toHaveLength(100);
    expect(Buffer.byteLength(JSON.stringify(kolam))).toBeLessThan(40 * 1024);
  });
});

describe("kolamFor: refusals", () => {
  it("returns null, never throwing, for no drawable guest, a bad run id, a malformed guest or a forced internal failure", () => {
    const good = board([2, 3]);
    const cases: Array<[string, () => Kolam | null]> = [
      ["an empty list", () => kolamFor(RUN, [])],
      ["only guests with no tags", () => kolamFor(RUN, board([0, 0, -1]))],
      ["a number as run id", () => kolamFor(42 as unknown as string, good)],
      ["null as run id", () => kolamFor(null as unknown as string, good)],
      ["an object as run id", () => kolamFor({ toString: () => RUN } as unknown as string, good)],
      ["an empty run id", () => kolamFor("", good)],
      ["a 65-character run id", () => kolamFor("r".repeat(65), good)],
      ["guests that are not a list", () => kolamFor(RUN, "guests" as unknown as KolamGuest[])],
      ["a null guest", () => kolamFor(RUN, [null as unknown as KolamGuest])],
      ["an upper-case guest id", () => kolamFor(RUN, [{ guestId: OTHER_RUN.toUpperCase(), fitRank: 1, tagCount: 1 }])],
      ["text as a guest id", () => kolamFor(RUN, [{ guestId: "MARKER-k2", fitRank: 1, tagCount: 1 }])],
      ["a repeated guest id", () => kolamFor(RUN, [...good, { guestId: id(1), fitRank: 9, tagCount: 1 }])],
      ["a NaN fitRank", () => kolamFor(RUN, [{ guestId: id(1), fitRank: Number.NaN, tagCount: 1 }])],
      ["a fractional tagCount", () => kolamFor(RUN, [{ guestId: id(1), fitRank: 1, tagCount: 2.5 }])],
      ["more than 1,000 guests", () => kolamFor(RUN, board(Array.from({ length: 1_001 }, () => 0)))],
      [
        "a guest whose field throws",
        () =>
          kolamFor(RUN, [
            {
              get guestId(): string {
                throw new Error("forced read failure");
              },
              fitRank: 1,
              tagCount: 1,
            },
          ]),
      ],
    ];
    for (const [label, call] of cases) expect(call(), label).toBeNull();

    expect(kolamFor(RUN, good)).not.toBeNull();
    failure.trace = true;
    try {
      expect(kolamFor(RUN, good)).toBeNull();
    } finally {
      failure.trace = false;
    }
    expect(kolamFor(RUN, good)).not.toBeNull();
  });
});
