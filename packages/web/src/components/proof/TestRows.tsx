"use client";

import { motion, useReducedMotion } from "motion/react";
import { axisPercent } from "@/components/proof/axis";
import { EASE, useSeenOnce } from "@/components/proof/Reveal";
import { SOFT_100 } from "@/lib/textStyles";

type Axis = { min: number; max: number; ticks: Array<{ value: number; text: string }> };

export type TestRow = {
  title: string;
  sub: string;
  rho: number;
  low: number;
  high: number;
  rhoText: string;
  rangeText: string;
  supported: boolean;
};

const CHIP = "inline-block rounded-md border px-2 py-[3px] font-mono text-[11px] tracking-[0.1em]";

function Strip({
  row,
  axis,
  delay,
  seen,
}: {
  row: TestRow;
  axis: Axis;
  delay: number;
  seen: boolean;
}) {
  const reduce = useReducedMotion() ?? false;
  const zero = axisPercent(0, axis);
  const dot = axisPercent(row.rho, axis);
  const low = axisPercent(row.low, axis);
  const high = axisPercent(row.high, axis);

  return (
    <div
      role="img"
      aria-label={`${row.title}: ${row.rhoText}, interval ${row.rangeText}`}
      className="relative h-[124px]"
    >
      <span
        className="absolute top-0 -translate-x-1/2 font-mono text-[11px] leading-none text-status"
        style={{ left: `${zero}%` }}
      >
        NO LINK
      </span>
      <span
        className="absolute top-4 h-[84px] w-0 border-l border-dashed border-status"
        style={{ left: `${zero}%` }}
      />
      <span className="absolute inset-x-0 top-[100px] h-px bg-rule" />
      {axis.ticks.map((tick) => (
        <TickMark key={tick.text} value={tick.value} text={tick.text} axis={axis} />
      ))}
      <motion.span
        data-rise=""
        className="absolute top-[63px] h-[2px] bg-rice"
        style={{ left: `${low}%`, width: `${high - low}%`, originX: (dot - low) / (high - low) }}
        initial={{ scaleX: 0 }}
        animate={{ scaleX: seen ? 1 : 0 }}
        transition={{ duration: reduce ? 0 : 0.6, delay: reduce ? 0 : delay, ease: EASE }}
      />
      <span
        className="absolute top-[59px] h-[10px] w-[10px] rounded-full bg-rice"
        style={{ left: `calc(${dot}% - 5px)` }}
      />
      <span
        className="absolute top-[30px] -translate-x-1/2 font-mono text-[14px] leading-none text-rice"
        style={{ left: `${dot}%` }}
      >
        {row.rhoText}
      </span>
      <span
        className="absolute top-[76px] -translate-x-1/2 whitespace-nowrap font-mono text-[12px] leading-none text-rice-dim"
        style={{ left: `${(low + high) / 2}%` }}
      >
        {row.rangeText}
      </span>
    </div>
  );
}

function TickMark({
  value,
  text,
  axis,
}: {
  value: number;
  text: string;
  axis: Axis;
}) {
  const left = `${axisPercent(value, axis)}%`;
  return (
    <>
      <span className="absolute top-[100px] h-[5px] w-px bg-rule" style={{ left }} />
      <span
        className="absolute top-[110px] -translate-x-1/2 font-mono text-[11px] leading-none text-rice-dim"
        style={{ left }}
      >
        {text}
      </span>
    </>
  );
}

export function TestRows({ rows, axis }: { rows: TestRow[]; axis: Axis }) {
  const { ref, seen } = useSeenOnce<HTMLDivElement>(0.5);

  return (
    <div ref={ref} className="flex flex-col gap-10">
      {rows.map((row, index) => (
        <div key={row.title} className="grid grid-cols-12 items-start gap-y-5">
          <div className="col-span-12 md:col-span-4 md:pr-8">
            <h3
              className="font-display text-[26px] font-[350] leading-[1.15] text-rice"
              style={SOFT_100}
            >
              {row.title}
            </h3>
            <p className="mt-2 font-body text-[15px] leading-[1.5] text-rice-dim">{row.sub}</p>
          </div>
          <div className="col-span-12 px-4 md:col-span-6">
            <Strip row={row} axis={axis} delay={index * 0.15} seen={seen} />
          </div>
          <div className="col-span-12 md:col-span-2 md:justify-self-end">
            {row.supported ? (
              <span className={`${CHIP} border-[rgba(242,238,230,0.45)] text-rice`}>PASSED</span>
            ) : (
              <span className={`${CHIP} border-rule text-rice-dim`}>DID NOT PASS</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
