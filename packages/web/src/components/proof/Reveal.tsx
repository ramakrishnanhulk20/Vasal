"use client";

import { useRef } from "react";
import type { ReactNode } from "react";
import { motion, useInView, useReducedMotion } from "motion/react";

export const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

// The shared Rise (fade and lift 24px, 0.7s) but triggered when the block scrolls into view.
export function Reveal({
  delay = 0,
  amount = 0.3,
  className,
  children,
}: {
  delay?: number;
  amount?: number;
  className?: string;
  children: ReactNode;
}) {
  const reduce = useReducedMotion() ?? false;
  return (
    <motion.div
      data-rise=""
      className={className}
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount }}
      transition={{ duration: reduce ? 0 : 0.7, delay: reduce ? 0 : delay, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

// True once the element has been seen, and stays true.
export function useSeenOnce<T extends HTMLElement>(amount: number) {
  const ref = useRef<T>(null);
  const seen = useInView(ref, { once: true, amount });
  return { ref, seen };
}
