"use client";

import { motion, useReducedMotion } from "motion/react";
import { EASE, useSeenOnce } from "@/components/proof/Reveal";
import type { FunnelRow } from "@/lib/backtest";

const BAR = "absolute inset-y-0 rounded-[2px]";
const percent = (share: number) => `${share * 100}%`;

function Bar({ row, seen, delay }: { row: FunnelRow; seen: boolean; delay: number }) {
  const reduce = useReducedMotion() ?? false;
  const transition = { duration: reduce ? 0 : 0.5, delay: reduce ? 0 : delay, ease: EASE };

  if (row.kind === "start") {
    return <span className={`${BAR} left-0 w-full bg-rice/30`} />;
  }
  if (row.kind === "kept") {
    return <span className={`${BAR} left-0 bg-rice/85`} style={{ width: percent(row.after) }} />;
  }
  // The bar starts as long as it was before this rule and shortens to what is left, while
  // the part the rule removed fades in where the bar used to be.
  const wide = row.before / row.after;
  return (
    <>
      <motion.span
        data-rise=""
        className={`${BAR} left-0 origin-left bg-rice/30`}
        style={{ width: percent(row.after) }}
        initial={{ scaleX: wide }}
        animate={{ scaleX: seen ? 1 : wide }}
        transition={transition}
      />
      <motion.span
        data-rise=""
        className={`${BAR} bg-status/55`}
        style={{ left: percent(row.after), width: percent(row.before - row.after) }}
        initial={{ opacity: 0 }}
        animate={{ opacity: seen ? 1 : 0 }}
        transition={transition}
      />
    </>
  );
}

export function FunnelRows({ rows }: { rows: FunnelRow[] }) {
  const { ref, seen } = useSeenOnce<HTMLOListElement>(0.3);

  return (
    <ol ref={ref} className="flex flex-col gap-4">
      {rows.map((row, index) => (
        <li
          key={row.key}
          className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 md:grid-cols-[34%_96px_1fr]"
        >
          <span className="font-body text-[15px] text-rice-dim">{row.label}</span>
          <span className="text-right font-mono text-[13px] text-rice md:w-24">{row.value}</span>
          <span className="relative col-span-2 block h-[10px] md:col-span-1">
            <Bar row={row} seen={seen} delay={index * 0.12} />
          </span>
        </li>
      ))}
    </ol>
  );
}
