"use client";

import { motion, useReducedMotion } from "motion/react";
import { CUT_SHORT_HINT } from "@/lib/backtest";
import { axisPercent } from "@/components/proof/axis";
import { EASE, useSeenOnce } from "@/components/proof/Reveal";

type Axis = { min: number; max: number; ticks: Array<{ value: number; text: string }> };

export type ShowRow = {
  name: string;
  episodesText: string;
  cutShort: boolean;
  rho: number;
  rhoGivenFame: number;
  rhoText: string;
  fameText: string;
};

const DOT = "h-[9px] w-[9px] rounded-full";

// The dot sits at the end of a box that spans zero to its value. The box starts shifted back
// by its own width, so the dot starts on the zero line and slides out to its value.
function SlidingDot({
  value,
  axis,
  seen,
  delay,
  hollow,
}: {
  value: number;
  axis: Axis;
  seen: boolean;
  delay: number;
  hollow: boolean;
}) {
  const reduce = useReducedMotion() ?? false;
  const zero = axisPercent(0, axis);
  const at = axisPercent(value, axis);
  const positive = at >= zero;
  const start = positive ? "-100%" : "100%";

  return (
    <motion.span
      data-rise=""
      className="absolute top-[14px] h-0"
      style={{ left: `${Math.min(zero, at)}%`, width: `${Math.abs(at - zero)}%` }}
      initial={{ x: start }}
      animate={{ x: seen ? "0%" : start }}
      transition={{ duration: reduce ? 0 : 0.6, delay: reduce ? 0 : delay, ease: EASE }}
    >
      <span
        className={`absolute top-0 -translate-y-1/2 ${DOT} ${
          positive ? "right-0 translate-x-1/2" : "left-0 -translate-x-1/2"
        } ${hollow ? "border-[1.5px] border-rice" : "bg-rice"}`}
      />
    </motion.span>
  );
}

function ShowStrip({
  row,
  axis,
  seen,
  delay,
}: {
  row: ShowRow;
  axis: Axis;
  seen: boolean;
  delay: number;
}) {
  const reduce = useReducedMotion() ?? false;
  const zero = axisPercent(0, axis);
  const a = axisPercent(row.rho, axis);
  const b = axisPercent(row.rhoGivenFame, axis);

  return (
    <div aria-hidden="true" className="relative h-7">
      <span className="absolute inset-x-0 top-[14px] h-px bg-rule" />
      {axis.ticks.map((tick) => (
        <span
          key={tick.text}
          className="absolute top-[14px] h-[5px] w-px bg-rule"
          style={{ left: `${axisPercent(tick.value, axis)}%` }}
        />
      ))}
      <span
        className="absolute top-[2px] h-6 w-0 border-l border-dashed border-status"
        style={{ left: `${zero}%` }}
      />
      <motion.span
        data-rise=""
        className="absolute top-[14px] h-px bg-rice-dim"
        style={{ left: `${Math.min(a, b)}%`, width: `${Math.abs(a - b)}%` }}
        initial={{ opacity: 0 }}
        animate={{ opacity: seen ? 1 : 0 }}
        transition={{ duration: reduce ? 0 : 0.6, delay: reduce ? 0 : delay, ease: EASE }}
      />
      <SlidingDot value={row.rho} axis={axis} seen={seen} delay={delay} hollow={false} />
      <SlidingDot value={row.rhoGivenFame} axis={axis} seen={seen} delay={delay} hollow />
    </div>
  );
}

export function ShowRows({ rows, axis }: { rows: ShowRow[]; axis: Axis }) {
  const { ref, seen } = useSeenOnce<HTMLUListElement>(0.2);

  return (
    <ul ref={ref} className="divide-y divide-rule">
      {rows.map((row, index) => (
        <li key={row.name} className="grid grid-cols-12 items-center gap-y-3 py-4">
          <div className="col-span-12 md:col-span-4 md:pr-6">
            <p className="font-body text-[17px] text-rice">{row.name}</p>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[12px] text-rice-dim">
              <span>{`${row.episodesText} episodes`}</span>
              {row.cutShort && (
                <span
                  title={CUT_SHORT_HINT}
                  className="cursor-help rounded-md border border-rule px-[6px] py-[2px] text-[10px]"
                >
                  CUT SHORT
                </span>
              )}
            </p>
          </div>
          <div className="col-span-12 px-4 md:col-span-6">
            <ShowStrip row={row} axis={axis} seen={seen} delay={index * 0.06} />
          </div>
          <p className="col-span-12 font-mono text-[13px] text-rice md:col-span-2 md:text-right">
            <span>{row.rhoText}</span>
            <span className="text-rice-dim">{` / ${row.fameText}`}</span>
          </p>
        </li>
      ))}
    </ul>
  );
}
