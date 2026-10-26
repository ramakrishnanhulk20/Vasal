const CURVE_STEPS = 16;

// Browsers measure a path with a fixed tolerance in the path's own units. The
// generator's coordinates are only a few units wide, so the measure comes out
// short and a stroke drawn with pathLength stops before the end of a closed
// ring. Scaling the numbers up (and the drawing group down by the same factor)
// makes the measure exact.
export const DRAW_SCALE = 100;

export function scalePath(d: string): string {
  return d.replace(/-?\d+(?:\.\d+)?/g, (value) =>
    String(Math.round(Number(value) * DRAW_SCALE * 10) / 10),
  );
}

// Approximate length of a path made only of M, L, Q and Z commands, which is
// all the kolam generator writes. It only sets how the one-line draw time is
// shared between stretches, so an exact length is not needed.
export function pathLength(d: string): number {
  const tokens = d.trim().split(/\s+/);
  let i = 0;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let total = 0;

  while (i < tokens.length) {
    const command = tokens[i++];
    if (command === "M") {
      x = startX = Number(tokens[i++]);
      y = startY = Number(tokens[i++]);
    } else if (command === "L") {
      const nx = Number(tokens[i++]);
      const ny = Number(tokens[i++]);
      total += Math.hypot(nx - x, ny - y);
      x = nx;
      y = ny;
    } else if (command === "Q") {
      const cx = Number(tokens[i++]);
      const cy = Number(tokens[i++]);
      const nx = Number(tokens[i++]);
      const ny = Number(tokens[i++]);
      let px = x;
      let py = y;
      for (let step = 1; step <= CURVE_STEPS; step += 1) {
        const t = step / CURVE_STEPS;
        const u = 1 - t;
        const qx = u * u * x + 2 * u * t * cx + t * t * nx;
        const qy = u * u * y + 2 * u * t * cy + t * t * ny;
        total += Math.hypot(qx - px, qy - py);
        px = qx;
        py = qy;
      }
      x = nx;
      y = ny;
    } else if (command === "Z") {
      total += Math.hypot(startX - x, startY - y);
      x = startX;
      y = startY;
    } else {
      return Number.NaN;
    }
  }
  return total;
}
