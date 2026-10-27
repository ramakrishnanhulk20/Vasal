"use client";

import { motion, useReducedMotion } from "motion/react";
import { EASE, useSeenOnce } from "@/components/proof/Reveal";

// One dot per name checked by hand, in reading order: the right ones filled, the misses hollow.
export function NameDots({ checked, correct }: { checked: number; correct: number }) {
  const reduce = useReducedMotion() ?? false;
  const { ref, seen } = useSeenOnce<HTMLDivElement>(0.5);

  return (
    <div
      ref={ref}
      role="img"
      aria-label={`${correct} of ${checked} names were right`}
      className="grid grid-cols-[repeat(10,14px)]"
    >
      {Array.from({ length: checked }, (_, index) => (
        <span key={index} className="flex h-[14px] w-[14px] items-center justify-center">
          <motion.span
            data-rise=""
            className={`block h-2 w-2 rounded-full ${
              index < correct ? "bg-rice" : "border-[1.5px] border-status"
            }`}
            initial={{ opacity: 0 }}
            animate={{ opacity: seen ? 1 : 0 }}
            transition={{ duration: reduce ? 0 : 0.4, delay: reduce ? 0 : index * 0.015, ease: EASE }}
          />
        </span>
      ))}
    </div>
  );
}
