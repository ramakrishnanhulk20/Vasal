import { KolamGlow } from "@/components/KolamGlow";
import { DOT_RADIUS, SHRINK, kolamLabel, ringStrokeClass } from "@/lib/kolamDrawing";
import type { DrawnRing } from "@/lib/kolamDrawing";
import type { Run } from "@/lib/run";

const EASE_300 =
  "transition-[opacity,stroke-width] duration-300 ease-out motion-reduce:transition-none";
const FOCUSED_WIDTH = 1.35;
const REST = { ring: 0.85, dot: 0.7 };
const DIMMED = { ring: 0.22, dot: 0.35 };

// The finished kolam from the hero, held still. `active` is the index of the
// ring to light up, or null to show the whole drawing.
export function KolamFocus({
  run,
  rings,
  active,
}: {
  run: Run;
  rings: DrawnRing[];
  active: number | null;
}) {
  const { kolam } = run;
  const focused = active === null ? undefined : rings[active];
  const label = focused
    ? `${focused.name}'s loop, ${(active ?? 0) + 1} of ${rings.length}`
    : kolamLabel(run);

  return (
    <svg
      viewBox={kolam.viewBox.join(" ")}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={label}
      className="block aspect-square w-full"
    >
      <KolamGlow id="kolam-focus-glow" viewBox={kolam.viewBox} />
      {kolam.dots.map((dot) => {
        const opacity = focused ? (dot.guestId === focused.guestId ? 1 : DIMMED.dot) : REST.dot;
        return (
          <circle
            key={`${dot.guestId}-${dot.tagIndex}`}
            cx={dot.x}
            cy={dot.y}
            r={DOT_RADIUS}
            className={`fill-rice ${EASE_300}`}
            style={{ opacity }}
          />
        );
      })}
      <g filter="url(#kolam-focus-glow)">
        <g transform={SHRINK}>
          {rings.map((ring) => {
            const isFocused = focused?.guestId === ring.guestId;
            const opacity = focused ? (isFocused ? 1 : DIMMED.ring) : REST.ring;
            return (
              <path
                key={ring.guestId}
                d={ring.d}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={`${ringStrokeClass(ring)} ${EASE_300}`}
                style={{
                  opacity,
                  strokeWidth: isFocused ? ring.width * FOCUSED_WIDTH : ring.width,
                }}
              />
            );
          })}
        </g>
      </g>
    </svg>
  );
}
