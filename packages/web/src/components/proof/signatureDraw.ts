import {
  CURVE_FROM,
  CURVE_TO,
  MOVE_FROM,
  MOVE_STAGE,
  RING_FADE,
  RING_STARTS,
  type Layout,
} from "@/components/proof/signatureLayout";

export type Colors = { rice: string; rule: string; accent: string };

const TAU = Math.PI * 2;
const RING_OUTER = 6;
const RING_STROKE = 1.5;
// Each dot takes 60% of stage B to move, and each group starts 10% of the stage after the last.
const MOVE_TIME = 0.6 * MOVE_STAGE;
const GROUP_DELAY = 0.1 * MOVE_STAGE;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export function drawFrame(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  colors: Colors,
  p: number,
  dpr: number,
) {
  const { dots, radius, gridX, gridY, blockX, blockY, group } = layout;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, layout.width, layout.height);

  ctx.globalAlpha = 0.45;
  ctx.fillStyle = colors.rice;
  ctx.beginPath();
  for (let i = 0; i < dots; i += 1) {
    const moved = easeInOutCubic(clamp01((p - MOVE_FROM - group[i] * GROUP_DELAY) / MOVE_TIME));
    const x = gridX[i] + (blockX[i] - gridX[i]) * moved;
    const y = gridY[i] + (blockY[i] - gridY[i]) * moved;
    ctx.moveTo(x + radius, y);
    ctx.arc(x, y, radius, 0, TAU);
  }
  ctx.fill();

  ctx.lineWidth = 1;
  ctx.strokeStyle = colors.rule;
  RING_STARTS.forEach((start, g) => {
    const shown = clamp01((p - start) / RING_FADE);
    if (shown === 0) return;
    ctx.globalAlpha = shown;
    ctx.beginPath();
    ctx.moveTo(layout.ringX[g], layout.ringY[g] + RING_OUTER);
    ctx.lineTo(layout.ringX[g], layout.blockTop[g]);
    ctx.stroke();
  });

  const drawn = clamp01((p - CURVE_FROM) / (CURVE_TO - CURVE_FROM));
  if (drawn > 0) {
    const { curveX, curveY, curveReach } = layout;
    const target = drawn * curveReach[curveReach.length - 1];
    ctx.globalAlpha = 1;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = colors.accent;
    ctx.beginPath();
    ctx.moveTo(curveX[0], curveY[0]);
    for (let i = 1; i < curveReach.length; i += 1) {
      if (curveReach[i] <= target) {
        ctx.lineTo(curveX[i], curveY[i]);
        continue;
      }
      const span = curveReach[i] - curveReach[i - 1];
      const part = span > 0 ? (target - curveReach[i - 1]) / span : 0;
      ctx.lineTo(
        curveX[i - 1] + (curveX[i] - curveX[i - 1]) * part,
        curveY[i - 1] + (curveY[i] - curveY[i - 1]) * part,
      );
      break;
    }
    ctx.stroke();
  }

  ctx.lineWidth = RING_STROKE;
  ctx.strokeStyle = colors.rice;
  RING_STARTS.forEach((start, g) => {
    const shown = clamp01((p - start) / RING_FADE);
    if (shown === 0) return;
    ctx.globalAlpha = shown;
    ctx.beginPath();
    ctx.arc(layout.ringX[g], layout.ringY[g], RING_OUTER - RING_STROKE / 2, 0, TAU);
    ctx.stroke();
  });
  ctx.globalAlpha = 1;
}
