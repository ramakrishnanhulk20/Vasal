"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import type { MotionValue } from "motion/react";
import { useLabState } from "@/lib/labStore";
import { KolamGlow } from "@/components/KolamGlow";
import {
  DOT_RADIUS,
  SHRINK,
  buildDrawing,
  kolamLabel,
  ringStrokeClass,
  showSuffix,
} from "@/lib/kolamDrawing";
import type { DrawnStretch } from "@/lib/kolamDrawing";
import { DRAW_SCALE } from "@/lib/pathLength";
import type { Run } from "@/lib/run";

const DRAW_EASE: [number, number, number, number] = [0.65, 0, 0.35, 1];
const RING_DURATION = 1.1;
const RING_START = 0.6;
const RING_STEP = 0.55;
const LINE_DURATION = 6;
const DOT_START = 0.2;
const DOT_STEP = 0.025;
const HOVER_HIT_WIDTH = 0.4;
const LABEL_OFFSET = 16;

const noSubscription = () => () => {};

function Stretch({ stretch, progress }: { stretch: DrawnStretch; progress: MotionValue<number> }) {
  const drawn = useTransform(progress, [stretch.from, stretch.to], [0, 1], { clamp: true });
  const opacity = useTransform(progress, (value) => (value > stretch.from ? 1 : 0));
  return (
    <motion.path
      d={stretch.d}
      data-kolam-draw=""
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={stretch.width}
      className="stroke-rice"
      style={{ pathLength: drawn, opacity }}
    />
  );
}

function Line({ stretches, reduce }: { stretches: DrawnStretch[]; reduce: boolean }) {
  const progress = useMotionValue(0);
  useEffect(() => {
    const controls = animate(progress, 1, {
      duration: reduce ? 0 : LINE_DURATION,
      delay: reduce ? 0 : RING_START,
      ease: DRAW_EASE,
    });
    return () => controls.stop();
  }, [progress, reduce]);

  return (
    <>
      {stretches.map((stretch) => (
        <Stretch key={stretch.key} stretch={stretch} progress={progress} />
      ))}
    </>
  );
}

export function Kolam({ run }: { run: Run }) {
  const { mode, replay } = useLabState();
  const reduce = useReducedMotion() ?? false;
  const { rings, stretches } = useMemo(() => buildDrawing(run), [run]);
  // The wider invisible hover shapes exist only once the page is live, so the
  // server HTML holds exactly one path for each ring.
  const live = useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
  const [hovered, setHovered] = useState<number | null>(null);
  const [seenMode, setSeenMode] = useState(mode);
  if (seenMode !== mode) {
    setSeenMode(mode);
    setHovered(null);
  }
  const wrapRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const pointer = useRef({ x: 0, y: 0 });

  const { kolam } = run;
  const viewBox = kolam.viewBox.join(" ");
  const show = showSuffix(run);
  // A guest with no taste shared with the show's listeners has no loop, so the
  // loops can be fewer than the board's guests.
  const loops =
    kolam.rings.length === run.board.length
      ? `one loop for each of ${kolam.rings.length} guests`
      : `one loop for each guest with shared tastes: ${kolam.rings.length} of the board's ${run.board.length}`;
  const active = mode === "rings" && hovered !== null ? (rings[hovered] ?? null) : null;

  // The label flips to the left of the pointer near the right edge so it never widens the page.
  const place = useCallback(() => {
    const wrap = wrapRef.current;
    const label = labelRef.current;
    if (!wrap || !label) return;
    const box = wrap.getBoundingClientRect();
    const { x, y } = pointer.current;
    const flip = x + LABEL_OFFSET + label.offsetWidth > window.innerWidth - 8;
    const left = flip ? x - LABEL_OFFSET - label.offsetWidth : x + LABEL_OFFSET;
    label.style.transform = `translate(${left - box.left}px, ${y + LABEL_OFFSET - box.top}px)`;
  }, []);

  useLayoutEffect(() => {
    if (active) place();
  }, [active, place]);

  const track = (event: ReactPointerEvent) => {
    if (event.pointerType !== "mouse") return;
    pointer.current = { x: event.clientX, y: event.clientY };
    place();
  };

  const enter = (index: number, event: ReactPointerEvent) => {
    if (event.pointerType !== "mouse") return;
    pointer.current = { x: event.clientX, y: event.clientY };
    setHovered(index);
  };

  return (
    <figure className="m-0">
      <div ref={wrapRef} className="relative aspect-square w-full" onPointerMove={track}>
        <svg
          viewBox={viewBox}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={kolamLabel(run)}
          className="block h-full w-full"
        >
          <KolamGlow id="kolam-glow" viewBox={kolam.viewBox} />
          <g key={`${mode}-${replay}`}>
            {kolam.dots.map((dot, index) => (
              <motion.circle
                key={`${dot.guestId}-${dot.tagIndex}`}
                data-kolam-dot=""
                cx={dot.x}
                cy={dot.y}
                r={DOT_RADIUS}
                className="fill-rice"
                initial={{ opacity: 0 }}
                animate={{ opacity: 0.7 }}
                transition={{
                  duration: reduce ? 0 : 0.3,
                  delay: reduce ? 0 : DOT_START + DOT_STEP * index,
                  ease: "easeOut",
                }}
              />
            ))}
            <g filter="url(#kolam-glow)">
              <g transform={SHRINK}>
                {mode === "rings" ? (
                  rings.map((ring, index) => {
                    const delay = reduce ? 0 : RING_START + RING_STEP * index;
                    return (
                      <motion.path
                        key={ring.guestId}
                        d={ring.d}
                        data-kolam-draw=""
                        fill="none"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={ring.width}
                        className={`${ringStrokeClass(ring)} transition-[stroke-opacity] duration-200`}
                        style={{ strokeOpacity: hovered === null || hovered === index ? 1 : 0.35 }}
                        initial={{ pathLength: 0, opacity: 0 }}
                        animate={{ pathLength: 1, opacity: 1 }}
                        transition={{
                          pathLength: {
                            duration: reduce ? 0 : RING_DURATION,
                            delay,
                            ease: DRAW_EASE,
                          },
                          opacity: { duration: 0, delay },
                        }}
                      />
                    );
                  })
                ) : (
                  <Line stretches={stretches} reduce={reduce} />
                )}
              </g>
            </g>
          </g>
          {live && mode === "rings" && (
            <g transform={SHRINK}>
              {rings.map((ring, index) => (
                <path
                  key={ring.guestId}
                  d={ring.d}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={HOVER_HIT_WIDTH * DRAW_SCALE}
                  pointerEvents="stroke"
                  onPointerEnter={(event) => enter(index, event)}
                  onPointerLeave={() => setHovered(null)}
                />
              ))}
            </g>
          )}
        </svg>
        <div
          ref={labelRef}
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-0 z-10 w-max rounded-lg border border-rule bg-night-2 px-3 py-[10px]"
          style={{ visibility: active ? "visible" : "hidden" }}
        >
          {active && (
            <>
              <p className="font-display text-[18px] leading-tight text-rice">{active.name}</p>
              <p className="font-mono text-xs text-rice-dim">{Math.round(active.fit * 100)}% fit</p>
            </>
          )}
        </div>
      </div>
      <figcaption className="pointer-events-auto mt-4 max-w-[46ch] px-[2vw] font-mono text-xs text-rice-dim md:absolute md:max-w-[60ch] md:right-0 md:top-full md:mt-3 md:px-0 md:text-right">
        {`Drawn from a real Vasal run${show}: ${loops}, one dot for each of ${kolam.dots.length} tastes their fans share with the show's listeners.`}
      </figcaption>
    </figure>
  );
}
