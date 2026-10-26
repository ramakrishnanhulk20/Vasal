"use client";

import { useMemo } from "react";
import { motion, useReducedMotion } from "motion/react";
import { DOT_RADIUS, SHRINK } from "@/lib/kolamDrawing";
import { DRAW_SCALE, scalePath } from "@/lib/pathLength";
import type { KolamData } from "@/lib/run";

const STROKE = 0.07;
const DRAW_EASE: [number, number, number, number] = [0.65, 0, 0.35, 1];

// A small still copy of one run's kolam. `active` brings the lines to full
// strength, and each new `drawKey` draws the loops again once.
export function KolamThumb({
  kolam,
  active,
  drawKey,
  className,
}: {
  kolam: KolamData;
  active: boolean;
  drawKey: number;
  className?: string;
}) {
  const reduce = useReducedMotion() ?? false;
  const rings = useMemo(() => kolam.rings.map((ring) => scalePath(ring.d)), [kolam]);
  const opacity = active ? 1 : 0.6;

  return (
    <svg
      viewBox={kolam.viewBox.join(" ")}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      className={className}
    >
      {kolam.dots.map((dot) => (
        <circle
          key={`${dot.guestId}-${dot.tagIndex}`}
          cx={dot.x}
          cy={dot.y}
          r={DOT_RADIUS}
          className="fill-rice transition-[fill-opacity] duration-250 ease-out"
          style={{ fillOpacity: opacity }}
        />
      ))}
      <g transform={SHRINK}>
        <g key={drawKey}>
          {rings.map((d, index) => (
            <motion.path
              key={index}
              d={d}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={STROKE * DRAW_SCALE}
              className="stroke-rice transition-[stroke-opacity] duration-250 ease-out"
              style={{ strokeOpacity: opacity }}
              initial={{ pathLength: drawKey === 0 || reduce ? 1 : 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: reduce ? 0 : 0.6, ease: DRAW_EASE }}
            />
          ))}
        </g>
      </g>
    </svg>
  );
}
