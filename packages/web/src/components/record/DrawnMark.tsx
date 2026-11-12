"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { DOTS, LOOP } from "@/components/Mark";
import { DRAW_SCALE, scalePath } from "@/lib/pathLength";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
const DRAW_DELAY = 0.4;
const DRAW_DURATION = 2.4;
const DOT_FADE = 0.6;
const DOT_STEP = 0.15;

// The loop and the dots keep the same size on screen whatever size the Mark is
// drawn at, so each is given in pixels and turned into drawing units below.
const STROKE_PX = 2.5;
const DOT_DIAMETER_PX = 10;
const GLOW_PX = 2;

const BOX = 4 * DRAW_SCALE;

// The order the loop first passes the dots (top left, bottom left, top right,
// bottom right), listed in the same order as DOTS.
const PASS_ORDER = [0, 2, 3, 1];

const PATH = scalePath(LOOP);

export function DrawnMark({ className }: { className?: string }) {
  const reduce = useReducedMotion() ?? false;
  const svgRef = useRef<SVGSVGElement>(null);
  // Drawing units in one screen pixel. Browsers stop a pathLength draw short
  // when the stroke is set to a fixed screen width, so the width is worked out
  // from the measured size instead.
  const [unit, setUnit] = useState(BOX / 500);

  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const measure = () => {
      const width = svg.getBoundingClientRect().width;
      if (width > 0) setUnit(BOX / width);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  return (
    <svg
      ref={svgRef}
      className={className}
      viewBox={`0 0 ${BOX} ${BOX}`}
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <filter id="record-mark-glow" filterUnits="userSpaceOnUse" x={0} y={0} width={BOX} height={BOX}>
          <feDropShadow
            dx="0"
            dy="0"
            stdDeviation={GLOW_PX * unit}
            style={{ floodColor: "var(--rice)", floodOpacity: 0.35 }}
          />
        </filter>
      </defs>
      {DOTS.map(([x, y], index) => (
        <motion.circle
          key={`${x}-${y}`}
          data-kolam-dot=""
          cx={x * DRAW_SCALE}
          cy={y * DRAW_SCALE}
          r={(DOT_DIAMETER_PX / 2) * unit}
          className="fill-rice"
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.7 }}
          transition={{
            duration: reduce ? 0 : DOT_FADE,
            delay: reduce ? 0 : DRAW_DELAY + DOT_STEP * PASS_ORDER[index],
            ease: "easeOut",
          }}
        />
      ))}
      <g filter="url(#record-mark-glow)">
        <motion.path
          d={PATH}
          data-kolam-draw=""
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={STROKE_PX * unit}
          className="stroke-rice"
          initial={{ pathLength: 0, opacity: 0 }}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={{
            pathLength: {
              duration: reduce ? 0 : DRAW_DURATION,
              delay: reduce ? 0 : DRAW_DELAY,
              ease: EASE,
            },
            opacity: { duration: 0, delay: reduce ? 0 : DRAW_DELAY },
          }}
        />
      </g>
    </svg>
  );
}
