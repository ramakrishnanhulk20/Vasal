"use client";

import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

// Keeps the old and new content in the same grid cell so they fade over each
// other. Changing `id` starts the fade.
export function Crossfade({
  id,
  duration,
  className,
  children,
}: {
  id: string;
  duration: number;
  className?: string;
  children: ReactNode;
}) {
  const reduce = useReducedMotion() ?? false;
  return (
    <div className="grid">
      <AnimatePresence initial={false}>
        <motion.div
          key={id}
          className={`[grid-area:1/1] ${className ?? ""}`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0 : duration }}
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
