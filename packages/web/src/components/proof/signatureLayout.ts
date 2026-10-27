// Fixed measurements of the signature chart. The same numbers drive the canvas here and the
// CSS positions of the labels laid over it, so the two always line up.
export const LEFT = 56;
export const BOTTOM = 64;
export const UPPER_SHARE = 0.62;
export const GROUP_CENTRES = [0.1, 0.3, 0.5, 0.7, 0.9] as const;

export const MOVE_FROM = 0.2;
export const MOVE_STAGE = 0.3;
export const RING_STARTS = [0.55, 0.58, 0.61, 0.64, 0.67] as const;
export const RING_FADE = 0.03;
export const CURVE_FROM = 0.55;
export const CURVE_TO = 0.75;

const GRID_COLUMNS = 35;
const BLOCK_COLUMNS = 9;
const CURVE_STEPS = 24;

export type Domain = { min: number; max: number };

// How far down the inner area a ratio sits, as a share of the inner height.
export function ratioShare(ratio: number, domain: Domain): number {
  return (UPPER_SHARE * (domain.max - ratio)) / (domain.max - domain.min);
}

export type Layout = {
  width: number;
  height: number;
  radius: number;
  dots: number;
  gridX: Float32Array;
  gridY: Float32Array;
  blockX: Float32Array;
  blockY: Float32Array;
  group: Uint8Array;
  ringX: number[];
  ringY: number[];
  blockTop: number[];
  curveX: Float32Array;
  curveY: Float32Array;
  curveReach: Float32Array;
};

type Input = {
  width: number;
  height: number;
  phone: boolean;
  fifthEpisodes: number[];
  ratios: number[];
  domain: Domain;
};

export function buildLayout({ width, height, phone, fifthEpisodes, ratios, domain }: Input): Layout {
  const innerW = width - LEFT;
  const innerH = height - BOTTOM;
  const dots = fifthEpisodes.reduce((a, b) => a + b, 0);
  const radius = phone ? 1.5 : 2.25;

  const gridSpacing = (0.8 * innerW) / (GRID_COLUMNS - 1);
  const gridRows = Math.ceil(dots / GRID_COLUMNS);
  const gridX = new Float32Array(dots);
  const gridY = new Float32Array(dots);
  for (let i = 0; i < dots; i += 1) {
    const row = Math.floor(i / GRID_COLUMNS);
    const inRow = row === gridRows - 1 ? dots - row * GRID_COLUMNS : GRID_COLUMNS;
    gridX[i] = LEFT + innerW / 2 + ((i % GRID_COLUMNS) - (inRow - 1) / 2) * gridSpacing;
    gridY[i] = innerH / 2 + (row - (gridRows - 1) / 2) * gridSpacing;
  }

  const lowerHeight = innerH * (1 - UPPER_SHARE);
  const tallest = Math.max(...fifthEpisodes.map((n) => Math.ceil(n / BLOCK_COLUMNS)));
  const spacing = Math.min(
    gridSpacing,
    (lowerHeight - 16) / tallest,
    (0.8 * (innerW / fifthEpisodes.length)) / BLOCK_COLUMNS,
  );

  const blockX = new Float32Array(dots);
  const blockY = new Float32Array(dots);
  const group = new Uint8Array(dots);
  const centreX = GROUP_CENTRES.map((share) => LEFT + innerW * share);
  const blockTop: number[] = [];
  let next = 0;
  fifthEpisodes.forEach((episodes, g) => {
    for (let k = 0; k < episodes; k += 1) {
      group[next] = g;
      blockX[next] = centreX[g] + ((k % BLOCK_COLUMNS) - (BLOCK_COLUMNS - 1) / 2) * spacing;
      blockY[next] = innerH - radius - Math.floor(k / BLOCK_COLUMNS) * spacing;
      next += 1;
    }
    blockTop.push(innerH - 2 * radius - (Math.ceil(episodes / BLOCK_COLUMNS) - 1) * spacing);
  });

  const ringX = centreX;
  const ringY = ratios.map((ratio) => innerH * ratioShare(ratio, domain));

  // A Catmull-Rom curve through the ring centres, written as cubic pieces and sampled.
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < ringX.length - 1; i += 1) {
    const a = Math.max(i - 1, 0);
    const d = Math.min(i + 2, ringX.length - 1);
    const c1x = ringX[i] + (ringX[i + 1] - ringX[a]) / 6;
    const c1y = ringY[i] + (ringY[i + 1] - ringY[a]) / 6;
    const c2x = ringX[i + 1] - (ringX[d] - ringX[i]) / 6;
    const c2y = ringY[i + 1] - (ringY[d] - ringY[i]) / 6;
    for (let s = i === 0 ? 0 : 1; s <= CURVE_STEPS; s += 1) {
      const t = s / CURVE_STEPS;
      const u = 1 - t;
      xs.push(
        u * u * u * ringX[i] + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * ringX[i + 1],
      );
      ys.push(
        u * u * u * ringY[i] + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ringY[i + 1],
      );
    }
  }
  const curveReach = new Float32Array(xs.length);
  for (let i = 1; i < xs.length; i += 1) {
    curveReach[i] = curveReach[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
  }

  return {
    width,
    height,
    radius,
    dots,
    gridX,
    gridY,
    blockX,
    blockY,
    group,
    ringX,
    ringY,
    blockTop,
    curveX: Float32Array.from(xs),
    curveY: Float32Array.from(ys),
    curveReach,
  };
}
