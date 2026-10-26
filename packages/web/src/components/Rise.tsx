"use client";

import type { ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

type RiseProps = { delay: number; className?: string; children: ReactNode };

function useRise(delay: number) {
  const reduce = useReducedMotion();
  return {
    initial: { opacity: 0, y: 24 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: reduce ? 0 : 0.7, delay: reduce ? 0 : delay, ease: EASE },
  };
}

export function Rise({ delay, className, children }: RiseProps) {
  const rise = useRise(delay);
  return (
    <motion.div data-rise="" className={className} {...rise}>
      {children}
    </motion.div>
  );
}

export function RiseWord({ delay, className, children }: RiseProps) {
  const rise = useRise(delay);
  return (
    <motion.span data-rise="" className={className} {...rise}>
      {children}
    </motion.span>
  );
}
